// Goldilocks control CLI — one interactive dashboard for everything:
// admins, clients, the dev environment, the production Docker stack, the
// Cloudflare tunnel, backups and deploys.
//
// The CLI always operates on one environment, chosen at launch:
//
//   npm run cli -- --dev             open the dashboard (development)
//   npm run cli -- --prod            open the dashboard (production)
//   npm run cli -- --prod admins list        non-interactive (scripting)
//
// The environment can also come from GOLDILOCKS_ENV=dev|prod. With no
// environment given, the dashboard asks for one up front.
//
// The interactive UI is a single long-lived ink app: navigation, confirms,
// text input and streaming command output all happen inside it, so the
// terminal is never handed back and forth. Run `npm run cli -- help` for
// the full subcommand list.

import { config as loadEnv } from 'dotenv';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { decryptAtRest, encryptAtRest, isEncryptedAtRest } from '../src/crypto/at-rest.js';
import { lookupHash } from '../src/crypto/lookup-hash.js';

const ADMIN_UPGRADE_CODE_LABEL = 'admin_inboxes.upgrade_code';
const ADMIN_UPGRADE_CODE_LOOKUP_LABEL = 'admin_inboxes.upgrade_code.lookup';

/** Decrypt the stored upgrade_code if it carries the v1 envelope; pass
 *  through otherwise (rows from before encryption was enabled, or rows
 *  in dev with ENCRYPT_AT_REST_V1=false). */
function decodeUpgradeCode(stored: string): string {
  return isEncryptedAtRest(stored) ? decryptAtRest(stored, ADMIN_UPGRADE_CODE_LABEL) : stored;
}

/** Build the pair of column values to write for a new admin slot —
 *  encrypted upgrade_code (or plain if encryption is off) plus the
 *  deterministic lookup hash. */
function encodeUpgradeCode(plain: string): { stored: string; lookup: string } {
  const shouldEncrypt = process.env.ENCRYPT_AT_REST_V1 === 'true';
  const stored = shouldEncrypt ? encryptAtRest(plain, ADMIN_UPGRADE_CODE_LABEL) : plain;
  const lookup = lookupHash(plain, ADMIN_UPGRADE_CODE_LOOKUP_LABEL);
  return { stored, lookup };
}
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import pg from 'pg';

const { Client } = pg;

// --- environment -----------------------------------------------------------

type Env = 'dev' | 'prod';

// Set once at startup (or by the env picker), before any command runs.
let ENV: Env = 'dev';

function composeFile(): string {
  return ENV === 'prod' ? 'docker-compose.prod.yml' : 'docker-compose.yml';
}

// --- paths -----------------------------------------------------------------

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

// The goldilocks-ios repo (the dev XMTP node + the iOS config live there).
function iosRepoDir(): string {
  return process.env.GOLDILOCKS_IOS ?? join(REPO_ROOT, '..', 'goldilocks-ios');
}

// Per-environment config files: dev config in .env.dev, production in .env.prod.
function envFilePath(): string {
  return join(REPO_ROOT, `.env.${ENV}`);
}

function envTemplatePath(): string {
  return join(REPO_ROOT, ENV === 'prod' ? '.env.production.example' : '.env.example');
}

function envFileExists(): boolean {
  return existsSync(envFilePath());
}

function scriptPath(name: string): string {
  return join(SCRIPTS_DIR, name);
}

// --- colours (non-interactive subcommand output only) ----------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

// --- shared types ----------------------------------------------------------

interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

interface StatItem {
  label: string;
  on: boolean;
}

interface AdminRow {
  id: string;
  name: string;
  upgrade_code: string;
  inbox_id: string | null;
}

interface ClientRow {
  id: string;
  client_number: number;
  billing_seats: number;
}

// A snapshot row from `restic snapshots --json`. The fields we render
// from come straight from restic's output. See
// docs/encryption-and-backup-plan.md F1.
interface ResticSnapshot {
  id: string;        // 64-char full id
  short_id: string;  // 8-char display id
  time: string;      // ISO8601 timestamp
  tags?: string[];
  paths?: string[];
  hostname?: string;
}

interface DashboardData {
  stats: StatItem[];
  installs: number | null;
  /// Snapshot of the client base: total billable seats summed across
  /// every client, plus how many clients hold any seats at all.
  seats: { totalSeats: number; clientsWithSeats: number } | null;
  admins: number | null;
  tunnelUrl: string;
}

// --- shell helpers ---------------------------------------------------------

// Run a command, capture stdout (used for status checks + the tunnel URL).
function capture(command: string, args: string[], cwd: string = REPO_ROOT): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', () => resolve({ code: 1, out: '' }));
    child.on('close', (code) => resolve({ code: code ?? 0, out }));
  });
}

// Spawn a command and stream its output line by line. Returns the child so
// the caller can stop it. Powers the in-dashboard command runner.
function spawnStream(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  onClose: (code: number) => void,
): ChildProcess {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let closed = false;
  const finish = (code: number): void => {
    if (closed) return;
    closed = true;
    onClose(code);
  };
  const feed = (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      onLine(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  child.on('error', (err) => {
    onLine(`✗ ${err.message}`);
    finish(1);
  });
  child.on('close', (code) => {
    if (buf.trim()) onLine(buf.replace(/\r$/, ''));
    finish(code ?? 0);
  });
  return child;
}

// Run a command with the terminal attached (non-interactive subcommands only).
function runInherit(command: string, args: string[], cwd: string = REPO_ROOT): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

// docker compose args for the current environment's compose file.
//
// Dev keeps the simple `--env-file .env.dev` form. Prod wraps the docker
// invocation in scripts/with-prod-secrets.sh so the SOPS-sealed env
// (secrets/prod.env.enc) is decrypted in-memory and exported into
// compose's process env — plaintext `.env.prod` never touches disk.
function dockerComposeArgs(rest: string[]): string[] {
  if (ENV === 'prod') {
    return ['compose', '-f', composeFile(), ...rest];
  }
  return ['compose', '--env-file', `.env.${ENV}`, '-f', composeFile(), ...rest];
}

// Returns the spawn target for `docker compose ...` — handles the
// prod sops exec-env wrap.
function dockerComposeSpawn(rest: string[]): { command: string; args: string[] } {
  if (ENV === 'prod') {
    return {
      command: scriptPath('with-prod-secrets.sh'),
      args: ['docker', ...dockerComposeArgs(rest)],
    };
  }
  return { command: 'docker', args: dockerComposeArgs(rest) };
}

function composeInherit(rest: string[]): Promise<number> {
  const { command, args } = dockerComposeSpawn(rest);
  return runInherit(command, args);
}

function bashInherit(name: string, args: string[] = []): Promise<number> {
  return runInherit('bash', [scriptPath(name), ...args]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Opens a file or folder with the OS default handler (no terminal needed).
function openInOS(args: string[]): void {
  try {
    spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // best-effort
  }
}

// --- cloudflare tunnel helpers ---------------------------------------------

// Current public tunnel URL, or '' if cloudflared hasn't published one yet.
async function getTunnelUrl(): Promise<string> {
  const result = await capture('bash', [scriptPath('tunnel-url.sh')]);
  return result.code === 0 ? result.out.trim() : '';
}

// Polls until the tunnel reports a URL that differs from `previous`
// (cloudflared takes a few seconds to connect). Returns '' on timeout.
async function waitForTunnelUrl(previous: string): Promise<string> {
  for (let i = 0; i < 15; i += 1) {
    const url = await getTunnelUrl();
    if (url && url !== previous) return url;
    await sleep(2000);
  }
  return '';
}

// The iOS production build reads its backend URL from this file.
function iosConfigPath(): string {
  return join(iosRepoDir(), 'Convos', 'Config', 'config.prod.json');
}

function updateIosBackendUrl(path: string, backendUrl: string): 'updated' | 'unchanged' | 'error' {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (config.backendUrl === backendUrl) return 'unchanged';
    config.backendUrl = backendUrl;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return 'updated';
  } catch {
    return 'error';
  }
}

// Points the iOS production build at this backend by writing the tunnel URL
// into config.prod.json. Returns human-readable result lines.
function syncIosConfig(tunnelUrl: string): string[] {
  const path = iosConfigPath();
  if (!existsSync(path)) {
    return [
      `iOS repo not found (${path}).`,
      'Set GOLDILOCKS_IOS so the CLI can update its config automatically.',
    ];
  }
  const result = updateIosBackendUrl(path, `${tunnelUrl}/api`);
  if (result === 'updated') {
    return [`✓ iOS production config updated — points at ${tunnelUrl}/api. Rebuild in Xcode.`];
  }
  if (result === 'unchanged') {
    return ['iOS production config already points here — no rebuild needed.'];
  }
  return [`Could not update the iOS config at ${path}.`];
}

// Waits for the tunnel URL to settle, then points the iOS app at it.
// Appends progress to the running command panel.
async function finalizeTunnel(previous: string, append: (line: string) => void): Promise<void> {
  append('');
  append('Waiting for Cloudflare to assign the tunnel URL…');
  const url = await waitForTunnelUrl(previous);
  if (!url) {
    append('The tunnel is starting but has not reported a URL yet — check again shortly.');
    return;
  }
  append(`Tunnel URL: ${url}`);
  append('The backend auto-detects this hostname — nothing else needs updating.');
  for (const line of syncIosConfig(url)) append(line);
}

// --- security: iOS file editors -------------------------------------------
//
// The iOS pin set + pinning mode + secure-window debug flag are all kept
// in source files. Editing them by hand is brittle (and easy to forget),
// so the CLI Security menu (screen === 'security') reads + writes them
// with deterministic regex anchors. If you rename one of these symbols
// in the iOS source, update the matching anchor here too.

function iosCertificatePinnerPath(): string {
  return join(iosRepoDir(), 'ConvosCore', 'Sources', 'ConvosCore', 'Networking', 'CertificatePinner.swift');
}

function iosConvosApiClientPath(): string {
  return join(iosRepoDir(), 'ConvosCore', 'Sources', 'ConvosCore', 'API', 'ConvosAPIClient.swift');
}

function iosDevXcconfigPath(): string {
  return join(iosRepoDir(), 'Convos', 'Config', 'Dev.xcconfig');
}

/** Parse `apiSpkiHashes: Set<String> = [ "…", "…" ]` out of CertificatePinner.swift. */
function readIosPinHashes(): string[] | null {
  try {
    const text = readFileSync(iosCertificatePinnerPath(), 'utf8');
    const m = text.match(/apiSpkiHashes:\s*Set<String>\s*=\s*\[([\s\S]*?)\]/);
    if (!m || m[1] === undefined) return null;
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

function writeIosPinHashes(hashes: string[]): { ok: boolean; message: string } {
  try {
    const path = iosCertificatePinnerPath();
    const text = readFileSync(path, 'utf8');
    const re = /(apiSpkiHashes:\s*Set<String>\s*=\s*)\[[\s\S]*?\]/;
    if (!re.test(text)) return { ok: false, message: 'apiSpkiHashes anchor not found' };
    const body = hashes.length === 0
      ? '[]'
      : `[\n        ${hashes.map((h) => `"${h}"`).join(',\n        ')},\n    ]`;
    writeFileSync(path, text.replace(re, (_, prefix: string) => `${prefix}${body}`));
    return { ok: true, message: `Wrote ${hashes.length} pin(s) to ${path}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function readIosPinMode(): 'shadow' | 'enforce' | null {
  try {
    const text = readFileSync(iosConvosApiClientPath(), 'utf8');
    const m = text.match(/GoldilocksPinning\.defaultPinner\(mode:\s*\.(shadow|enforce)\)/);
    return m && (m[1] === 'shadow' || m[1] === 'enforce') ? m[1] : null;
  } catch {
    return null;
  }
}

function writeIosPinMode(mode: 'shadow' | 'enforce'): { ok: boolean; message: string } {
  try {
    const path = iosConvosApiClientPath();
    const text = readFileSync(path, 'utf8');
    const replaced = text.replace(
      /GoldilocksPinning\.defaultPinner\(mode:\s*\.(shadow|enforce)\)/,
      `GoldilocksPinning.defaultPinner(mode: .${mode})`,
    );
    if (replaced === text) return { ok: false, message: 'pin mode anchor not found' };
    writeFileSync(path, replaced);
    return { ok: true, message: `Pinning mode set to .${mode}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function readSecureWindowDebugFlag(): boolean | null {
  try {
    const text = readFileSync(iosDevXcconfigPath(), 'utf8');
    const m = text.match(/^SWIFT_ACTIVE_COMPILATION_CONDITIONS\s*=\s*(.*)$/m);
    if (!m || m[1] === undefined) return null;
    return m[1].split(/\s+/).includes('DEBUG_DISABLE_SECURE_WINDOW');
  } catch {
    return null;
  }
}

function writeSecureWindowDebugFlag(enabled: boolean): { ok: boolean; message: string } {
  try {
    const path = iosDevXcconfigPath();
    const text = readFileSync(path, 'utf8');
    const re = /^(SWIFT_ACTIVE_COMPILATION_CONDITIONS\s*=\s*)(.*)$/m;
    const m = text.match(re);
    if (!m || m[1] === undefined || m[2] === undefined) {
      return { ok: false, message: 'SWIFT_ACTIVE_COMPILATION_CONDITIONS not found in Dev.xcconfig' };
    }
    const tokens = m[2].split(/\s+/).filter(Boolean);
    const has = tokens.includes('DEBUG_DISABLE_SECURE_WINDOW');
    if (enabled === has) return { ok: true, message: 'no change' };
    const next = enabled
      ? [...tokens, 'DEBUG_DISABLE_SECURE_WINDOW']
      : tokens.filter((t) => t !== 'DEBUG_DISABLE_SECURE_WINDOW');
    writeFileSync(path, text.replace(re, `${m[1]}${next.join(' ')}`));
    return { ok: true, message: `DEBUG_DISABLE_SECURE_WINDOW ${enabled ? 'enabled' : 'disabled'}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Securely delete .env.<env>. Tries shred → srm → overwrite-then-unlink. */
function shredPlaintextEnv(): { ok: boolean; message: string } {
  const path = envFilePath();
  if (!existsSync(path)) return { ok: true, message: '.env was not present — nothing to shred.' };
  const tryRun = (cmd: string, args: string[]): boolean => {
    const r = spawnSync(cmd, args, { stdio: 'pipe' });
    return r.status === 0;
  };
  if (tryRun('shred', ['-u', '-z', path])) return { ok: true, message: `Shredded ${path} via shred.` };
  if (tryRun('srm', ['-m', path])) return { ok: true, message: `Shredded ${path} via srm.` };
  try {
    const size = readFileSync(path).length;
    writeFileSync(path, Buffer.alloc(size, 0));
    unlinkSync(path);
    return { ok: true, message: `Shredded ${path} via overwrite+unlink fallback.` };
  } catch (err) {
    return { ok: false, message: `Failed to shred ${path}: ${(err as Error).message}` };
  }
}

/** Unseal → set one env key → reseal → shred plaintext. */
function editEnvKeyAndReseal(key: string, newValue: string): { ok: boolean; message: string } {
  try {
    if (!existsSync(envFilePath()) && existsSync(sealedEnvFile())) {
      const un = unsealEnvSync();
      if (!un.ok) return un;
    }
    const text = existsSync(envFilePath()) ? readFileSync(envFilePath(), 'utf8') : '';
    const updated = setEnvValue(text, key, newValue);
    writeFileSync(envFilePath(), updated, { mode: 0o600 });
    chmodSync(envFilePath(), 0o600);
    const seal = sealEnvSync();
    if (!seal.ok) return seal;
    const shred = shredPlaintextEnv();
    return { ok: true, message: `Set ${key}=${newValue}. ${shred.message}` };
  } catch (err) {
    return { ok: false, message: `Failed to update ${key}: ${(err as Error).message}` };
  }
}

/**
 * Compute the base64-encoded SHA-256 of the SubjectPublicKeyInfo of a
 * PEM-encoded X.509 certificate. The resulting string is the literal
 * value the iOS client compares against in `apiSpkiHashes`. Uses the
 * openssl bundled in the goldilocks-backup image.
 */
function computeSpkiHashFromPem(pemPath: string): { ok: boolean; hash?: string; message: string } {
  if (!existsSync(pemPath)) return { ok: false, message: `${pemPath} not found` };
  const absDir = dirname(pemPath);
  const base = pemPath.replace(/^.*\//, '');
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${absDir}:/work:ro`,
      '-w',
      '/work',
      '--entrypoint',
      'sh',
      'goldilocks-backup:latest',
      '-c',
      `openssl x509 -in '${base}' -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64 -A`,
    ],
    { stdio: 'pipe' },
  );
  if (result.status !== 0) {
    return { ok: false, message: result.stderr?.toString().trim() || 'openssl exited non-zero' };
  }
  return { ok: true, hash: result.stdout.toString().trim(), message: 'ok' };
}

// --- database --------------------------------------------------------------

// Connection settings for the current environment. Dev uses DATABASE_URL
// from .env.dev; production connects to the Postgres container, which the prod
// compose publishes on 127.0.0.1:5432 (loopback only) for this CLI.
function dbConfig(): pg.ClientConfig {
  if (ENV === 'prod') {
    const password = process.env.POSTGRES_PASSWORD;
    if (!password) {
      throw new Error('production mode needs POSTGRES_PASSWORD in .env.prod');
    }
    return {
      host: '127.0.0.1',
      port: 5432,
      user: process.env.POSTGRES_USER ?? 'goldilocks',
      database: process.env.POSTGRES_DB ?? 'goldilocks',
      password,
    };
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('development mode needs DATABASE_URL in .env.dev');
  }
  return { connectionString };
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// --- admins ----------------------------------------------------------------

async function loadAdmins(client: pg.Client): Promise<AdminRow[]> {
  const res = await client.query<AdminRow>(
    `SELECT id, name, upgrade_code, inbox_id
       FROM admin_inboxes
       ORDER BY created_at ASC`,
  );
  // `upgrade_code` is F4-encrypted at rest. Decrypt before handing rows
  // back so the rest of the CLI (formatters, search) sees plaintext.
  return res.rows.map((row) => ({
    ...row,
    upgrade_code: decodeUpgradeCode(row.upgrade_code),
  }));
}

// Plain ANSI listing — used only by the non-interactive subcommands.
function printAdmins(admins: AdminRow[]): void {
  console.log(`${BOLD}Admin slots${RESET}`);
  if (admins.length === 0) {
    console.log(`  ${DIM}(none yet)${RESET}\n`);
    return;
  }
  admins.forEach((a, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const name = a.name.padEnd(16, ' ');
    const claimed = a.inbox_id ? `claimed ${a.inbox_id.slice(0, 12)}…` : `${DIM}unclaimed${RESET}`;
    console.log(`  [${num}] ${name} code ${formatCode(a.upgrade_code)}  ${claimed}`);
  });
  console.log('');
}

// Plain string lines for a dashboard panel.
function formatAdmins(admins: AdminRow[]): string[] {
  if (admins.length === 0) return ['(no admin slots yet)'];
  return admins.map((a, i) => {
    const num = String(i + 1).padStart(2, ' ');
    const name = a.name.padEnd(16, ' ');
    const claimed = a.inbox_id ? `claimed ${a.inbox_id.slice(0, 12)}…` : 'unclaimed';
    return `[${num}] ${name} code ${formatCode(a.upgrade_code)}  ${claimed}`;
  });
}

function generateCode(): string {
  // 16 digits, built from two 8-digit halves so each stays within
  // Number.MAX_SAFE_INTEGER. Stored as plain digits, no dashes.
  const half = (): string => String(randomInt(0, 100_000_000)).padStart(8, '0');
  return `${half()}${half()}`;
}

// Group an upgrade code into dash-separated blocks of 4 for display
// ("1234567890123456" → "1234-5678-9012-3456"). Presentation only —
// codes are stored and compared as plain digits.
function formatCode(code: string): string {
  return code.replace(/\D/g, '').replace(/(.{4})(?=.)/g, '$1-');
}

async function uniqueCode(client: pg.Client): Promise<string> {
  for (let i = 0; i < 25; i += 1) {
    const code = generateCode();
    // The deterministic lookup hash is what supports the UNIQUE index
    // — query against it, not the (non-deterministic) encrypted column.
    const hash = lookupHash(code, ADMIN_UPGRADE_CODE_LOOKUP_LABEL);
    const res = await client.query(
      'SELECT 1 FROM admin_inboxes WHERE upgrade_code_lookup = $1',
      [hash],
    );
    if (res.rows.length === 0) return code;
  }
  throw new Error('could not generate a unique upgrade code');
}

// Inserts an admin slot, returns the generated upgrade code.
async function addAdmin(client: pg.Client, name: string): Promise<string> {
  const code = await uniqueCode(client);
  const { stored, lookup } = encodeUpgradeCode(code);
  await client.query(
    'INSERT INTO admin_inboxes (name, upgrade_code, upgrade_code_lookup) VALUES ($1, $2, $3)',
    [name, stored, lookup],
  );
  return code;
}

async function removeAdmin(client: pg.Client, id: string): Promise<void> {
  await client.query('DELETE FROM admin_inboxes WHERE id = $1', [id]);
}

// --- clients (view only) ---------------------------------------------------

// Headcount + billing posture are owned by the iOS app; the CLI just
// reads the rows.
async function loadClients(client: pg.Client): Promise<ClientRow[]> {
  const res = await client.query<ClientRow>(
    `SELECT id, client_number, billing_seats
       FROM clients
       ORDER BY client_number ASC`,
  );
  return res.rows;
}

// Plain ANSI listing — used only by the non-interactive subcommands.
function printClients(rows: ClientRow[]): void {
  console.log(`${BOLD}Clients${RESET}`);
  if (rows.length === 0) {
    console.log(`  ${DIM}(no clients registered yet)${RESET}\n`);
    return;
  }
  rows.forEach((c) => {
    const num = `#${c.client_number}`.padEnd(6, ' ');
    const seats = c.billing_seats === 0
      ? `${DIM}no seats${RESET}`
      : `${c.billing_seats} seat${c.billing_seats === 1 ? '' : 's'}`;
    console.log(`  ${num} ${seats}`);
  });
  console.log('');
}

function formatClients(rows: ClientRow[]): string[] {
  if (rows.length === 0) return ['(no clients registered yet)'];
  return rows.map((c) => {
    const num = `#${c.client_number}`.padEnd(6, ' ');
    const seats = c.billing_seats === 0
      ? 'no seats'
      : `${c.billing_seats} seat${c.billing_seats === 1 ? '' : 's'}`;
    return `${num} ${seats}`;
  });
}

// --- payments (Stripe config) ----------------------------------------------

// Stripe billing is configured entirely through the .env file. The CLI's
// Payments → Stripe screen reads and writes these four keys so they never
// have to be hand-edited.
const STRIPE_KEYS = {
  secret: 'STRIPE_SECRET_KEY',
  webhook: 'STRIPE_WEBHOOK_SECRET',
  success: 'STRIPE_SUCCESS_URL',
  cancel: 'STRIPE_CANCEL_URL',
} as const;

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
}

function readStripeConfig(): StripeConfig {
  const env = readEnvFile();
  return {
    secretKey: env[STRIPE_KEYS.secret] ?? '',
    webhookSecret: env[STRIPE_KEYS.webhook] ?? '',
    successUrl: env[STRIPE_KEYS.success] ?? '',
    cancelUrl: env[STRIPE_KEYS.cancel] ?? '',
  };
}

// Write — or clear, when value is '' — a single key in the current .env
// file, leaving every other line intact. Throws on write failure.
function writeEnvKey(key: string, value: string): void {
  const path = envFilePath();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, setEnvValue(current, key, value), { mode: 0o600 });
}

// 'test' / 'live' from the secret key prefix; 'none' when unset; 'unknown'
// when the value doesn't look like a Stripe key.
function stripeMode(secretKey: string): 'test' | 'live' | 'none' | 'unknown' {
  if (!secretKey) return 'none';
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  return 'unknown';
}

// Show a secret as prefix + last 4 — recognisable but not exposed.
function maskSecret(value: string): string {
  if (!value) return 'not set';
  if (value.length <= 12) return 'set';
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

// True once Stripe can actually run: a secret key and a webhook secret.
function stripeReady(cfg: StripeConfig): boolean {
  return cfg.secretKey !== '' && cfg.webhookSecret !== '';
}

// Panel lines describing the current Stripe config, plus a safety warning
// when the key's mode and the environment disagree.
function formatStripeConfig(cfg: StripeConfig): string[] {
  const mode = stripeMode(cfg.secretKey);
  const pad = (label: string): string => label.padEnd(15, ' ');
  const lines: string[] = [];
  lines.push(`${pad('Status')}${stripeReady(cfg) ? 'ready' : 'incomplete'}`);
  lines.push(`${pad('Mode')}${mode}`);
  lines.push(`${pad('Secret key')}${maskSecret(cfg.secretKey)}`);
  lines.push(`${pad('Webhook secret')}${maskSecret(cfg.webhookSecret)}`);
  lines.push(`${pad('Success URL')}${cfg.successUrl || '(default — backend /billing/return)'}`);
  lines.push(`${pad('Cancel URL')}${cfg.cancelUrl || '(default — backend /billing/cancel)'}`);
  if (mode === 'live' && ENV === 'dev') {
    lines.push('', '⚠ live key in the dev environment — dev should use sk_test_….');
  }
  if (mode === 'test' && ENV === 'prod') {
    lines.push('', '⚠ test key in production — production needs sk_live_….');
  }
  return lines;
}

// --- dev environment processes ---------------------------------------------

// The backend server (server:dev) and agents (agents:dev) run as detached
// background processes; their pids and per-run logs live under .dev-run/.
function devRunDir(): string {
  return join(REPO_ROOT, '.dev-run');
}

function devPidFile(name: string): string {
  return join(devRunDir(), `${name}.pid`);
}

// Compact YYYYMMDD-HHMMSS stamp for per-run log filenames.
function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// The pid if the named dev process is alive, else null.
function devProcessPid(name: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(devPidFile(name), 'utf8').trim(), 10);
    if (!Number.isInteger(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

// tsx watch runs the watched script in its own process group, so killing the
// npm parent's group can orphan the real server/agent. These unique
// command-line fragments let us hunt those stragglers down by pattern.
const DEV_PROCESS_PATTERN: Record<string, string> = {
  server: 'src/server.ts',
  agent: 'src/agent/index.ts',
  simulator: 'mirror-sim-logs.sh',
  stripe: 'stripe listen',
};

// SIGKILL every process whose command line contains `pattern`. Returns true
// if at least one process was signalled.
function reapByPattern(pattern: string): boolean {
  try {
    return spawnSync('pkill', ['-9', '-f', pattern], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// SIGKILL whatever is listening on a TCP port. Returns how many were killed.
function freePort(port: number): number {
  let killed = 0;
  try {
    const found = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    for (const line of (found.stdout ?? '').split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isInteger(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // already gone
      }
    }
  } catch {
    // lsof not available
  }
  return killed;
}

// The port the dev backend binds; overridable via PORT in .env.dev.
function devServerPort(): number {
  const port = Number.parseInt(readEnvFile().PORT ?? '', 10);
  return Number.isInteger(port) && port > 0 ? port : 4000;
}

// Reap any straggler for the named dev process (and free the server port if
// it is the backend). Returns true if anything had to be cleaned up.
function reapDevProcess(name: string): boolean {
  const pattern = DEV_PROCESS_PATTERN[name];
  const reaped = pattern ? reapByPattern(pattern) : false;
  const freed = name === 'server' ? freePort(devServerPort()) : 0;
  return reaped || freed > 0;
}

// Spawn a detached background process, logging to a fresh timestamped file
// under .dev-run/. Reaps stale stragglers first so `up` always starts clean.
// Returns a human-readable result line.
function startDevProcess(name: string, command: string, args: string[]): string {
  if (devProcessPid(name)) {
    return `${name} already running.`;
  }
  // A previous `tsx watch` worker can outlive its npm parent and squat on the
  // port; clear it before binding so the new process starts clean.
  const cleaned = reapDevProcess(name);
  if (cleaned) spawnSync('sleep', ['1']);
  mkdirSync(devRunDir(), { recursive: true });
  const logName = `${name}-${timestamp()}.log`;
  const log = openSync(join(devRunDir(), logName), 'w');
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  if (child.pid) {
    writeFileSync(devPidFile(name), String(child.pid));
    const note = cleaned ? ' (cleared a straggler first)' : '';
    return `✓ ${name} started (pid ${child.pid}, log: .dev-run/${logName})${note}`;
  }
  return `✗ failed to start ${name}`;
}

// --- stripe webhook listener (dev) -----------------------------------------
//
// In dev there is no public webhook endpoint — the Stripe CLI's
// `stripe listen` opens an authenticated channel to Stripe and forwards
// events to the local backend. The CLI manages it as a dev process so it
// starts and stops with the rest of the environment.

// True if the Stripe CLI binary is on PATH.
function stripeCliInstalled(): boolean {
  try {
    return spawnSync('stripe', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// Fetch the Stripe CLI's webhook signing secret (stable per account) and
// store it in .env as STRIPE_WEBHOOK_SECRET, so the backend can verify
// webhook signatures without anyone copying whsec_… by hand. Returns a
// human-readable result line.
function syncStripeWebhookSecret(): string {
  const cfg = readStripeConfig();
  if (!cfg.secretKey) return 'Webhook secret: skipped — no Stripe secret key set.';
  if (!stripeCliInstalled()) return 'Webhook secret: skipped — Stripe CLI not installed.';
  const res = spawnSync('stripe', ['listen', '--api-key', cfg.secretKey, '--print-secret'], { encoding: 'utf8' });
  if (res.status !== 0) {
    const detail = (res.stderr ?? '').trim().split('\n')[0] ?? '';
    return `Webhook secret: could not read it from the Stripe CLI${detail ? ` — ${detail}` : '.'}`;
  }
  const secret = (res.stdout ?? '').trim();
  if (!secret.startsWith('whsec_')) return 'Webhook secret: the Stripe CLI did not return one.';
  if (secret === cfg.webhookSecret) return 'Webhook secret: already up to date.';
  writeEnvKey(STRIPE_KEYS.webhook, secret);
  return '✓ Webhook secret synced into .env from the Stripe CLI.';
}

// --- caddy https proxy (dev) -----------------------------------------------
//
// XMTP iOS rejects RemoteAttachments whose URL scheme isn't https. The dev
// backend speaks plain http, so we run Caddy in front of it terminating
// TLS on :4443 → forwarding to localhost:4000. Managed alongside server +
// agents so the dev env comes up complete with one keystroke.

// True if the caddy binary is on PATH.
function caddyInstalled(): boolean {
  try {
    return spawnSync('caddy', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// Absolute path to caddy on disk — needed because osascript's
// `do shell script … with administrator privileges` runs under sudo
// with a stripped PATH that doesn't include Homebrew's bin.
function caddyBinPath(): string {
  try {
    const res = spawnSync('which', ['caddy'], { encoding: 'utf8' });
    if (res.status === 0) {
      const path = res.stdout.trim();
      if (path) return path;
    }
  } catch {
    // ignore
  }
  return 'caddy';
}

// Where Caddy persists its locally-issued root CA. Caddy writes this
// the first time it boots with `tls internal`; the file is what we
// hand to the macOS System keychain and the iOS Simulator keychain.
function caddyRootCertPath(): string {
  return join(
    process.env.HOME ?? '',
    'Library/Application Support/Caddy/pki/authorities/local/root.crt',
  );
}

// SHA-1 fingerprint of the on-disk Caddy root, or null if we can't read
// it. Used to compare against what's in the System keychain so we notice
// when Caddy rotates its yearly root (the CN matches between years but
// the fingerprint doesn't).
function caddyRootFingerprint(): string | null {
  const path = caddyRootCertPath();
  if (!existsSync(path)) return null;
  try {
    const res = spawnSync(
      'openssl',
      ['x509', '-in', path, '-noout', '-fingerprint', '-sha1'],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) return null;
    // openssl prints "SHA1 Fingerprint=AA:BB:CC:..." — strip the prefix.
    const line = (res.stdout ?? '').trim();
    const eq = line.indexOf('=');
    return eq >= 0 ? line.slice(eq + 1).toUpperCase() : null;
  } catch {
    return null;
  }
}

// True once Caddy's current local root is in the macOS System keychain.
// Matches by SHA-1, not CN, so a stale root from a prior year doesn't
// mask a missing-current-year cert when Caddy rotates.
function caddyRootTrustedInSystemKeychain(): boolean {
  const want = caddyRootFingerprint();
  if (!want) return false;
  try {
    // -Z prints SHA-1 alongside each matching cert; -a returns every
    // match (there can be multiple "Caddy Local Authority - <year>" certs
    // stacked up after a few rotations).
    const res = spawnSync(
      'security',
      [
        'find-certificate',
        '-a',
        '-c',
        'Caddy Local Authority',
        '-Z',
        '/Library/Keychains/System.keychain',
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) return false;
    const normalized = (res.stdout ?? '').replace(/:/g, '').toUpperCase();
    const wantNoColons = want.replace(/:/g, '');
    return normalized.includes(wantNoColons);
  } catch {
    return false;
  }
}

// Wait briefly for Caddy to lay down its root CA on disk after starting.
async function waitForCaddyRoot(timeoutMs: number = 5000): Promise<boolean> {
  const path = caddyRootCertPath();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(200);
  }
  return existsSync(path);
}

// Install Caddy's root CA into the macOS System keychain. Needs sudo, so
// we route it through `osascript … with administrator privileges` to get
// macOS's GUI password prompt — the ink dashboard owns the TTY and can't
// drive an interactive `sudo` itself. Idempotent: a no-op once trusted.
async function trustCaddyRootInSystemKeychain(append: (line: string) => void): Promise<void> {
  if (!caddyInstalled()) {
    append('Caddy trust: skipped — caddy not installed.');
    return;
  }
  const haveRoot = await waitForCaddyRoot();
  if (!haveRoot) {
    append('Caddy trust: root CA not on disk yet — skipping (start Caddy first).');
    return;
  }
  if (caddyRootTrustedInSystemKeychain()) {
    append('Caddy trust: already installed in macOS System keychain.');
    return;
  }
  append('Caddy trust: installing root CA into macOS System keychain…');
  append('  ↳ macOS will ask for your password (one-time per machine).');
  const caddy = caddyBinPath();
  const script =
    `do shell script "${caddy.replace(/"/g, '\\"')} trust" ` +
    `with administrator privileges ` +
    `with prompt "Goldilocks dev needs to trust Caddy's local root CA so the iOS Simulator can fetch attachments over HTTPS."`;
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (res.status === 0) {
    append('✓ Caddy root installed in macOS System keychain.');
    return;
  }
  const detail = (res.stderr ?? '').trim().split('\n')[0] ?? '';
  if (/User canceled|-128/.test(detail)) {
    append('Caddy trust: cancelled. Run `caddy trust` manually to enable HTTPS for iOS.');
  } else {
    append(`Caddy trust: failed${detail ? ` — ${detail}` : '.'}`);
  }
}

// UDID of a booted iOS Simulator, or null when none is running.
function bootedSimulatorUdid(): string | null {
  try {
    const res = spawnSync(
      'xcrun',
      ['simctl', 'list', 'devices', 'booted', '-j'],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) return null;
    const parsed = JSON.parse(res.stdout) as { devices?: Record<string, { udid?: string }[]> };
    for (const list of Object.values(parsed.devices ?? {})) {
      for (const dev of list ?? []) {
        if (dev.udid) return dev.udid;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// Install Caddy's root CA into the booted iOS Simulator's keychain. The
// simulator has its own keychain separate from the host's System
// keychain — even `caddy trust` won't reach it, so the simulator rejects
// our cert with -1200/-9807/-9838 until we add it here. Idempotent and
// password-free; safe to re-run on every start.
//
// After installing, we also bounce `trustd` inside the simulator —
// add-root-cert writes to the trust store, but trustd caches its view
// of that store and only re-reads it on launch. Without the kick the
// simulator can still reject the cert until next reboot.
function trustCaddyForBootedSimulator(append: (line: string) => void): void {
  const root = caddyRootCertPath();
  if (!existsSync(root)) {
    append('Simulator trust: skipped — Caddy root CA not on disk yet.');
    return;
  }
  if (!bootedSimulatorUdid()) {
    append('Simulator trust: skipped — no iOS Simulator is booted.');
    return;
  }
  const res = spawnSync(
    'xcrun',
    ['simctl', 'keychain', 'booted', 'add-root-cert', root],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    const detail = (res.stderr ?? '').trim().split('\n')[0] ?? '';
    append(`Simulator trust: failed${detail ? ` — ${detail}` : '.'}`);
    return;
  }
  append('✓ Caddy root installed in the booted iOS Simulator keychain.');

  // Force trustd to drop its cache so the new root is honored now,
  // not on the next sim reboot. `launchctl kickstart -k system/<svc>`
  // stops and restarts the service inside the simulator.
  const kick = spawnSync(
    'xcrun',
    ['simctl', 'spawn', 'booted', 'launchctl', 'kickstart', '-k', 'system/com.apple.trustd'],
    { encoding: 'utf8' },
  );
  if (kick.status === 0) {
    append('✓ Simulator trustd kicked — new root takes effect immediately.');
  } else {
    // Non-fatal: cert is installed, just may need a sim reboot to apply.
    append('Simulator trustd kick: not available — reboot the simulator if iOS still rejects the cert.');
  }
}

// Start Caddy as a managed dev process, using ./dev/Caddyfile. No-op
// (with a note) when caddy isn't installed.
function startCaddy(): string {
  if (!caddyInstalled()) {
    return 'Caddy https proxy: skipped — install Caddy (brew install caddy) to enable HTTPS for iOS RemoteAttachments.';
  }
  const caddyfile = join(REPO_ROOT, 'dev', 'Caddyfile');
  return startDevProcess('caddy', 'caddy', ['run', '--config', caddyfile, '--adapter', 'caddyfile']);
}

// Start Caddy and then install its root CA into the macOS System
// keychain and the booted iOS Simulator's keychain. Combines the three
// steps the dev flow needs into one call so start/restart never leave
// iOS in a "rejects the cert" state.
async function startAndTrustCaddy(append: (line: string) => void): Promise<void> {
  append(startCaddy());
  if (!caddyInstalled()) return;
  await trustCaddyRootInSystemKeychain(append);
  trustCaddyForBootedSimulator(append);
}

// Start `stripe listen` as a managed dev process, forwarding events to the
// local backend. No-op (with a note) when Stripe isn't configured or the
// CLI is missing.
function startStripeListener(): string {
  const cfg = readStripeConfig();
  if (!cfg.secretKey) return 'Stripe webhook listener: skipped — set a secret key in Payments → Stripe.';
  if (!stripeCliInstalled()) {
    return 'Stripe webhook listener: skipped — install the Stripe CLI (brew install stripe/stripe-cli/stripe).';
  }
  const forwardTo = `localhost:${devServerPort()}/api/v2/stripe/webhook`;
  return startDevProcess('stripe', 'stripe', ['listen', '--api-key', cfg.secretKey, '--forward-to', forwardTo]);
}

// Stop the named dev process: SIGTERM its group, then hunt down any straggler
// tsx watch orphaned into a separate group and free the server port.
function stopDevProcess(name: string): string {
  const pid = devProcessPid(name);
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  const cleaned = reapDevProcess(name);
  try {
    unlinkSync(devPidFile(name));
  } catch {
    // ignore
  }
  if (pid) return `✓ ${name} stopped.`;
  return cleaned ? `✓ ${name} stopped (cleared a straggler).` : `${name} not running.`;
}

// --- status + logs ---------------------------------------------------------

// True if the named compose service has a running container.
async function composeServiceRunning(service: string): Promise<boolean> {
  const { command, args } = dockerComposeSpawn(['ps', '-q', service]);
  const r = await capture(command, args);
  return r.code === 0 && r.out.trim().length > 0;
}

// On/off status for the current environment, shown as the dashboard cards.
async function dashboardStats(): Promise<StatItem[]> {
  if (ENV === 'dev') {
    const [db, xmtp] = await Promise.all([
      capture('docker', ['compose', '-f', 'docker-compose.yml', 'ps', '-q', 'goldilocks-db'], REPO_ROOT),
      capture('docker', ['compose', '-f', 'dev/docker-compose.yml', '-p', 'convos-ios', 'ps', '-q'], iosRepoDir()),
    ]);
    const stats: StatItem[] = [
      { label: 'server', on: devProcessPid('server') !== null },
      { label: 'agents', on: devProcessPid('agent') !== null },
      { label: 'database', on: db.code === 0 && db.out.trim().length > 0 },
      { label: 'XMTP node', on: xmtp.code === 0 && xmtp.out.trim().length > 0 },
    ];
    // The Caddy https proxy only matters when it's installed; otherwise
    // the dev env can still run with http (just no RemoteAttachments).
    if (caddyInstalled()) {
      stats.push({ label: 'caddy', on: devProcessPid('caddy') !== null });
    }
    // The Stripe webhook listener only matters once Stripe is configured.
    if (readStripeConfig().secretKey) {
      stats.push({ label: 'stripe', on: devProcessPid('stripe') !== null });
    }
    return stats;
  }
  const [backend, agent, db, tunnel] = await Promise.all([
    composeServiceRunning('backend'),
    composeServiceRunning('agent'),
    composeServiceRunning('goldilocks-db'),
    composeServiceRunning('cloudflared'),
  ]);
  return [
    { label: 'backend', on: backend },
    { label: 'agent', on: agent },
    { label: 'database', on: db },
    { label: 'tunnel', on: tunnel },
  ];
}

// Everything the dashboard shows, gathered fault-tolerantly.
async function collectDashboard(): Promise<DashboardData> {
  const stats = await dashboardStats().catch((): StatItem[] => []);
  let installs: number | null = null;
  let seats: DashboardData['seats'] = null;
  let admins: number | null = null;
  try {
    const data = await withDb(async (c) => {
      const cl = await loadClients(c);
      const ad = await loadAdmins(c);
      return { cl, ad };
    });
    installs = data.cl.length;
    seats = {
      totalSeats: data.cl.reduce((sum, r) => sum + r.billing_seats, 0),
      clientsWithSeats: data.cl.filter((r) => r.billing_seats > 0).length,
    };
    admins = data.ad.length;
  } catch {
    // DB not reachable — cards show as “—”.
  }
  let tunnelUrl = '';
  if (ENV === 'prod') tunnelUrl = await getTunnelUrl().catch((): string => '');
  return { stats, installs, seats, admins, tunnelUrl };
}

// --- backups ---------------------------------------------------------------

// Backups live in a restic repo under ./backups/restic-<env>/, written
// by the `backup` compose service. See scripts/backup.sh and
// docs/encryption-and-backup-plan.md F1.

function resticRepoDir(): string {
  return join(REPO_ROOT, 'backups', `restic-${ENV}`);
}

function resticPassphraseFile(): string {
  return ENV === 'prod'
    ? join(REPO_ROOT, '.restic-passphrase.prod')
    : join(REPO_ROOT, 'dev', 'restic-passphrase.dev');
}

const BACKUP_IMAGE = 'goldilocks-backup:latest';

// Create the env's restic passphrase file if it doesn't already exist.
// Returns whether a new file was written so the caller can surface the
// "go save this in your password manager" prompt at the right moment.
//
// The passphrase is 24 random bytes encoded as base64 — high enough
// entropy that brute-force is intractable, short enough to read from a
// terminal line. chmod 600 so other users on the host can't read it.
function ensureResticPassphrase(): { created: boolean; path: string } {
  const path = resticPassphraseFile();
  if (existsSync(path)) {
    return { created: false, path };
  }
  const passphrase = randomBytes(24).toString('base64');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${passphrase}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { created: true, path };
}

// Has the backup image been built locally? Used so the Backups screen
// can offer a one-time "Build backup image" action instead of making
// the operator wait through it on their first backup. The sync flavor
// is kept for callers that legitimately need it (Settings → Run setup
// branches on this before kicking off the build); the async flavor is
// what the Backups screen useEffect calls.
function backupImageBuilt(): boolean {
  const res = spawnSync('docker', ['image', 'inspect', BACKUP_IMAGE], {
    stdio: 'ignore',
  });
  return res.status === 0;
}

function backupImageBuiltAsync(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['image', 'inspect', BACKUP_IMAGE], {
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(false);
    }, 5000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

// Result of an async snapshot fetch — includes a surfaceable error
// string so the screen can tell the operator WHY the load failed
// (image missing, repo locked, docker daemon unresponsive) instead
// of just hanging or returning an unexplained empty list.
interface SnapshotLoadResult {
  snapshots: ResticSnapshot[];
  error: string | null;
}

// Async snapshot list — used by the Backups screen useEffect so the
// render path stays non-blocking. Hard 15s timeout: if docker /
// restic doesn't respond by then, we give up and surface the most
// useful error fragment we have so the operator can decide what to
// do (rebuild image / unlock repo / restart docker).
function listSnapshotsAsync(): Promise<SnapshotLoadResult> {
  if (!existsSync(resticRepoDir())) {
    return Promise.resolve({ snapshots: [], error: null });
  }
  if (!existsSync(resticPassphraseFile())) {
    return Promise.resolve({
      snapshots: [],
      error: `passphrase missing at ${resticPassphraseFile().replace(REPO_ROOT + '/', '')} — Generate backup passphrase below`,
    });
  }
  return new Promise((resolve) => {
    const proc = spawn(
      'docker',
      resticDockerArgs(['snapshots', '--json'], true),
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({
        snapshots: [],
        error: 'snapshot fetch timed out after 15s — Docker may be slow or unresponsive (try Backups → Build backup image, or restart Docker Desktop)',
      });
    }, 15000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0 && out) {
        try {
          const parsed: unknown = JSON.parse(out);
          if (Array.isArray(parsed)) {
            resolve({ snapshots: parsed as ResticSnapshot[], error: null });
            return;
          }
          resolve({ snapshots: [], error: 'restic returned non-array JSON' });
          return;
        } catch {
          resolve({ snapshots: [], error: 'restic output was not valid JSON' });
          return;
        }
      }
      // Surface the most informative tail of stderr.
      const tail = err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join('  |  ');
      const message = tail || `restic exited ${code ?? '?'} with no output`;
      // Common case worth pattern-matching: a stale lock from an
      // interrupted backup. The operator can clear it with the
      // "Unlock restic repo" action.
      const friendly = /locked/i.test(message)
        ? `${message}  (try "Unlock restic repo" below)`
        : message;
      resolve({ snapshots: [], error: friendly.slice(0, 240) });
    });
    proc.on('error', (e) => {
      clearTimeout(timeout);
      resolve({ snapshots: [], error: `docker spawn failed: ${e.message}` });
    });
  });
}

// --- SOPS-sealed env files (F3) -------------------------------------------
//
// Each environment has:
//   - .env.<env>                     plaintext, runtime cache, gitignored
//   - secrets/<env>.env.enc          SOPS-encrypted, committable
//   - secrets/.age/<env>.key         age private key, mode 600, gitignored
//   - secrets/.age/<env>.key.pub     plain-text recipient (age1...), gitignored
//
// The CLI auto-unseals the encrypted file into the plaintext on session
// start whenever the sealed file is newer than the plaintext, so the
// operator's day-to-day workflow doesn't change — they edit .env.<env>,
// the CLI re-seals on demand via Settings → Keys.

function ageKeyFile(): string {
  return join(REPO_ROOT, 'secrets', '.age', `${ENV}.key`);
}

function ageRecipientFile(): string {
  return `${ageKeyFile()}.pub`;
}

function sealedEnvFile(): string {
  return join(REPO_ROOT, 'secrets', `${ENV}.env.enc`);
}

// Read the recipient (age1...) line for sealing. Cached on disk
// alongside the private key so we don't shell out to age-keygen every
// time we want to encrypt.
function readAgeRecipient(): string | null {
  try {
    const raw = readFileSync(ageRecipientFile(), 'utf8').trim();
    const match = raw.match(/age1[a-z0-9]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// Generate a fresh age keypair via the backup image's age-keygen binary,
// chmod 600, write the recipient to <key>.pub alongside. Returns whether
// a new key was minted (vs. one already existed).
function ensureAgeKey(): { created: boolean; path: string; recipient: string | null } {
  const path = ageKeyFile();
  if (existsSync(path)) {
    return { created: false, path, recipient: readAgeRecipient() };
  }
  mkdirSync(dirname(path), { recursive: true });
  // age-keygen writes the private key (with a `# public key:` comment line)
  // to stdout. We split it: the secret line(s) go to the key file, the
  // recipient goes to <key>.pub.
  const res = spawnSync(
    'docker',
    ['run', '--rm', BACKUP_IMAGE, 'age-keygen'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0 || !res.stdout) {
    return { created: false, path, recipient: null };
  }
  const out = res.stdout;
  const recipientMatch = out.match(/age1[a-z0-9]+/);
  const recipient = recipientMatch ? recipientMatch[0] : null;
  writeFileSync(path, out, { mode: 0o600 });
  chmodSync(path, 0o600);
  if (recipient) {
    writeFileSync(ageRecipientFile(), `${recipient}\n`, { mode: 0o600 });
    chmodSync(ageRecipientFile(), 0o600);
  }
  return { created: true, path, recipient };
}

// Write a minimal .sops.yaml mapping the *source* env files to their
// per-env age recipients. SOPS matches creation_rules against the file
// passed to `--encrypt` (the plaintext `.env.<env>`), so the rule
// regex has to match THAT path, not the encrypted output.
//
// Idempotent: if the file already exists with the correct pattern it
// short-circuits. If it exists with the legacy/wrong pattern (the
// pre-fix version targeted `secrets/<env>.env.enc`, which sops never
// uses for lookup) the function rewrites it.
function ensureSopsConfig(): { created: boolean; path: string; replaced: boolean } {
  const path = join(REPO_ROOT, '.sops.yaml');

  let replaced = false;
  if (existsSync(path)) {
    let existing = '';
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      existing = '';
    }
    // The buggy pre-fix pattern targeted the encrypted output path.
    const hasBuggyPattern = /path_regex:\s*secrets\/(dev|prod)\\?\.env\\?\.enc/.test(existing);
    if (!hasBuggyPattern) {
      return { created: false, path, replaced: false };
    }
    replaced = true;
  }

  const lines: string[] = [
    '# SOPS rule set. Each entry binds a path pattern (matched against',
    '# the SOURCE file passed to `sops --encrypt`) to the age recipient',
    '# that can decrypt files written under that rule. Generated by the',
    '# goldilocks CLI; safe to edit if you know what you are doing.',
    'creation_rules:',
  ];
  for (const env of ['dev', 'prod'] as const) {
    const pubPath = join(REPO_ROOT, 'secrets', '.age', `${env}.key.pub`);
    let recipient = '';
    try {
      const raw = readFileSync(pubPath, 'utf8');
      recipient = (raw.match(/age1[a-z0-9]+/) ?? [''])[0];
    } catch {
      recipient = '';
    }
    if (recipient) {
      // Match the plaintext source file. sops looks up rules using the
      // path passed to --encrypt, which seal-env.sh passes as
      // `.env.<env>` after `cd $REPO_ROOT`.
      lines.push(`  - path_regex: \\.env\\.${env}$`);
      lines.push(`    age: ${recipient}`);
    }
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { created: !replaced, path, replaced };
}

// Run scripts/seal-env.sh for the current env via plain bash on the host
// (the script itself shells into the backup image to invoke sops). Sync
// because the call sites want a result. Returns stderr on failure.
function sealEnvSync(): { ok: boolean; message: string } {
  const res = spawnSync('bash', [scriptPath('seal-env.sh'), ENV], {
    encoding: 'utf8',
  });
  if (res.status === 0) {
    return { ok: true, message: `Sealed .env.${ENV} → ${sealedEnvFile()}` };
  }
  return { ok: false, message: (res.stderr || res.stdout || 'seal-env.sh failed').trim() };
}

function unsealEnvSync(): { ok: boolean; message: string } {
  const res = spawnSync('bash', [scriptPath('unseal-env.sh'), ENV], {
    encoding: 'utf8',
  });
  if (res.status === 0) {
    return { ok: true, message: `Unsealed ${sealedEnvFile()} → .env.${ENV}` };
  }
  return { ok: false, message: (res.stderr || res.stdout || 'unseal-env.sh failed').trim() };
}

// "Is the encrypted form newer than the plaintext (or the plaintext
// missing entirely)?" Used at session start to decide whether to
// auto-unseal so the operator never sees the encryption layer when
// they just want to use the system normally.
function sealedNewerThanPlain(): boolean {
  const sealed = sealedEnvFile();
  const plain = envFilePath();
  if (!existsSync(sealed)) return false;
  if (!existsSync(plain)) return true;
  try {
    return statSync(sealed).mtimeMs > statSync(plain).mtimeMs;
  } catch {
    return false;
  }
}

// --- Internal TLS (F5) ----------------------------------------------------
//
// secrets/tls/ holds the per-env CA + postgres server leaf. The CA is
// generated once and reused; only the leaf rotates (manually for now,
// via scripts/renew-tls.sh — annual cadence).

function tlsDir(): string {
  return join(REPO_ROOT, 'secrets', 'tls');
}

function tlsCaCertPath(): string {
  return join(tlsDir(), 'ca.crt');
}

function tlsCaKeyPath(): string {
  return join(tlsDir(), 'ca.key');
}

function tlsPostgresCertPath(): string {
  return join(tlsDir(), 'postgres.crt');
}

// Read the notAfter date of a PEM cert via openssl inside the backup
// image. Returns null if the file is missing or openssl can't read it.
function tlsCertExpiry(certPath: string): Date | null {
  if (!existsSync(certPath)) return null;
  if (!backupImageBuilt()) return null;
  // openssl x509 -enddate prints  notAfter=Apr 28 12:00:00 2027 GMT
  const res = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${REPO_ROOT}:/work:ro`,
      '-w', '/work',
      '--entrypoint', 'openssl',
      BACKUP_IMAGE,
      'x509', '-enddate', '-noout', '-in', certPath.replace(REPO_ROOT + '/', ''),
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0 || !res.stdout) return null;
  const match = res.stdout.match(/notAfter=(.+)/);
  if (!match || !match[1]) return null;
  const parsed = new Date(match[1].trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Mint the CA + postgres leaf for the current env via init-tls.sh.
// Idempotent: skips work if both already exist (unless force=true).
function ensureTlsSync(force = false): { ok: boolean; message: string; created: boolean } {
  const caExists = existsSync(tlsCaCertPath());
  const leafExists = existsSync(tlsPostgresCertPath());
  if (caExists && leafExists && !force) {
    return { ok: true, message: 'TLS material already in place — leaving it alone.', created: false };
  }
  const args = [scriptPath('init-tls.sh'), ENV];
  if (force) args.push('--force');
  const res = spawnSync('bash', args, { encoding: 'utf8' });
  if (res.status === 0) {
    return { ok: true, message: `Minted TLS material in ${tlsDir().replace(REPO_ROOT + '/', '')}/`, created: true };
  }
  return { ok: false, message: (res.stderr || res.stdout || 'init-tls.sh failed').trim(), created: false };
}

// Rotate the leaf cert only — keeps the CA so pinned clients keep
// working without a config change.
function renewTlsLeafSync(): { ok: boolean; message: string } {
  const res = spawnSync('bash', [scriptPath('renew-tls.sh'), ENV], { encoding: 'utf8' });
  if (res.status === 0) {
    return { ok: true, message: 'Renewed postgres leaf cert. Restart postgres + backend + agent to pick it up.' };
  }
  return { ok: false, message: (res.stderr || res.stdout || 'renew-tls.sh failed').trim() };
}

// Build the `docker run` arg list for one-shot restic invocations.
// Read-only mounts when we just want to list / check the repo. Reuses
// the goldilocks-backup image (which already carries the restic binary)
// so opening the Backups screen doesn't pay the extra image-pull cost
// — that pull was the cause of an early-launch UI freeze on fresh
// checkouts. `--entrypoint restic` bypasses the postgres base's
// inherited docker-entrypoint.sh.
//
// When `readOnly` is true the repo is mounted :ro AND restic gets the
// global `--no-lock` flag prepended — otherwise restic would try to
// write a lock file under /repo/locks/ and hang on EROFS-retries.
function resticDockerArgs(args: string[], readOnly: boolean): string[] {
  const repo = resticRepoDir();
  const pass = resticPassphraseFile();
  const repoMount = readOnly ? `${repo}:/repo:ro` : `${repo}:/repo`;
  const resticArgs = readOnly ? ['--no-lock', ...args] : args;
  return [
    'run', '--rm',
    '--entrypoint', 'restic',
    '-v', repoMount,
    '-v', `${pass}:/passphrase:ro`,
    '-e', 'RESTIC_REPOSITORY=/repo',
    '-e', 'RESTIC_PASSWORD_FILE=/passphrase',
    BACKUP_IMAGE,
    ...resticArgs,
  ];
}

// Synchronously fetch and parse the snapshot list. Returns [] if the
// repo doesn't exist yet, the passphrase is missing, or restic can't
// open the repo for any reason.
function listSnapshots(): ResticSnapshot[] {
  if (!existsSync(resticRepoDir()) || !existsSync(resticPassphraseFile())) {
    return [];
  }
  const res = spawnSync('docker', resticDockerArgs(['snapshots', '--json'], true), {
    encoding: 'utf8',
  });
  if (res.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed as ResticSnapshot[];
  } catch {
    return [];
  }
}

function formatSnapshots(snapshots: ResticSnapshot[]): string[] {
  if (snapshots.length === 0) {
    if (!existsSync(resticPassphraseFile())) {
      return [`No passphrase file at ${resticPassphraseFile()} — run setup first.`];
    }
    if (!existsSync(resticRepoDir())) {
      return ['(no snapshots yet — run a backup to initialise the repo)'];
    }
    return ['(no snapshots in repo)'];
  }
  // Sort newest first. Restic returns ascending; we want descending.
  const sorted = [...snapshots].sort((a, b) => b.time.localeCompare(a.time));
  return sorted.map((s) => {
    const when = s.time.replace('T', ' ').replace(/\.\d+.*$/, 'Z');
    const tags = (s.tags ?? []).filter((t) => !t.startsWith('ts=')).join(' ');
    return `  ${s.short_id}  ${when}  ${tags}`;
  });
}

// Group snapshots by their ts= tag — one backup run writes three
// (db / volumes / stage). The picker shows one row per run, restore.sh
// resolves the snapshot id back to the full run.
interface BackupRun {
  ts: string;       // the ts= tag value, e.g. 20260527T030000Z
  snapshotId: string; // any one of the snapshots from this run (restore.sh accepts any)
  time: string;       // ISO timestamp for display
  kinds: string[];    // db/volumes/stage that we found for this run
}

function groupBackupRuns(snapshots: ResticSnapshot[]): BackupRun[] {
  const byTs = new Map<string, BackupRun>();
  for (const s of snapshots) {
    const ts = (s.tags ?? []).find((t) => t.startsWith('ts='))?.slice(3) ?? s.short_id;
    const kind = (s.tags ?? []).find((t) => t.startsWith('kind='))?.slice(5) ?? '';
    const existing = byTs.get(ts);
    if (existing) {
      if (kind && !existing.kinds.includes(kind)) existing.kinds.push(kind);
    } else {
      byTs.set(ts, { ts, snapshotId: s.short_id, time: s.time, kinds: kind ? [kind] : [] });
    }
  }
  return Array.from(byTs.values()).sort((a, b) => b.ts.localeCompare(a.ts));
}

// --- settings / env --------------------------------------------------------

const REQUIRED_KEYS: Record<Env, string[]> = {
  dev: ['DATABASE_URL', 'JWT_SECRET'],
  prod: ['POSTGRES_PASSWORD', 'JWT_SECRET', 'AGENT_DB_ENCRYPTION_KEY'],
};

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

// Replace a `KEY=...` line in place, or append it if absent.
function setEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content) ? content.replace(re, () => line) : `${content.replace(/\n*$/, '')}\n${line}\n`;
}

// Parse a .env file into key/value pairs (comments and blanks skipped).
function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(envFilePath(), 'utf8');
  } catch {
    return values;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

// One-line config health summary — no values shown.
function envSummaryLine(): string {
  if (!envFileExists()) return 'missing — run setup';
  const values = readEnvFile();
  const missing = REQUIRED_KEYS[ENV].filter((key) => {
    const value = values[key] ?? '';
    return value === '' || value.startsWith('replace_me');
  });
  if (missing.length === 0) return 'ready';
  return `${missing.length} required value${missing.length === 1 ? '' : 's'} missing`;
}

// Build a fresh .env file from the template, with generated secrets.
function buildEnvContent(xmtpUrl: string): string {
  // Preserve existing secrets across re-runs so the encrypted columns
  // (F4) and the agent DB (encrypted with AGENT_DB_ENCRYPTION_KEY) stay
  // readable. Only generate fresh values for keys the operator hasn't
  // seen yet. A change in template (.env.example) still propagates —
  // we re-read the template every time.
  const existing = existsSync(envFilePath()) ? readEnvFile() : {};
  const carryOrGenerate = (key: string): string => {
    const prior = existing[key];
    if (prior && prior !== '' && !prior.startsWith('replace_me')) {
      return prior;
    }
    return generateSecret();
  };

  let content = readFileSync(envTemplatePath(), 'utf8');
  content = setEnvValue(content, 'JWT_SECRET', carryOrGenerate('JWT_SECRET'));
  content = setEnvValue(content, 'AGENT_DB_ENCRYPTION_KEY', carryOrGenerate('AGENT_DB_ENCRYPTION_KEY'));
  // F4 — App-layer column encryption. Carrying the existing key is
  // critical: rotating it without a re-encrypt step would make every
  // ciphertext in the targeted columns permanently unreadable.
  content = setEnvValue(content, 'APP_ENCRYPTION_KEY', carryOrGenerate('APP_ENCRYPTION_KEY'));
  content = setEnvValue(content, 'ENCRYPT_AT_REST_V1', 'true');
  if (ENV === 'prod') {
    content = setEnvValue(content, 'POSTGRES_PASSWORD', carryOrGenerate('POSTGRES_PASSWORD'));
    if (xmtpUrl) content = setEnvValue(content, 'XMTP_GRPC_URL', xmtpUrl);
  }
  return content;
}

// --- ink components --------------------------------------------------------

const PROD_SERVICES = ['goldilocks-db', 'backend', 'agent', 'cloudflared', 'backup'];

// Terminal dimensions, refreshed on resize so the full-screen layout
// always fills the window exactly.
function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState<{ columns: number; rows: number }>(() => ({
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  }));
  useEffect(() => {
    const onResize = (): void => {
      setSize({
        columns: process.stdout.columns || 100,
        rows: process.stdout.rows || 30,
      });
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return size;
}

const DEFAULT_HINT = '↑↓ move   enter select   ctrl+c quit';

// The persistent top toolbar — brand + environment only. Kept compact
// (single line) so it fits narrow / portrait terminals. Live service
// status and metrics live in the dashboard's card rows.
function Toolbar(): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">◆ Goldilocks</Text>
      <Text dimColor>{' control panel '}</Text>
      <Text bold color="black" backgroundColor={ENV === 'prod' ? 'red' : 'green'}>
        {ENV === 'prod' ? ' PRODUCTION ' : ' DEVELOPMENT '}
      </Text>
    </Box>
  );
}

// The persistent bottom status bar — key hints on the left, any
// transient notice on the right, on a single line.
function StatusBar({ notice, hint }: { notice: string; hint: string }): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text dimColor>{hint}</Text>
      <Text color="yellow">{notice}</Text>
    </Box>
  );
}

// Full-screen application frame: a fixed toolbar on top, a fixed status
// bar on the bottom, and the active screen filling everything between.
function AppFrame({
  size,
  notice,
  hint,
  children,
}: {
  size: { columns: number; rows: number };
  notice: string;
  hint: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Toolbar />
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1} overflow="hidden">
        {children}
      </Box>
      <StatusBar notice={notice} hint={hint} />
    </Box>
  );
}

// A labelled section title (dim small-caps style).
function SectionLabel({ text }: { text: string }): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>{text.toUpperCase()}</Text>
    </Box>
  );
}

// Split an array into rows of at most `size` items.
function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

// Cards per row. Beyond this they flow onto the next line so the layout
// fits narrow / portrait terminals.
const MAX_CARDS_PER_ROW = 4;

// On/off service cards, wrapped at MAX_CARDS_PER_ROW. `flexWrap` lets a
// row degrade further if even four cards are too wide for the terminal.
function ServiceCards({ items }: { items: StatItem[] }): React.ReactElement {
  if (items.length === 0) {
    return <Text dimColor>checking…</Text>;
  }
  return (
    <Box flexDirection="column">
      {chunk(items, MAX_CARDS_PER_ROW).map((row, ri) => (
        <Box key={ri} flexWrap="wrap">
          {row.map((item) => (
            <Box
              key={item.label}
              flexDirection="column"
              borderStyle="round"
              borderColor={item.on ? 'green' : 'gray'}
              paddingX={1}
              marginRight={1}
              minWidth={15}
            >
              <Text dimColor>{item.label}</Text>
              <Text color={item.on ? 'green' : 'gray'}>{item.on ? '● running' : '○ stopped'}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// Metric cards (label + big value), wrapped at MAX_CARDS_PER_ROW — e.g.
// five metrics render as a row of four plus one on the next line.
function MetricCards({ cards }: { cards: { label: string; value: string }[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {chunk(cards, MAX_CARDS_PER_ROW).map((row, ri) => (
        <Box key={ri} flexWrap="wrap">
          {row.map((card) => (
            <Box
              key={card.label}
              flexDirection="column"
              borderStyle="round"
              borderColor="cyan"
              paddingX={1}
              marginRight={1}
              minWidth={15}
            >
              <Text dimColor>{card.label}</Text>
              <Text bold>{card.value}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// A bordered panel of text lines.
function Panel({
  title,
  lines,
  color = 'gray',
}: {
  title: string;
  lines: string[];
  color?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text dimColor>{title}</Text>
      {lines.length > 0 ? (
        lines.map((line, i) => <Text key={i}>{line === '' ? ' ' : line}</Text>)
      ) : (
        <Text dimColor>(empty)</Text>
      )}
    </Box>
  );
}

// Arrow-key menu. Up/down (or k/j) move, Enter selects.
function SelectList<T>({
  choices,
  onSelect,
}: {
  choices: Choice<T>[];
  onSelect: (value: T) => void;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  const max = choices.length;
  const active = max === 0 ? 0 : Math.min(index, max - 1);

  useInput((input, key) => {
    if (max === 0) return;
    if (key.upArrow || input === 'k') {
      setIndex((active - 1 + max) % max);
    } else if (key.downArrow || input === 'j') {
      setIndex((active + 1) % max);
    } else if (key.return) {
      const chosen = choices[active];
      if (chosen) onSelect(chosen.value);
    }
  });

  return (
    <Box flexDirection="column">
      {choices.map((choice, i) => {
        const isActive = i === active;
        return (
          <Box key={i}>
            <Text color={isActive ? 'cyan' : undefined}>
              {isActive ? '❯ ' : '  '}
              {choice.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface RunState {
  title: string;
  lines: string[];
  done: boolean;
  exitCode: number | null;
  returnTo: string;
}

// Streaming command-output view.
function RunningView({
  run,
  onStop,
  onDismiss,
}: {
  run: RunState;
  onStop: () => void;
  onDismiss: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (run.done && key.return) onDismiss();
    else if (!run.done && (input === 'q' || key.escape)) onStop();
  });
  const visible = run.lines.slice(-16);
  const borderColor = run.done ? (run.exitCode === 0 ? 'green' : 'red') : 'yellow';
  return (
    <Box flexDirection="column">
      <Text bold>{run.title}</Text>
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginTop={1}>
        {visible.length > 0 ? (
          visible.map((line, i) => <Text key={i}>{truncate(line, 110)}</Text>)
        ) : (
          <Text dimColor>starting…</Text>
        )}
      </Box>
      <Box marginTop={1}>
        {run.done ? (
          <Text color={run.exitCode === 0 ? 'green' : 'red'}>
            {run.exitCode === 0 ? '✓ finished' : `✗ exit code ${run.exitCode}`} — press enter to return
          </Text>
        ) : (
          <Text color="yellow">running… press q to stop</Text>
        )}
      </Box>
    </Box>
  );
}

interface ConfirmState {
  message: string;
  onYes: () => void;
}

function ConfirmView({
  state,
  onResolve,
}: {
  state: ConfirmState;
  onResolve: (yes: boolean) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="yellow">{state.message}</Text>
      </Box>
      <SelectList
        choices={[
          { label: 'No', value: false },
          { label: 'Yes', value: true },
        ]}
        onSelect={onResolve}
      />
    </Box>
  );
}

interface InputState {
  prompt: string;
  value: string;
  // When true, the entry is rendered as dots — used for secret keys.
  mask?: boolean;
  onSubmit: (value: string) => void;
}

function InputView({
  state,
  onChange,
  onSubmit,
  onCancel,
}: {
  state: InputState;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.return) {
      onSubmit();
    } else if (key.escape) {
      onCancel();
    } else if (key.backspace || key.delete) {
      onChange(state.value.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) {
      onChange(state.value + input);
    }
  });
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>{state.prompt}</Text>
      </Box>
      <Box>
        <Text color="cyan">{'> '}</Text>
        <Text>{state.mask ? '•'.repeat(state.value.length) : state.value}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter submit · esc cancel</Text>
      </Box>
    </Box>
  );
}

// --- the dashboard app -----------------------------------------------------

// A command queued to run inside the dashboard's streaming runner.
interface CommandSpec {
  title: string;
  command: string;
  args: string[];
  cwd?: string;
  returnTo: string;
  preLines?: string[];
  finalize?: (code: number, append: (line: string) => void) => Promise<void>;
}

function App({ initialEnv }: { initialEnv: Env | null }): React.ReactElement {
  const { exit } = useApp();
  const size = useTerminalSize();

  const firstScreen = ((): string => {
    if (!initialEnv) return 'env-picker';
    return envFileExists() ? 'dashboard' : 'setup-prompt';
  })();

  const [screen, setScreen] = useState<string>(firstScreen);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string>('');
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  // Backups screen — snapshot list + image-built flag + last error.
  // Loaded async by the effect below so the screen renders instantly
  // and shows a "Loading…" placeholder instead of blocking the terminal
  // on a synchronous `docker run`. `error` carries an actionable
  // string when the fetch fails (timeout, locked repo, etc).
  const [backupsState, setBackupsState] = useState<{
    snapshots: ResticSnapshot[];
    imageBuilt: boolean;
    loaded: boolean;
    error: string | null;
  }>({ snapshots: [], imageBuilt: false, loaded: false, error: null });
  const [running, setRunning] = useState<RunState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [inputState, setInputState] = useState<InputState | null>(null);
  const childRef = useRef<ChildProcess | null>(null);

  const isRunning = running !== null;

  const go = (next: string): void => {
    setNotice('');
    setScreen(next);
  };
  const refresh = (): void => setTick((t) => t + 1);

  // Poll the dashboard data continuously so the toolbar's live service
  // status and metrics stay accurate on every screen.
  useEffect(() => {
    if (isRunning) return undefined;
    let mounted = true;
    const load = async (): Promise<void> => {
      const data = await collectDashboard();
      if (mounted) setDash(data);
    };
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [screen, isRunning, tick]);

  // Load the admin list when an admin screen is open.
  useEffect(() => {
    if (screen !== 'admins' && screen !== 'admin-remove') return undefined;
    let mounted = true;
    withDb(loadAdmins)
      .then((rows) => mounted && setAdmins(rows))
      .catch(() => mounted && setAdmins([]));
    return () => {
      mounted = false;
    };
  }, [screen, tick]);

  // Load the client list when the clients screen is open.
  useEffect(() => {
    if (screen !== 'clients') return undefined;
    let mounted = true;
    withDb(loadClients)
      .then((rows) => mounted && setClients(rows))
      .catch(() => mounted && setClients([]));
    return () => {
      mounted = false;
    };
  }, [screen, tick]);

  // Load restic snapshot list + backup-image presence when the Backups
  // screen opens. Async so the screen renders instantly with a
  // "Loading…" placeholder instead of blocking on `docker run` in the
  // render path. tick re-fetches on Refresh.
  useEffect(() => {
    if (screen !== 'backups') return undefined;
    let mounted = true;
    setBackupsState((prev) => ({ ...prev, loaded: false }));
    Promise.all([listSnapshotsAsync(), backupImageBuiltAsync()])
      .then(([result, imageBuilt]) => {
        if (!mounted) return;
        setBackupsState({
          snapshots: result.snapshots,
          imageBuilt,
          loaded: true,
          error: result.error,
        });
      })
      .catch((e) => {
        if (!mounted) return;
        setBackupsState({
          snapshots: [],
          imageBuilt: false,
          loaded: true,
          error: (e as Error).message,
        });
      });
    return () => {
      mounted = false;
    };
  }, [screen, tick]);

  // Stream a command's output into the runner panel.
  const startCommand = (spec: CommandSpec): void => {
    mkdirSync(devRunDir(), { recursive: true });
    let logFd: number | null = null;
    try {
      logFd = openSync(join(devRunDir(), `command-${timestamp()}.log`), 'w');
    } catch {
      logFd = null;
    }
    const writeLog = (line: string): void => {
      if (logFd !== null) {
        try {
          writeSync(logFd, `${line}\n`);
        } catch {
          // best-effort
        }
      }
    };
    for (const line of spec.preLines ?? []) writeLog(line);
    const append = (line: string): void => {
      writeLog(line);
      setRunning((r) => (r ? { ...r, lines: [...r.lines, line].slice(-600) } : r));
    };
    setRunning({
      title: spec.title,
      lines: spec.preLines ?? [],
      done: false,
      exitCode: null,
      returnTo: spec.returnTo,
    });
    const child = spawnStream(
      spec.command,
      spec.args,
      spec.cwd ?? REPO_ROOT,
      append,
      (code) => {
        const finishUp = async (): Promise<void> => {
          if (spec.finalize) {
            try {
              await spec.finalize(code, append);
            } catch (err) {
              append(`finalize error: ${(err as Error).message}`);
            }
          }
          if (logFd !== null) {
            try {
              closeSync(logFd);
            } catch {
              // ignore
            }
          }
          childRef.current = null;
          setRunning((r) => (r ? { ...r, done: true, exitCode: code } : r));
        };
        void finishUp();
      },
    );
    childRef.current = child;
  };

  const stopCommand = (): void => {
    try {
      childRef.current?.kill('SIGTERM');
    } catch {
      // ignore
    }
  };

  const dismissCommand = (): void => {
    const returnTo = running?.returnTo ?? 'dashboard';
    setRunning(null);
    refresh();
    go(returnTo);
  };

  // --- environment + setup -------------------------------------------------

  const pickEnv = (chosen: Env): void => {
    ENV = chosen;

    // F3 — if the sealed env is newer than the plaintext (or the
    // plaintext doesn't exist), auto-unseal so the operator never has
    // to think about the encryption layer day-to-day. Silent on success;
    // failures surface as a notice so they're not invisible.
    if (sealedNewerThanPlain() && existsSync(ageKeyFile())) {
      const res = unsealEnvSync();
      if (!res.ok) {
        setNotice(`Auto-unseal failed: ${res.message}`);
      }
    }

    if (envFileExists()) {
      loadEnv({ path: envFilePath(), override: true });
      go('dashboard');
    } else {
      go('setup-prompt');
    }
  };

  const finishSetup = (xmtpUrl: string): void => {
    try {
      const content = buildEnvContent(xmtpUrl);
      writeFileSync(envFilePath(), content, { mode: 0o600 });
      chmodSync(envFilePath(), 0o600);
      loadEnv({ path: envFilePath(), override: true });

      // Generate the restic passphrase if it isn't already on disk.
      // Backups → View backup passphrase opens this file so the operator
      // can copy it into their password manager once.
      const restic = ensureResticPassphrase();
      const resticPart = restic.created
        ? ` Generated restic passphrase at ${restic.path} — save it to your password manager (Backups → View backup passphrase).`
        : '';

      // F3 + F5 — generate the SOPS age key + TLS material. Both need
      // the backup image (for age-keygen and the step CLI). On a fresh
      // checkout the image isn't built yet, so kick off the build now
      // and finish the rest in the finalize callback — that way the
      // operator clicks Run setup once and walks away.
      const envHeader = ENV === 'prod'
        ? 'Wrote .env.prod — back up AGENT_DB_ENCRYPTION_KEY, losing it loses the agents.'
        : 'Wrote .env.dev — dev defaults cover everything else.';

      if (!backupImageBuilt()) {
        runDocker(
          'Building backup image (one-time, ~1 min) — setup will continue after',
          ['--profile', 'backup', 'build', 'backup'],
          'settings',
          {
            finalize: async (code, append) => {
              if (code !== 0) {
                append('');
                append('Backup image build failed. Once Docker is healthy, re-run Settings → Run setup.');
                return;
              }
              append('');
              append('Image built. Finishing setup (age key + TLS material)…');
              const finalizeMessage = finalizeKeysAndTls();
              append(finalizeMessage);
              setNotice(`${envHeader}${resticPart} ${finalizeMessage}`.trim());
            },
          },
        );
        return;
      }

      const sopsAndTlsMessage = finalizeKeysAndTls();
      setNotice(`${envHeader}${resticPart} ${sopsAndTlsMessage}`.trim());
      setScreen('dashboard');
      refresh();
    } catch (err) {
      setNotice(`Setup failed: ${(err as Error).message}`);
      setScreen('settings');
    }
  };

  // Generates the SOPS age key, writes .sops.yaml, seals .env.<env>,
  // and mints the TLS CA + postgres leaf. Used by finishSetup both in
  // the synchronous path (image already built) and in the post-build
  // finalize callback (image just built). Returns a notice fragment.
  //
  // Idempotent: each step short-circuits if the artifact is already in
  // place. Crucially, the seal step runs whenever the sealed file is
  // missing OR older than the just-written .env.<env>, so a re-run of
  // Setup keeps the encrypted copy in sync with the regenerated plain
  // env file.
  const finalizeKeysAndTls = (): string => {
    const fragments: string[] = [];
    try {
      const age = ensureAgeKey();
      ensureSopsConfig();
      if (age.created && age.recipient) {
        fragments.push(`Minted age key (recipient ${age.recipient.slice(0, 12)}…).`);
      } else if (age.created) {
        fragments.push('Age key created, but recipient could not be read — manual seal may be needed.');
      }

      // Always seal if the sealed file doesn't exist yet OR if the plain
      // env is newer (e.g. Setup just regenerated it). This is the fix
      // for the re-run drift case where a second Setup call would
      // otherwise leave secrets/<env>.env.enc stale.
      if (existsSync(envFilePath()) && existsSync(ageKeyFile())) {
        const sealedExists = existsSync(sealedEnvFile());
        const needsSeal = !sealedExists || !sealedNewerThanPlain();
        if (needsSeal) {
          const seal = sealEnvSync();
          fragments.push(seal.ok ? 'Sealed .env into the encrypted copy.' : `Seal failed: ${seal.message}`);
        }
      }

      const tls = ensureTlsSync();
      if (tls.created) {
        fragments.push('Generated TLS material in secrets/tls/.');
      } else if (!tls.ok) {
        fragments.push(`TLS setup failed: ${tls.message}`);
      }
    } catch (err) {
      fragments.push(`Keys/TLS step errored: ${(err as Error).message}`);
    }
    return fragments.join(' ');
  };

  const startSetup = (): void => {
    const proceed = (): void => {
      if (ENV === 'prod') {
        setInputState({
          prompt: 'XMTP production gRPC endpoint (leave blank to fill in later):',
          value: '',
          onSubmit: (v) => {
            setInputState(null);
            finishSetup(v.trim());
          },
        });
      } else {
        finishSetup('');
      }
    };
    if (envFileExists()) {
      setConfirmState({ message: `.env.${ENV} already exists. Overwrite it?`, onYes: proceed });
    } else {
      proceed();
    }
  };

  // --- command builders ----------------------------------------------------

  const runDocker = (title: string, rest: string[], returnTo: string, spec?: Partial<CommandSpec>): void => {
    const { command, args } = dockerComposeSpawn(rest);
    startCommand({ title, command, args, returnTo, ...spec });
  };
  const runBash = (title: string, name: string, args: string[], returnTo: string, spec?: Partial<CommandSpec>): void => {
    startCommand({ title, command: 'bash', args: [scriptPath(name), ...args], returnTo, ...spec });
  };

  const devUp = (): void => {
    runBash('Start dev environment', 'dev-env.sh', ['up'], 'systems', {
      finalize: async (code, append) => {
        if (code !== 0) {
          append('dev-env.sh failed — not starting the server/agents.');
          return;
        }
        append('');
        // Sync the webhook secret before the server boots so it reads it.
        append(syncStripeWebhookSecret());
        append('');
        append('Starting the backend server, agents, and simulator-log mirror…');
        append(startDevProcess('server', 'npm', ['run', 'server:dev']));
        append(startDevProcess('agent', 'npm', ['run', 'agents:dev']));
        append(startDevProcess('simulator', 'npm', ['run', 'logs:sim']));
        await startAndTrustCaddy(append);
        append(startStripeListener());
        append('');
        append('Dev environment is up.');
      },
    });
  };

  const devDown = (): void => {
    const preLines = [
      'Stopping the backend server, agents, simulator-log mirror, Caddy, and Stripe listener…',
      stopDevProcess('server'),
      stopDevProcess('agent'),
      stopDevProcess('simulator'),
      stopDevProcess('caddy'),
      stopDevProcess('stripe'),
      '',
    ];
    runBash('Stop dev environment', 'dev-env.sh', ['down'], 'systems', { preLines });
  };

  const devReset = (): void => {
    const preLines = [
      stopDevProcess('server'),
      stopDevProcess('agent'),
      stopDevProcess('simulator'),
      stopDevProcess('caddy'),
      stopDevProcess('stripe'),
      '',
    ];
    runBash('Reset dev environment', 'dev-env.sh', ['reset'], 'systems', { preLines });
  };

  // Bounce just the node processes + Caddy so edited code is picked up,
  // leaving Docker (db) and the simulator-log mirror untouched. The brief
  // sleep gives the SIGTERM'd processes a moment to release their ports.
  const devRestart = (): void => {
    const preLines = [
      'Stopping the backend server, agents, and Caddy…',
      stopDevProcess('server'),
      stopDevProcess('agent'),
      stopDevProcess('caddy'),
      '',
    ];
    startCommand({
      title: 'Restart server + agents + caddy',
      command: 'sleep',
      args: ['1'],
      returnTo: 'systems',
      preLines,
      finalize: async (code, append) => {
        if (code !== 0) {
          append('Restart cancelled — server, agents, and Caddy left stopped.');
          return;
        }
        append('Starting the backend server, agents, and Caddy…');
        append(startDevProcess('server', 'npm', ['run', 'server:dev']));
        append(startDevProcess('agent', 'npm', ['run', 'agents:dev']));
        await startAndTrustCaddy(append);
        append('');
        append('Server, agents, and Caddy restarted.');
      },
    });
  };

  // --- screen rendering ----------------------------------------------------

  // Each screen builds its own body element; renderScreen() selects the
  // right one and App wraps it in the persistent full-screen frame.
  const renderScreen = (): React.ReactElement => {
  // Overlays take priority over the normal screens.
  if (running) {
    return <RunningView run={running} onStop={stopCommand} onDismiss={dismissCommand} />;
  }
  if (confirmState) {
    return (
      <ConfirmView
        state={confirmState}
        onResolve={(yes) => {
          const cs = confirmState;
          setConfirmState(null);
          if (yes) cs.onYes();
        }}
      />
    );
  }
  if (inputState) {
    return (
      <InputView
        state={inputState}
        onChange={(value) => setInputState((s) => (s ? { ...s, value } : s))}
        onSubmit={() => inputState.onSubmit(inputState.value)}
        onCancel={() => setInputState(null)}
      />
    );
  }

  // Environment picker (shown when no --dev/--prod was given).
  if (screen === 'env-picker') {
    return (
      <Box flexDirection="column">
        <Text bold>Which environment?</Text>
        <SelectList
          key="env-picker"
          choices={[
            { label: 'Development', value: 'dev' as Env, hint: 'local XMTP node + dev database' },
            { label: 'Production', value: 'prod' as Env, hint: 'the docker-compose.prod.yml stack' },
          ]}
          onSelect={pickEnv}
        />
      </Box>
    );
  }

  // First-run setup prompt.
  if (screen === 'setup-prompt') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="yellow">{`No .env.${ENV} file found — the ${ENV} environment needs one.`}</Text>
        </Box>
        <Text bold>Set it up now?</Text>
        <SelectList
          key="setup-prompt"
          choices={[
            { label: 'Run setup', value: 'setup', hint: 'create the .env file + secrets' },
            { label: 'Quit', value: 'quit' },
          ]}
          onSelect={(v) => (v === 'setup' ? startSetup() : exit())}
        />
      </Box>
    );
  }

  // Main dashboard.
  if (screen === 'dashboard') {
    const metricCards = [
      { label: 'Installs', value: dash?.installs != null ? String(dash.installs) : '—' },
      { label: 'Total seats', value: dash?.seats ? String(dash.seats.totalSeats) : '—' },
      { label: 'Clients w/ seats', value: dash?.seats ? String(dash.seats.clientsWithSeats) : '—' },
      { label: 'Admins', value: dash?.admins != null ? String(dash.admins) : '—' },
    ];
    const menu: Choice<string>[] = [
      { label: 'Admins', value: 'admins', hint: 'add / remove admin slots' },
      // Backups works in both envs — the dev path runs the restic repo
      // at ./backups/restic-dev/ and exposes Run / Restore / Verify /
      // restore-drill against the live dev stack.
      { label: 'Backups', value: 'backups', hint: 'list, run, restore, restore drill' },
      { label: 'Clients', value: 'clients', hint: 'view client plans' },
      { label: 'Payments', value: 'payments', hint: 'Stripe keys + webhook config' },
    ];
    if (ENV === 'prod') {
      menu.push({ label: 'Deploy', value: 'deploy', hint: 'pull, preflight, build, migrate, restart' });
      menu.push({ label: 'Production stack', value: 'stack', hint: 'status, start / stop, restart' });
      menu.push({ label: 'Cloudflare tunnel', value: 'tunnel', hint: 'start / stop, public URL' });
    }
    menu.push({ label: 'Security', value: 'security', hint: 'pinning, TTLs, sealed-env, mTLS' });
    menu.push({ label: 'Settings', value: 'settings', hint: '.env config' });
    if (ENV === 'dev') {
      menu.push({ label: 'Systems', value: 'systems', hint: 'start / stop the dev environment' });
    }
    menu.push({ label: 'Quit', value: 'quit' });

    const onSelect = (v: string): void => {
      if (v === 'quit') exit();
      else if (v === 'deploy') {
        setConfirmState({
          message: 'Run a full production deploy now? (pull, preflight, build, migrate, restart)',
          onYes: () => runBash('Deploy', 'deploy.sh', [], 'dashboard'),
        });
      } else go(v);
    };

    return (
      <Box flexDirection="column">
        <SectionLabel text="Services" />
        <ServiceCards items={dash?.stats ?? []} />
        <SectionLabel text="Metrics" />
        <MetricCards cards={metricCards} />
        {ENV === 'prod' ? (
          <Box marginTop={1}>
            <Text dimColor>Public URL: </Text>
            <Text>{dash?.tunnelUrl ? dash.tunnelUrl : '(tunnel not running)'}</Text>
          </Box>
        ) : null}
        <SectionLabel text="Manage" />
        <SelectList key="dashboard" choices={menu} onSelect={onSelect} />
      </Box>
    );
  }

  // Security — one-stop screen for every toggle that doesn't need a
  // redeploy. Mirrors the layout in docs/security-architecture.md.
  if (screen === 'security') {
    const pins = readIosPinHashes();
    const pinMode = readIosPinMode();
    const secureWindowFlag = readSecureWindowDebugFlag();
    const envValues = envFileExists() ? readEnvFile() : {};
    const jwtTtl = envValues.JWT_TTL_SECONDS ?? '(default 3600)';
    const refreshTtl = envValues.REFRESH_TTL_DAYS ?? '(default 30)';
    const masterKey = envValues.APP_ENCRYPTION_KEY ?? '';
    const encV1 = (envValues.ENCRYPT_AT_REST_V1 ?? '').toLowerCase() === 'true';
    const tlsDir = join(REPO_ROOT, 'secrets/tls');
    const mtlsReady = existsSync(join(tlsDir, 'client-backend.crt'))
      && existsSync(join(tlsDir, 'client-agent.crt'))
      && existsSync(join(tlsDir, 'client-backup.crt'));

    const statusLines: string[] = [
      `iOS pin hashes: ${pins === null ? 'unreadable' : `${pins.length} pin(s)`}${pins && pins.length === 0 ? ' (inert — no pinning until ≥1 hash)' : ''}`,
      `iOS pinning mode: ${pinMode ?? 'unknown'}${pinMode === 'shadow' ? ' (logs only)' : ''}`,
      `iOS secure-window debug flag: ${secureWindowFlag === null ? 'unknown' : secureWindowFlag ? 'ON — screenshots NOT blocked in dev' : 'off — blocked everywhere'}`,
      `JWT access TTL: ${jwtTtl}s    Refresh TTL: ${refreshTtl}d`,
      `F4 ENCRYPT_AT_REST_V1: ${encV1 ? 'on' : 'off'}    APP_ENCRYPTION_KEY: ${masterKey.length === 64 ? 'present' : 'missing'}`,
      `F5 mTLS client certs: ${mtlsReady ? 'present' : 'missing — run init-tls'}`,
      `F3 sealed env: ${existsSync(sealedEnvFile()) ? (envFileExists() ? (sealedNewerThanPlain() ? 'sealed (no drift)' : 'plaintext newer — re-seal') : 'sealed') : 'not sealed'}`,
    ];

    const menuChoices: Choice<string>[] = [
      { label: 'Set iOS cert pins from a PEM file', value: 'pin-set', hint: 'compute SPKI hash + write CertificatePinner.swift' },
      { label: 'Clear iOS cert pins', value: 'pin-clear', hint: 'empties the hash set (pinner falls back to OS trust)' },
      { label: `Switch pinning mode (now: ${pinMode ?? '?'})`, value: 'pin-mode', hint: 'shadow ↔ enforce' },
      { label: `Toggle secure-window debug flag (now: ${secureWindowFlag === null ? '?' : secureWindowFlag ? 'ON' : 'off'})`, value: 'sw-flag', hint: 'Dev.xcconfig' },
      { label: 'Edit JWT access-token TTL', value: 'jwt-ttl', hint: 'unseal → set → reseal → shred' },
      { label: 'Edit refresh-token TTL', value: 'refresh-ttl', hint: 'unseal → set → reseal → shred' },
      { label: 'Seal + shred .env now', value: 'seal-shred', hint: 'force re-seal and delete plaintext' },
      { label: 'Reissue F5 mTLS client + server certs', value: 'mtls-init', hint: 'idempotent: keeps CA, mints missing leaves' },
      { label: 'Back', value: 'back' },
    ];

    const promptForString = (msg: string, onValue: (v: string) => void): void => {
      setInputState({
        prompt: msg,
        value: '',
        onSubmit: (raw) => {
          setInputState(null);
          onValue(raw.trim());
        },
      });
    };

    const onSelect = (v: string): void => {
      if (v === 'back') { go('dashboard'); return; }
      if (v === 'pin-set') {
        promptForString('Path to the cert PEM file (e.g. /tmp/api.goldilocksdigital.xyz.pem):', (pemPath) => {
          if (!pemPath) { setNotice('Cancelled.'); return; }
          const computed = computeSpkiHashFromPem(pemPath);
          if (!computed.ok || !computed.hash) { setNotice(`Hash failed: ${computed.message}`); return; }
          const existing = readIosPinHashes() ?? [];
          if (existing.includes(computed.hash)) {
            setNotice(`Pin ${computed.hash.slice(0, 12)}… already present.`);
            return;
          }
          const next = [...existing, computed.hash];
          const w = writeIosPinHashes(next);
          setNotice(w.ok
            ? `Added pin ${computed.hash.slice(0, 12)}… (${next.length} total). Rebuild iOS to apply.`
            : `Write failed: ${w.message}`);
          refresh();
        });
        return;
      }
      if (v === 'pin-clear') {
        setConfirmState({
          message: 'Clear ALL iOS pin hashes? The pinner will fall back to OS-default trust.',
          onYes: () => {
            const w = writeIosPinHashes([]);
            setNotice(w.ok ? 'Cleared all pin hashes.' : `Write failed: ${w.message}`);
            refresh();
          },
        });
        return;
      }
      if (v === 'pin-mode') {
        const next: 'shadow' | 'enforce' = pinMode === 'enforce' ? 'shadow' : 'enforce';
        setConfirmState({
          message: `Switch iOS pinning mode from .${pinMode ?? '?'} to .${next}? Rebuild iOS to apply.`,
          onYes: () => {
            const w = writeIosPinMode(next);
            setNotice(w.ok ? w.message : `Write failed: ${w.message}`);
            refresh();
          },
        });
        return;
      }
      if (v === 'sw-flag') {
        if (secureWindowFlag === null) { setNotice('Could not read Dev.xcconfig.'); return; }
        const next = !secureWindowFlag;
        const w = writeSecureWindowDebugFlag(next);
        setNotice(w.ok ? w.message : `Write failed: ${w.message}`);
        refresh();
        return;
      }
      if (v === 'jwt-ttl') {
        promptForString(`New JWT_TTL_SECONDS (current: ${jwtTtl}):`, (raw) => {
          if (!raw || !/^\d+$/.test(raw)) { setNotice('Cancelled — expected an integer number of seconds.'); return; }
          const r = editEnvKeyAndReseal('JWT_TTL_SECONDS', raw);
          setNotice(r.message);
          refresh();
        });
        return;
      }
      if (v === 'refresh-ttl') {
        promptForString(`New REFRESH_TTL_DAYS (current: ${refreshTtl}):`, (raw) => {
          if (!raw || !/^\d+$/.test(raw)) { setNotice('Cancelled — expected an integer number of days.'); return; }
          const r = editEnvKeyAndReseal('REFRESH_TTL_DAYS', raw);
          setNotice(r.message);
          refresh();
        });
        return;
      }
      if (v === 'seal-shred') {
        setConfirmState({
          message: `Re-seal ${envFilePath()} into ${sealedEnvFile()} and shred the plaintext?`,
          onYes: () => {
            const seal = sealEnvSync();
            if (!seal.ok) { setNotice(`Seal failed: ${seal.message}`); return; }
            const shred = shredPlaintextEnv();
            setNotice(`${seal.message} ${shred.message}`);
            refresh();
          },
        });
        return;
      }
      if (v === 'mtls-init') {
        runBash('Reissue F5 TLS material', 'init-tls.sh', [ENV], 'security');
        return;
      }
    };

    return (
      <Box flexDirection="column">
        <Text bold>Security</Text>
        <Box marginTop={1}>
          <Panel title={`Current state — env=${ENV}`} lines={statusLines} />
        </Box>
        <SectionLabel text="Actions" />
        <SelectList key="security" choices={menuChoices} onSelect={onSelect} />
      </Box>
    );
  }

  // Admins.
  if (screen === 'admins') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'remove') go('admin-remove');
      else if (v === 'add') {
        setInputState({
          prompt: 'New admin name:',
          value: '',
          onSubmit: (name) => {
            setInputState(null);
            const trimmed = name.trim();
            if (!trimmed) {
              setNotice('Cancelled — no name given.');
              return;
            }
            withDb((c) => addAdmin(c, trimmed))
              .then((code) => {
                setNotice(`Added "${trimmed}" — upgrade code ${formatCode(code)}. Hand it to them to claim admin.`);
                refresh();
              })
              .catch((err) => setNotice(`Failed: ${(err as Error).message}`));
          },
        });
      }
    };
    return (
      <Box flexDirection="column">
        <Text bold>Admins</Text>
        <Box marginTop={1}>
          <Panel title="Admin slots" lines={admins ? formatAdmins(admins) : ['loading…']} />
        </Box>
        <SectionLabel text="Actions" />
        <SelectList
          key="admins"
          choices={[
            { label: 'Add an admin', value: 'add', hint: 'creates a slot + upgrade code' },
            { label: 'Remove an admin', value: 'remove', hint: 'deletes the slot; the person loses admin' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={onSelect}
        />
      </Box>
    );
  }

  // Admin removal picker.
  if (screen === 'admin-remove') {
    const choices: Choice<AdminRow | null>[] = [
      ...(admins ?? []).map((a): Choice<AdminRow | null> => ({
        label: `${a.name}  (code ${formatCode(a.upgrade_code)})`,
        value: a,
      })),
      { label: 'Cancel', value: null },
    ];
    const onSelect = (row: AdminRow | null): void => {
      if (!row) {
        go('admins');
        return;
      }
      setConfirmState({
        message: `Remove "${row.name}"? The upgrade code stops working and they lose admin.`,
        onYes: () => {
          withDb((c) => removeAdmin(c, row.id))
            .then(() => {
              setNotice(`Removed "${row.name}".`);
              refresh();
              setScreen('admins');
            })
            .catch((err) => setNotice(`Failed: ${(err as Error).message}`));
        },
      });
    };
    return (
      <Box flexDirection="column">
        <Text bold>Remove an admin</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>{admins && admins.length === 0 ? 'No admin slots to remove.' : 'Pick the slot to delete.'}</Text>
        </Box>
        <SelectList key="admin-remove" choices={choices} onSelect={onSelect} />
      </Box>
    );
  }

  // Clients (read-only).
  if (screen === 'clients') {
    return (
      <Box flexDirection="column">
        <Text bold>Clients</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>Plans are chosen by clients in the app — this is a read-only view.</Text>
        </Box>
        <Panel title="Registered clients" lines={clients ? formatClients(clients) : ['loading…']} />
        <SectionLabel text="Actions" />
        <SelectList
          key="clients"
          choices={[
            { label: 'Refresh', value: 'refresh' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={(v) => (v === 'back' ? go('dashboard') : refresh())}
        />
      </Box>
    );
  }

  // Payments — Stripe + crypto.
  if (screen === 'payments') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'stripe') go('payments-stripe');
      else if (v === 'crypto') go('payments-crypto');
    };
    return (
      <Box flexDirection="column">
        <Text bold>Payments</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>How clients pay. Stripe handles cards; crypto is not wired up yet.</Text>
        </Box>
        <SelectList
          key="payments"
          choices={[
            { label: 'Stripe', value: 'stripe', hint: 'keys, webhook, checkout URLs' },
            { label: 'Crypto', value: 'crypto', hint: 'no provider yet' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={onSelect}
        />
      </Box>
    );
  }

  // Payments — crypto (a dead end until a provider is chosen).
  if (screen === 'payments-crypto') {
    return (
      <Box flexDirection="column">
        <Text bold>Crypto payments</Text>
        <Box marginTop={1}>
          <Panel
            title="Not available"
            lines={[
              'No crypto payment provider has been chosen yet.',
              '',
              'Crypto checkout is stubbed across the stack: the iOS',
              'Subscription screen shows it as "coming soon", and the',
              'backend rejects crypto checkout requests.',
              '',
              'There is nothing to configure here until a provider is picked.',
            ]}
          />
        </Box>
        <SectionLabel text="Actions" />
        <SelectList
          key="payments-crypto"
          choices={[{ label: 'Back', value: 'back' }]}
          onSelect={() => go('payments')}
        />
      </Box>
    );
  }

  // Payments — Stripe config. Reads + writes the STRIPE_* keys in .env.
  if (screen === 'payments-stripe') {
    if (!envFileExists()) {
      return (
        <Box flexDirection="column">
          <Text bold>Stripe</Text>
          <Box marginTop={1} marginBottom={1}>
            <Text color="yellow">{`No .env.${ENV} yet — run setup first (Settings → Run setup).`}</Text>
          </Box>
          <SelectList
            key="payments-stripe-nofile"
            choices={[{ label: 'Back', value: 'back' }]}
            onSelect={() => go('payments')}
          />
        </Box>
      );
    }

    const cfg = readStripeConfig();
    const listenerRunning = ENV === 'dev' && devProcessPid('stripe') !== null;

    const promptFor = (key: string, label: string, prompt: string, mask: boolean): void => {
      setInputState({
        prompt,
        value: '',
        mask,
        onSubmit: (raw) => {
          setInputState(null);
          const value = raw.trim();
          try {
            writeEnvKey(key, value);
            loadEnv({ path: envFilePath(), override: true });
            setNotice(value ? `${label} saved to .env.${ENV}.` : `${label} cleared.`);
            refresh();
          } catch (err) {
            setNotice(`Failed to save ${label}: ${(err as Error).message}`);
          }
        },
      });
    };

    const onSelect = (v: string): void => {
      if (v === 'back') go('payments');
      else if (v === 'secret') {
        promptFor(
          STRIPE_KEYS.secret,
          'Secret key',
          `Stripe secret key — ${ENV === 'prod' ? 'sk_live_…' : 'sk_test_…'} (blank to clear):`,
          true,
        );
      } else if (v === 'webhook') {
        promptFor(
          STRIPE_KEYS.webhook,
          'Webhook secret',
          'Stripe webhook signing secret — whsec_… (blank to clear):',
          true,
        );
      } else if (v === 'success') {
        promptFor(STRIPE_KEYS.success, 'Success URL', 'Checkout success URL (blank for the default):', false);
      } else if (v === 'cancel') {
        promptFor(STRIPE_KEYS.cancel, 'Cancel URL', 'Checkout cancel URL (blank for the default):', false);
      } else if (v === 'dashboard') {
        const url = ENV === 'prod'
          ? 'https://dashboard.stripe.com/apikeys'
          : 'https://dashboard.stripe.com/test/apikeys';
        openInOS([url]);
        setNotice('Opened the Stripe API keys page in your browser.');
      } else if (v === 'listener') {
        if (devProcessPid('stripe') !== null) {
          setNotice(stopDevProcess('stripe'));
        } else {
          const secretNote = syncStripeWebhookSecret();
          setNotice(`${secretNote}  ${startStripeListener()}`);
        }
        refresh();
      }
    };

    const actions: Choice<string>[] = [
      { label: 'Set secret key', value: 'secret', hint: 'sk_test_… / sk_live_…' },
      { label: 'Set webhook secret', value: 'webhook', hint: 'whsec_…' },
      { label: 'Set checkout success URL', value: 'success', hint: 'optional' },
      { label: 'Set checkout cancel URL', value: 'cancel', hint: 'optional' },
    ];
    if (ENV === 'dev') {
      actions.push({
        label: listenerRunning ? 'Stop webhook listener' : 'Start webhook listener',
        value: 'listener',
        hint: listenerRunning ? 'stripe listen — running' : 'runs stripe listen',
      });
    }
    actions.push({ label: 'Open Stripe dashboard', value: 'dashboard', hint: 'API keys page' });
    actions.push({ label: 'Back', value: 'back' });

    return (
      <Box flexDirection="column">
        <Text bold>Stripe</Text>
        <Box marginTop={1}>
          <Panel
            title={`Configuration — .env.${ENV}`}
            lines={formatStripeConfig(cfg)}
            color={stripeReady(cfg) ? 'green' : 'yellow'}
          />
        </Box>
        {ENV === 'dev' ? (
          <Box marginTop={1}>
            <Text dimColor>Webhook listener: </Text>
            <Text color={listenerRunning ? 'green' : 'gray'}>{listenerRunning ? '● running' : '○ stopped'}</Text>
            <Text dimColor>{`  →  localhost:${devServerPort()}/api/v2/stripe/webhook`}</Text>
          </Box>
        ) : null}
        <SectionLabel text="Actions" />
        <SelectList key="payments-stripe" choices={actions} onSelect={onSelect} />
      </Box>
    );
  }

  // Systems (dev environment start/stop). Backup lives in the dedicated
  // Backups screen (restic-based) — Systems is just lifecycle now.
  if (screen === 'systems') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'up') devUp();
      else if (v === 'down') devDown();
      else if (v === 'restart') devRestart();
      else if (v === 'reset') {
        setConfirmState({
          message: 'Stop everything and wipe the dev database, agent keys, and simulator installs?',
          onYes: devReset,
        });
      }
    };
    return (
      <Box flexDirection="column">
        <Text bold>Systems</Text>
        <SectionLabel text="Services" />
        <ServiceCards items={dash?.stats ?? []} />
        <SectionLabel text="Actions" />
        <SelectList
          key="systems"
          choices={[
            { label: 'Start', value: 'up', hint: 'node, db, migrations, server, agents' },
            { label: 'Stop', value: 'down', hint: 'stops everything; data is kept' },
            { label: 'Restart', value: 'restart', hint: 'bounce server + agents to pick up code changes' },
            { label: 'Reset', value: 'reset', hint: 'stop, then wipe the dev db, keys, sims' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={onSelect}
        />
      </Box>
    );
  }

  // Production stack.
  if (screen === 'stack') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'status') runDocker('Stack status', ['ps'], 'stack');
      else if (v === 'up') {
        runDocker('Start production stack', ['up', '-d'], 'stack', {
          finalize: (_code, append) => finalizeTunnel('', append),
        });
      } else if (v === 'down') {
        setConfirmState({
          message: 'Stop the whole production stack? (data volumes are kept)',
          onYes: () => runDocker('Stop production stack', ['down'], 'stack'),
        });
      } else if (v === 'restart') go('stack-restart');
      else if (v === 'logs') go('stack-logs');
    };
    return (
      <Box flexDirection="column">
        <Text bold>Production stack</Text>
        <SectionLabel text="Services" />
        <ServiceCards items={dash?.stats ?? []} />
        <SectionLabel text="Actions" />
        <SelectList
          key="stack"
          choices={[
            { label: 'Status', value: 'status' },
            { label: 'Start', value: 'up', hint: 'start all services' },
            { label: 'Stop everything', value: 'down', hint: 'containers stop; volumes kept' },
            { label: 'Restart a service', value: 'restart' },
            { label: 'Stream logs', value: 'logs' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={onSelect}
        />
      </Box>
    );
  }

  // Production stack — restart-service picker.
  if (screen === 'stack-restart') {
    const choices: Choice<string | null>[] = [
      ...PROD_SERVICES.map((s): Choice<string | null> => ({ label: s, value: s })),
      { label: 'Cancel', value: null },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Restart which service?</Text>
        <Box marginTop={1}>
          <SelectList
            key="stack-restart"
            choices={choices}
            onSelect={(svc) => {
              if (!svc) go('stack');
              else runDocker(`Restart ${svc}`, ['restart', svc], 'stack');
            }}
          />
        </Box>
      </Box>
    );
  }

  // Production stack — stream-logs picker.
  if (screen === 'stack-logs') {
    const choices: Choice<string | null>[] = [
      ...PROD_SERVICES.map((s): Choice<string | null> => ({ label: s, value: s })),
      { label: 'Cancel', value: null },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Stream logs for which service?</Text>
        <Box marginTop={1}>
          <SelectList
            key="stack-logs"
            choices={choices}
            onSelect={(svc) => {
              if (!svc) go('stack');
              else runDocker(`Logs: ${svc}`, ['logs', '-f', '--tail', '100', svc], 'stack');
            }}
          />
        </Box>
      </Box>
    );
  }

  // Cloudflare tunnel.
  if (screen === 'tunnel') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'url') runBash('Tunnel URL', 'tunnel-url.sh', [], 'tunnel');
      else if (v === 'start') {
        runDocker('Start tunnel', ['up', '-d', 'cloudflared'], 'tunnel', {
          finalize: (_code, append) => finalizeTunnel('', append),
        });
      } else if (v === 'stop') runDocker('Stop tunnel', ['stop', 'cloudflared'], 'tunnel');
      else if (v === 'restart') {
        setConfirmState({
          message: 'Restarting issues a NEW tunnel URL — the iOS app must be rebuilt. Continue?',
          onYes: () => {
            void getTunnelUrl().then((before) => {
              runDocker('Restart tunnel', ['restart', 'cloudflared'], 'tunnel', {
                finalize: (_code, append) => finalizeTunnel(before, append),
              });
            });
          },
        });
      } else if (v === 'ios') {
        void getTunnelUrl().then((url) => {
          if (!url) setNotice('No tunnel URL yet — start the tunnel first.');
          else setNotice(syncIosConfig(url).join('  '));
        });
      }
    };
    return (
      <Box flexDirection="column">
        <Text bold>Cloudflare tunnel</Text>
        <Box marginTop={1}>
          <Text dimColor>Public URL: </Text>
          <Text>{dash?.tunnelUrl ? dash.tunnelUrl : '(not running)'}</Text>
        </Box>
        <SectionLabel text="Actions" />
        <SelectList
          key="tunnel"
          choices={[
            { label: 'Show current public URL', value: 'url' },
            { label: 'Start tunnel', value: 'start' },
            { label: 'Stop tunnel', value: 'stop' },
            { label: 'Restart tunnel', value: 'restart', hint: 'issues a NEW url' },
            { label: 'Point the iOS app at this backend', value: 'ios', hint: 'updates config.prod.json' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={onSelect}
        />
      </Box>
    );
  }

  // Backups. Lists restic snapshots and exposes Run / Restore / Verify /
  // Pull / setup-style actions. The full design lives in
  // docs/encryption-and-backup-plan.md (F1/F2/F6/F7/F9).
  if (screen === 'backups') {
    const { snapshots, imageBuilt, loaded, error: backupsError } = backupsState;
    const runs = groupBackupRuns(snapshots);
    const passphraseExists = existsSync(resticPassphraseFile());

    // Render a tight placeholder until the async load finishes. Avoids
    // blocking the terminal on `docker run`. The fetch itself has a
    // 15s hard timeout so this can't hang forever.
    if (!loaded) {
      return (
        <Box flexDirection="column">
          <Text bold>Backups</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Loading snapshots…</Text>
            <Text dimColor>(15s timeout — if this sticks, Docker may not be running.)</Text>
          </Box>
        </Box>
      );
    }

    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'refresh') refresh();
      else if (v === 'generate-passphrase') {
        const result = ensureResticPassphrase();
        if (result.created) {
          setNotice(`Generated restic passphrase at ${result.path}. Open it (View backup passphrase) and save the value to your password manager.`);
        } else {
          setNotice(`Passphrase already exists at ${result.path}.`);
        }
        refresh();
      } else if (v === 'view-passphrase') {
        openInOS(['-t', resticPassphraseFile()]);
        setNotice(`Opened ${resticPassphraseFile()} in your default editor. Copy the value to your password manager and close without changes.`);
      } else if (v === 'build-image') {
        runDocker(
          'Build backup image (one-time, ~1 min)',
          ['--profile', 'backup', 'build', 'backup'],
          'backups',
        );
      } else if (v === 'run') {
        runDocker(
          'Run a backup',
          ['--profile', 'backup', 'run', '--rm', 'backup'],
          'backups',
        );
      } else if (v === 'restore-latest') {
        const latest = runs[0];
        if (!latest) {
          setNotice('No snapshots to restore from — run a backup first.');
          return;
        }
        setConfirmState({
          message: `Restore the latest snapshot (${latest.snapshotId}, ${latest.time})? This will overwrite the current database and volumes. The stack must be stopped first.`,
          onYes: () =>
            startCommand({
              title: `Restore latest — ${latest.snapshotId}`,
              command: 'bash',
              args: [
                scriptPath('restore.sh'),
                '--env', ENV,
                '--yes',
                resticRepoDir(),
                latest.snapshotId,
              ],
              returnTo: 'backups',
            }),
        });
      } else if (v === 'restore-pick') {
        go('restore-snapshot');
      } else if (v === 'verify') {
        startCommand({
          title: 'Verify backup integrity (restic check)',
          command: 'docker',
          args: resticDockerArgs(['check', '--read-data'], true),
          returnTo: 'backups',
        });
      } else if (v === 'pull') {
        startCommand({
          title: 'Pull latest snapshots to laptop',
          command: 'bash',
          args: [scriptPath('pull-latest-backup.sh')],
          returnTo: 'backups',
        });
      } else if (v === 'unlock') {
        startCommand({
          title: 'Unlock restic repo',
          command: 'docker',
          args: resticDockerArgs(['unlock'], false),
          returnTo: 'backups',
        });
      } else if (v === 'drill') {
        setConfirmState({
          message: 'Run the end-to-end restore drill? Backs up, restores into a parallel goldilocks-restore-test project, runs a smoke probe, then tears it down. Takes ~2 minutes.',
          onYes: () =>
            startCommand({
              title: 'Restore drill',
              command: 'bash',
              args: [join(REPO_ROOT, 'dev', 'restore-drill')],
              returnTo: 'backups',
            }),
        });
      } else if (v === 'open') {
        openInOS([join(REPO_ROOT, 'backups')]);
        setNotice('Opened the backups folder in Finder.');
      }
    };

    const choices: Choice<string>[] = [];
    // Setup actions first when something's missing — the operator can't
    // do anything else until these are green.
    if (!passphraseExists) {
      choices.push({ label: 'Generate backup passphrase', value: 'generate-passphrase', hint: 'creates a strong random passphrase (one-time)' });
    } else {
      choices.push({ label: 'View backup passphrase', value: 'view-passphrase', hint: 'open the file in your editor — copy to your password manager' });
    }
    if (!imageBuilt) {
      choices.push({ label: 'Build backup image (one-time)', value: 'build-image', hint: 'builds the restic + pg_dump + git container (~1 min)' });
    }
    // Normal flow. Disable Run / Restore until prerequisites are met
    // by simply not listing them (cleaner than greyed-out items).
    if (passphraseExists) {
      choices.push({ label: 'Run a backup now', value: 'run' });
    }
    if (runs.length > 0) {
      choices.push({ label: `Restore from latest snapshot (${runs[0].snapshotId})`, value: 'restore-latest' });
      choices.push({ label: 'Restore from a specific snapshot…', value: 'restore-pick' });
      choices.push({ label: 'Verify backup integrity', value: 'verify' });
    }
    if (ENV === 'prod') {
      choices.push({ label: 'Pull snapshots to laptop', value: 'pull' });
    }
    if (ENV === 'dev' && passphraseExists) {
      choices.push({ label: 'Run restore drill', value: 'drill', hint: 'end-to-end backup + restore round-trip test' });
    }
    if (backupsError && /lock/i.test(backupsError)) {
      choices.push({ label: 'Unlock restic repo', value: 'unlock', hint: 'clears stale locks left by an interrupted backup' });
    }
    choices.push({ label: 'Open backup folder', value: 'open' });
    choices.push({ label: 'Refresh', value: 'refresh' });
    choices.push({ label: 'Back', value: 'back' });

    return (
      <Box flexDirection="column">
        <Text bold>Backups</Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <Text dimColor>
            Restic repo at backups/restic-{ENV}/ — encrypted, deduplicated,
            tiered retention. Run on demand.
          </Text>
          {!passphraseExists && (
            <Text color="yellow">
              {'No passphrase yet — choose "Generate backup passphrase" below.'}
            </Text>
          )}
          {passphraseExists && !imageBuilt && (
            <Text color="yellow">
              Backup image not yet built — first backup will build it
              automatically, or pre-build via the action below.
            </Text>
          )}
          {backupsError && (
            <Text color="red">{`Snapshot fetch error: ${backupsError}`}</Text>
          )}
        </Box>
        <Panel title="Snapshots (newest first)" lines={formatSnapshots(snapshots)} />
        <SectionLabel text="Actions" />
        <SelectList key="backups" choices={choices} onSelect={onSelect} />
      </Box>
    );
  }

  // Backups — restore from a specific snapshot picker. One row per
  // backup run (kind=db + kind=volumes + kind=stage collapse into one).
  if (screen === 'restore-snapshot') {
    const runs = groupBackupRuns(listSnapshots());
    const choices: Choice<string | null>[] = [
      ...runs.map((r): Choice<string | null> => ({
        label: `${r.snapshotId}  ${r.time.replace('T', ' ').replace(/\.\d+.*$/, 'Z')}  [${r.kinds.join(',') || 'n/a'}]`,
        value: r.snapshotId,
      })),
      { label: 'Cancel', value: null },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Restore from which snapshot?</Text>
        <Box marginTop={1}>
          <SelectList
            key="restore-snapshot"
            choices={choices}
            onSelect={(snapshotId) => {
              if (!snapshotId) {
                go('backups');
                return;
              }
              setConfirmState({
                message: `Restore snapshot ${snapshotId}? This will overwrite the current database and volumes. The stack must be stopped first.`,
                onYes: () =>
                  startCommand({
                    title: `Restore — ${snapshotId}`,
                    command: 'bash',
                    args: [
                      scriptPath('restore.sh'),
                      '--env', ENV,
                      '--yes',
                      resticRepoDir(),
                      snapshotId,
                    ],
                    returnTo: 'backups',
                  }),
              });
            }}
          />
        </Box>
      </Box>
    );
  }

  // Settings.
  if (screen === 'settings') {
    const exists = envFileExists();
    const items: Choice<string>[] = [];
    items.push({
      label: 'Keys',
      value: 'keys',
      hint: 'backup passphrase + sealed-secrets age key',
    });
    items.push({
      label: 'View logs',
      value: 'logs',
      hint: ENV === 'dev' ? 'open the .dev-run log folder' : 'stream a service log',
    });
    items.push({ label: exists ? 'Re-run setup' : 'Run setup', value: 'setup', hint: 'create the .env file + secrets' });
    items.push({ label: 'Open .env in editor', value: 'edit' });
    items.push({ label: 'Back', value: 'back' });

    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'keys') go('keys');
      else if (v === 'logs') {
        if (ENV === 'dev') {
          // Dev logs are plain files — just open the folder in Finder.
          mkdirSync(devRunDir(), { recursive: true });
          openInOS([devRunDir()]);
          setNotice('Opened the .dev-run log folder — each run keeps its own timestamped log.');
        } else {
          go('logs');
        }
      }
      else if (v === 'setup') startSetup();
      else if (v === 'edit') {
        if (!exists) {
          setNotice(`No .env.${ENV} yet — run setup first.`);
          return;
        }
        openInOS(['-t', envFilePath()]);
        setNotice(`Opened .env.${ENV} in your default editor. After saving, run Settings → Keys → Seal secrets to update the encrypted copy.`);
      }
    };
    return (
      <Box flexDirection="column">
        <Text bold>Settings</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>Config file: </Text>
          <Text>{`.env.${ENV}`}</Text>
          <Text dimColor>{`  —  ${envSummaryLine()}`}</Text>
        </Box>
        <SelectList key="settings" choices={items} onSelect={onSelect} />
      </Box>
    );
  }

  // Settings → Keys. Inventory + actions for long-lived secrets the
  // system depends on. Values never display — only fingerprints, "set /
  // not set" markers, and paths. See docs/encryption-and-backup-plan.md
  // F9. More rows arrive with later phases (APP_ENCRYPTION_KEY,
  // step-ca root, etc.).
  if (screen === 'keys') {
    const passphrasePath = resticPassphraseFile();
    const passphraseSet = existsSync(passphrasePath);

    const agePath = ageKeyFile();
    const ageSet = existsSync(agePath);
    const recipient = readAgeRecipient();
    const recipientShort = recipient ? `${recipient.slice(0, 16)}…` : '(unreadable)';

    const sealedPath = sealedEnvFile();
    const sealedExists = existsSync(sealedPath);
    const plainExists = envFileExists();
    let sealStatus: { color: 'green' | 'yellow' | 'gray'; text: string };
    if (!ageSet) {
      sealStatus = { color: 'gray', text: 'Age key not generated — run setup' };
    } else if (!sealedExists) {
      sealStatus = { color: 'yellow', text: `Not sealed yet — run "Seal .env.${ENV}" below` };
    } else if (!plainExists) {
      sealStatus = { color: 'yellow', text: 'Plaintext .env missing — unseal to recover' };
    } else {
      const sealedTime = statSync(sealedPath).mtime;
      const plainTime = statSync(envFilePath()).mtime;
      const drift = plainTime.getTime() - sealedTime.getTime();
      sealStatus = drift > 1000
        ? { color: 'yellow', text: `.env.${ENV} has changes — seal to update the encrypted copy` }
        : { color: 'green', text: `In sync (last sealed ${sealedTime.toISOString().replace('T', ' ').replace(/\.\d+.*$/, 'Z')})` };
    }

    // F4 — column encryption status. APP_ENCRYPTION_KEY is set by setup;
    // we read its presence (never the value) from the .env file. The
    // feature flag is the actual switch — if it's off, the codec passes
    // plaintext through.
    const envValues = readEnvFile();
    const appKeySet = (envValues.APP_ENCRYPTION_KEY ?? '').length === 64;
    const colFlagOn = (envValues.ENCRYPT_AT_REST_V1 ?? '').toLowerCase() === 'true';
    let colStatus: { color: 'green' | 'yellow' | 'gray'; text: string };
    if (!appKeySet) {
      colStatus = { color: 'gray', text: 'APP_ENCRYPTION_KEY not set — run setup' };
    } else if (!colFlagOn) {
      colStatus = { color: 'yellow', text: 'Key present but ENCRYPT_AT_REST_V1=false — writes are still plaintext' };
    } else {
      colStatus = { color: 'green', text: 'On — new writes are encrypted in the targeted columns' };
    }

    // F5 — TLS row.
    const tlsCaPath = tlsCaCertPath();
    const tlsCaSet = existsSync(tlsCaPath);
    const tlsLeafPath = tlsPostgresCertPath();
    const tlsLeafSet = existsSync(tlsLeafPath);
    const caExpiry = tlsCaSet ? tlsCertExpiry(tlsCaPath) : null;
    const leafExpiry = tlsLeafSet ? tlsCertExpiry(tlsLeafPath) : null;
    const fmtExpiry = (d: Date | null): string => {
      if (!d) return '(unreadable)';
      const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
      return `${d.toISOString().slice(0, 10)} (${days}d)`;
    };
    let tlsStatus: { color: 'green' | 'yellow' | 'red' | 'gray'; text: string };
    if (!tlsCaSet || !tlsLeafSet) {
      tlsStatus = { color: 'gray', text: 'TLS not initialised — postgres will refuse to start' };
    } else if (leafExpiry && leafExpiry.getTime() - Date.now() < 30 * 86_400_000) {
      tlsStatus = { color: 'red', text: `Postgres leaf expires in <30 days — run "Renew TLS leaf" below` };
    } else if (leafExpiry && leafExpiry.getTime() - Date.now() < 90 * 86_400_000) {
      tlsStatus = { color: 'yellow', text: `Postgres leaf expires in <90 days — plan a renewal` };
    } else {
      tlsStatus = { color: 'green', text: `Healthy (leaf expires ${fmtExpiry(leafExpiry)})` };
    }

    const onSelect = (v: string): void => {
      if (v === 'back') go('settings');
      else if (v === 'view-passphrase') {
        if (!passphraseSet) {
          setNotice('No passphrase yet — Backups → Generate backup passphrase first.');
          return;
        }
        openInOS(['-t', passphrasePath]);
        setNotice(`Opened ${passphrasePath}. Copy the value to your password manager and close without changes.`);
      } else if (v === 'view-age') {
        if (!ageSet) {
          setNotice('No age key yet — Settings → Run setup first.');
          return;
        }
        openInOS(['-t', agePath]);
        setNotice(`Opened ${agePath}. Recipient (public) line is at the top — that's safe to share; the AGE-SECRET-KEY line below it is not.`);
      } else if (v === 'view-tls') {
        if (!tlsCaSet) {
          setNotice('No TLS material yet — Settings → Run setup first.');
          return;
        }
        openInOS([tlsDir()]);
        setNotice(`Opened ${tlsDir()} in Finder. Files: ca.crt (public), ca.key (private), postgres.crt/key (server).`);
      } else if (v === 'init-tls') {
        if (!backupImageBuilt()) {
          setNotice('Build the backup image first (Backups → Build backup image).');
          return;
        }
        const result = ensureTlsSync();
        setNotice(result.message);
        refresh();
      } else if (v === 'renew-tls') {
        setConfirmState({
          message: 'Regenerate the postgres leaf cert (keeping the same CA)? Postgres + backend + agent will need a restart afterwards.',
          onYes: () => {
            const result = renewTlsLeafSync();
            setNotice(result.message);
            refresh();
          },
        });
      } else if (v === 'migrate-columns') {
        if (!appKeySet) {
          setNotice('APP_ENCRYPTION_KEY not set — run setup first.');
          return;
        }
        setConfirmState({
          message: `Encrypt all remaining plaintext rows in the at-rest columns? Idempotent and resumable — already-encrypted rows are skipped. Reads ${ENV === 'prod' ? 'against prod' : 'against dev'} continue to work throughout.`,
          onYes: () =>
            startCommand({
              title: 'Encrypt remaining plaintext columns',
              command: 'bash',
              args: [
                '-c',
                `DOTENV_CONFIG_PATH=.env.${ENV} npx tsx scripts/migrate-encrypt-columns.ts`,
              ],
              returnTo: 'keys',
            }),
        });
      } else if (v === 'migrate-columns-dry') {
        startCommand({
          title: 'Plaintext column scan (dry run)',
          command: 'bash',
          args: [
            '-c',
            `DOTENV_CONFIG_PATH=.env.${ENV} npx tsx scripts/migrate-encrypt-columns.ts --dry-run`,
          ],
          returnTo: 'keys',
        });
      } else if (v === 'seal') {
        if (!ageSet) {
          setNotice('No age key yet — Settings → Run setup first (the setup flow mints one).');
          return;
        }
        if (!plainExists) {
          setNotice(`No .env.${ENV} to seal.`);
          return;
        }
        // Self-heal: if .sops.yaml carries the old (buggy) path_regex
        // from before the SOPS-config fix, ensureSopsConfig replaces it
        // in place. Idempotent — no-op when the file is already correct.
        const sopsCfg = ensureSopsConfig();
        const result = sealEnvSync();
        const healedNote = sopsCfg.replaced
          ? ' (rewrote stale .sops.yaml so sops could find the rule.)'
          : '';
        setNotice(`${result.message}${healedNote}`);
        refresh();
      } else if (v === 'unseal') {
        if (!sealedExists) {
          setNotice(`No ${sealedPath} to unseal.`);
          return;
        }
        if (plainExists) {
          setConfirmState({
            message: `Overwrite .env.${ENV} with the contents of ${sealedPath}? Any unsaved local edits will be lost.`,
            onYes: () => {
              const result = unsealEnvSync();
              setNotice(result.message);
              refresh();
            },
          });
        } else {
          const result = unsealEnvSync();
          setNotice(result.message);
          refresh();
        }
      }
    };

    const choices: Choice<string>[] = [];
    if (passphraseSet) {
      choices.push({ label: 'View restic backup passphrase', value: 'view-passphrase', hint: 'opens the file in your editor' });
    }
    if (ageSet) {
      choices.push({ label: 'View SOPS age key', value: 'view-age', hint: 'opens the file — recipient line is public, key line is not' });
    }
    if (!tlsCaSet || !tlsLeafSet) {
      choices.push({ label: 'Initialize TLS material', value: 'init-tls', hint: 'mint CA + postgres leaf (required for the stack to start)' });
    } else {
      choices.push({ label: 'View TLS material', value: 'view-tls', hint: 'opens secrets/tls/ in Finder' });
      choices.push({ label: 'Renew TLS leaf', value: 'renew-tls', hint: 'regenerate postgres.crt against the existing CA' });
    }
    if (appKeySet) {
      choices.push({ label: 'Scan for plaintext columns (dry-run)', value: 'migrate-columns-dry', hint: 'reports plaintext rows in target columns without writing' });
      choices.push({ label: 'Encrypt remaining plaintext columns', value: 'migrate-columns', hint: 'backfill encryption across server_agents, admin_inboxes, clients, billing_checkouts, devices' });
    }
    if (ageSet && plainExists) {
      choices.push({ label: `Seal .env.${ENV} → ${sealedPath.replace(REPO_ROOT + '/', '')}`, value: 'seal' });
    }
    if (ageSet && sealedExists) {
      choices.push({ label: `Unseal ${sealedPath.replace(REPO_ROOT + '/', '')} → .env.${ENV}`, value: 'unseal' });
    }
    choices.push({ label: 'Back', value: 'back' });

    const inventory: string[] = [
      `Restic backup passphrase   ${passphraseSet ? 'set' : 'not set'}   ${passphrasePath.replace(REPO_ROOT + '/', '')}`,
      `SOPS age key               ${ageSet ? 'set' : 'not set'}   ${agePath.replace(REPO_ROOT + '/', '')}` +
        (ageSet ? `   recipient: ${recipientShort}` : ''),
      `TLS CA                     ${tlsCaSet ? 'set' : 'not set'}   ${tlsCaPath.replace(REPO_ROOT + '/', '')}` +
        (tlsCaSet ? `   expires ${fmtExpiry(caExpiry)}` : ''),
      `TLS postgres leaf          ${tlsLeafSet ? 'set' : 'not set'}   ${tlsLeafPath.replace(REPO_ROOT + '/', '')}` +
        (tlsLeafSet ? `   expires ${fmtExpiry(leafExpiry)}` : ''),
      `APP_ENCRYPTION_KEY (F4)    ${appKeySet ? 'set' : 'not set'}   .env.${ENV}` +
        (appKeySet ? `   flag ${colFlagOn ? 'on' : 'off'}` : ''),
    ];

    return (
      <Box flexDirection="column">
        <Text bold>Keys</Text>
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          <Text dimColor>
            Inventory of long-lived secrets for env=
            <Text>{ENV}</Text>
            . Values stay on disk in their files; this screen only shows
            paths + fingerprints.
          </Text>
          <Box marginTop={1}>
            <Text dimColor>Seal status:  </Text>
            <Text color={sealStatus.color}>{sealStatus.text}</Text>
          </Box>
          <Box>
            <Text dimColor>TLS status:   </Text>
            <Text color={tlsStatus.color}>{tlsStatus.text}</Text>
          </Box>
          <Box>
            <Text dimColor>Columns:      </Text>
            <Text color={colStatus.color}>{colStatus.text}</Text>
          </Box>
        </Box>
        <Panel title="Inventory" lines={inventory} />
        <SectionLabel text="Actions" />
        <SelectList key="keys" choices={choices} onSelect={onSelect} />
      </Box>
    );
  }

  // View logs (production only — stream a service's container logs).
  // In dev, "View logs" opens the .dev-run folder straight from the
  // dashboard and never navigates to this screen.
  if (screen === 'logs') {
    const choices: Choice<string | null>[] = [
      ...PROD_SERVICES.map((s): Choice<string | null> => ({ label: `Stream ${s} logs`, value: s })),
      { label: 'Back', value: null },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Logs</Text>
        <SectionLabel text="Stream a live log" />
        <SelectList
          key="logs"
          choices={choices}
          onSelect={(svc) => {
            if (!svc) go('settings');
            else runDocker(`Logs: ${svc}`, ['logs', '-f', '--tail', '100', svc], 'logs');
          }}
        />
      </Box>
    );
  }

  // Fallback — should not happen.
  return (
    <Box flexDirection="column">
      <Text color="red">{`Unknown screen "${screen}".`}</Text>
      <SelectList key="fallback" choices={[{ label: 'Back to dashboard', value: 'dashboard' }]} onSelect={go} />
    </Box>
  );
  };

  return (
    <AppFrame size={size} notice={notice} hint={DEFAULT_HINT}>
      {renderScreen()}
    </AppFrame>
  );
}

// Renders the dashboard full-screen and resolves when the user quits.
// Uses the terminal's alternate screen buffer (like vim/htop) so the
// panel owns the whole window and the user's shell scrollback is left
// untouched once they exit.
async function runTui(initialEnv: Env | null): Promise<void> {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    // Show cursor, leave the alternate screen.
    process.stdout.write('[?25h[?1049l');
  };
  // Enter the alternate screen, hide the cursor, clear, home.
  process.stdout.write('[?1049h[?25l[2J[H');
  process.on('exit', restore);
  const instance = render(<App initialEnv={initialEnv} />, { patchConsole: false });
  try {
    await instance.waitUntilExit();
  } finally {
    restore();
  }
}

// --- non-interactive subcommands ------------------------------------------

const USAGE = `Goldilocks CLI

  npm run cli -- --dev             open the dashboard (development)
  npm run cli -- --prod            open the dashboard (production)

Pick the environment with --dev or --prod (or set GOLDILOCKS_ENV=dev|prod).
Every subcommand needs it too:

  npm run cli -- --prod admins list
  npm run cli -- --prod admins add <name>
  npm run cli -- --prod admins remove <name|number>
  npm run cli -- --dev|--prod clients list
  npm run cli -- --dev|--prod payments status
  npm run cli -- --dev  stack up|down|reset|status
  npm run cli -- --prod stack deploy|status|up|down|backup
  npm run cli -- --prod stack logs|restart <service>
  npm run cli -- --prod tunnel url|start|stop|restart
`;

function resolveAdmin(admins: AdminRow[], token: string): AdminRow | undefined {
  const trimmed = token.trim();
  const idx = Number.parseInt(trimmed, 10);
  if (Number.isInteger(idx) && String(idx) === trimmed) return admins[idx - 1];
  return admins.find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
}

async function adminsOneShot(args: string[]): Promise<void> {
  const verb = (args[0] ?? 'list').toLowerCase();
  await withDb(async (c) => {
    if (verb === 'list') {
      printAdmins(await loadAdmins(c));
      return;
    }
    if (verb === 'add') {
      const name = args.slice(1).join(' ').trim();
      if (!name) {
        console.error('usage: admins add <name>');
        process.exitCode = 1;
        return;
      }
      const code = await addAdmin(c, name);
      console.log(`${GREEN}+${RESET} added admin "${name}" — upgrade code ${BOLD}${formatCode(code)}${RESET}`);
      return;
    }
    if (verb === 'remove') {
      const target = resolveAdmin(await loadAdmins(c), args[1] ?? '');
      if (!target) {
        console.error(`no admin matches "${args[1] ?? ''}"`);
        process.exitCode = 1;
        return;
      }
      await removeAdmin(c, target.id);
      console.log(`${RED}-${RESET} removed "${target.name}" (code ${formatCode(target.upgrade_code)} is now dead)`);
      printAdmins(await loadAdmins(c));
      return;
    }
    console.error(`unknown: admins ${verb} — use list, add, or remove`);
    process.exitCode = 1;
  });
}

async function clientsOneShot(args: string[]): Promise<void> {
  const verb = (args[0] ?? 'list').toLowerCase();
  if (verb !== 'list') {
    console.error('clients is view-only — the only subcommand is: clients list');
    console.error('(plans are managed by clients in the app.)');
    process.exitCode = 1;
    return;
  }
  await withDb(async (c) => {
    printClients(await loadClients(c));
  });
}

// payments is config-only from the shell — `status` prints the current
// Stripe config. Secret keys are set from the interactive CLI
// (Payments → Stripe) so they are never echoed into shell history.
function paymentsOneShot(args: string[]): void {
  const verb = (args[0] ?? 'status').toLowerCase();
  if (verb !== 'status') {
    console.error('payments is config-only here — the subcommand is: payments status');
    console.error('(set keys from the interactive CLI: Payments → Stripe.)');
    process.exitCode = 1;
    return;
  }
  console.log(`${BOLD}Stripe${RESET}`);
  for (const line of formatStripeConfig(readStripeConfig())) {
    console.log(line ? `  ${line}` : '');
  }
  console.log('');
}

async function tunnelOneShot(args: string[]): Promise<void> {
  const verb = (args[0] ?? 'url').toLowerCase();
  if (verb === 'url') await bashInherit('tunnel-url.sh');
  else if (verb === 'start') await composeInherit(['up', '-d', 'cloudflared']);
  else if (verb === 'stop') await composeInherit(['stop', 'cloudflared']);
  else if (verb === 'restart') await composeInherit(['restart', 'cloudflared']);
  else {
    console.error(`unknown: tunnel ${verb}`);
    process.exitCode = 1;
  }
}

async function stackOneShot(args: string[]): Promise<void> {
  const verb = (args[0] ?? 'status').toLowerCase();
  if (ENV === 'dev') {
    if (verb === 'up') {
      await bashInherit('dev-env.sh', ['up']);
      console.log(syncStripeWebhookSecret());
      console.log(startDevProcess('server', 'npm', ['run', 'server:dev']));
      console.log(startDevProcess('agent', 'npm', ['run', 'agents:dev']));
      await startAndTrustCaddy((line) => console.log(line));
      console.log(startStripeListener());
    } else if (verb === 'down') {
      console.log(stopDevProcess('server'));
      console.log(stopDevProcess('agent'));
      console.log(stopDevProcess('caddy'));
      console.log(stopDevProcess('stripe'));
      await bashInherit('dev-env.sh', ['down']);
    } else if (verb === 'status') {
      await bashInherit('dev-env.sh', ['status']);
    } else if (verb === 'reset') {
      console.log(stopDevProcess('server'));
      console.log(stopDevProcess('agent'));
      console.log(stopDevProcess('caddy'));
      console.log(stopDevProcess('stripe'));
      await bashInherit('dev-env.sh', ['reset']);
    } else {
      console.error(`unknown: stack ${verb} — in --dev it is one of: up, down, reset, status`);
      process.exitCode = 1;
    }
    return;
  }
  if (verb === 'deploy') {
    await bashInherit('deploy.sh');
  } else if (verb === 'status') {
    await composeInherit(['ps']);
  } else if (verb === 'up') {
    await composeInherit(['up', '-d']);
  } else if (verb === 'down') {
    await composeInherit(['down']);
  } else if (verb === 'backup') {
    await composeInherit(['exec', 'backup', 'bash', '/usr/local/bin/backup.sh']);
  } else if (verb === 'logs' || verb === 'restart') {
    const service = args[1];
    if (!service) {
      console.error(`usage: stack ${verb} <service>`);
      process.exitCode = 1;
      return;
    }
    if (verb === 'logs') await composeInherit(['logs', '-f', '--tail', '100', service]);
    else await composeInherit(['restart', service]);
  } else {
    console.error(`unknown: stack ${verb}`);
    process.exitCode = 1;
  }
}

async function runOneShot(argv: string[]): Promise<void> {
  const group = (argv[0] ?? '').toLowerCase();
  const rest = argv.slice(1);
  switch (group) {
    case 'admins':
      await adminsOneShot(rest);
      break;
    case 'clients':
      await clientsOneShot(rest);
      break;
    case 'payments':
      paymentsOneShot(rest);
      break;
    case 'stack':
      await stackOneShot(rest);
      break;
    case 'tunnel':
      if (ENV !== 'prod') {
        console.error('tunnel is a production-only command — use --prod');
        process.exitCode = 1;
        break;
      }
      await tunnelOneShot(rest);
      break;
    default:
      console.error(`Unknown command: "${group}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// --- entry -----------------------------------------------------------------

// Pulls --dev / --prod / --env=… out of argv; the rest is the subcommand.
function parseEnv(argv: string[]): { env: Env | null; rest: string[] } {
  const rest: string[] = [];
  let env: Env | null = null;
  for (const arg of argv) {
    if (arg === '--dev' || arg === '--env=dev') env = 'dev';
    else if (arg === '--prod' || arg === '--env=prod') env = 'prod';
    else rest.push(arg);
  }
  if (!env) {
    const fromVar = (process.env.GOLDILOCKS_ENV ?? '').toLowerCase();
    if (fromVar === 'dev' || fromVar === 'prod') env = fromVar;
  }
  return { env, rest };
}

async function main(): Promise<void> {
  const { env, rest } = parseEnv(process.argv.slice(2));
  const first = (rest[0] ?? '').toLowerCase();

  if (first === 'help' || first === '--help' || first === '-h') {
    console.log(USAGE);
    return;
  }

  if (rest.length > 0) {
    // Non-interactive subcommand — the environment must be explicit.
    if (!env) {
      console.error('Specify an environment: --dev or --prod');
      console.error('  e.g.  npm run cli -- --prod admins list');
      process.exitCode = 1;
      return;
    }
    ENV = env;
    loadEnv({ path: envFilePath() });
    if (!envFileExists()) {
      console.error(`No .env.${ENV} found. Run the interactive CLI to set it up:`);
      console.error(`  npm run cli -- --${ENV}`);
      process.exitCode = 1;
      return;
    }
    await runOneShot(rest);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error('The interactive dashboard needs a terminal. Try a subcommand, e.g.:');
    console.error('  npm run cli -- --prod admins list');
    process.exitCode = 1;
    return;
  }

  if (env) {
    ENV = env;
    loadEnv({ path: envFilePath() });
  }
  await runTui(env);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}CLI error:${RESET}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
