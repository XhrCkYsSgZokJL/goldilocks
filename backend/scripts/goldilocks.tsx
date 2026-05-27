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
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync,
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

interface BackupFile {
  name: string;
  size: number;
  mtime: Date;
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
function dockerComposeArgs(rest: string[]): string[] {
  return ['compose', '--env-file', `.env.${ENV}`, '-f', composeFile(), ...rest];
}

function composeInherit(rest: string[]): Promise<number> {
  return runInherit('docker', dockerComposeArgs(rest));
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
  return res.rows;
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
    const res = await client.query('SELECT 1 FROM admin_inboxes WHERE upgrade_code = $1', [code]);
    if (res.rows.length === 0) return code;
  }
  throw new Error('could not generate a unique upgrade code');
}

// Inserts an admin slot, returns the generated upgrade code.
async function addAdmin(client: pg.Client, name: string): Promise<string> {
  const code = await uniqueCode(client);
  await client.query('INSERT INTO admin_inboxes (name, upgrade_code) VALUES ($1, $2)', [name, code]);
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

// True once Caddy's local root is in the macOS System keychain — the
// trust store the iOS Simulator inherits.
function caddyRootTrustedInSystemKeychain(): boolean {
  try {
    const res = spawnSync(
      'security',
      ['find-certificate', '-c', 'Caddy Local Authority', '/Library/Keychains/System.keychain'],
      { stdio: 'ignore' },
    );
    return res.status === 0;
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
  const r = await capture('docker', dockerComposeArgs(['ps', '-q', service]));
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

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// Backups land in ./backups on the box (written by the `backup` service).
function listBackups(prefix: string, suffix: string): BackupFile[] {
  const dir = join(REPO_ROOT, 'backups');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
    .map((n) => {
      const s = statSync(join(dir, n));
      return { name: n, size: s.size, mtime: s.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function formatBackups(): string[] {
  const dbDumps = listBackups('db-', '.dump');
  const agentTars = listBackups('agent-data-', '.tar.gz');
  const lines: string[] = ['Database dumps:'];
  if (dbDumps.length === 0) lines.push('  (none)');
  else dbDumps.forEach((f) => lines.push(`  ${f.name}  ${humanSize(f.size)}`));
  lines.push('', 'Agent-identity archives:');
  if (agentTars.length === 0) lines.push('  (none)');
  else agentTars.forEach((f) => lines.push(`  ${f.name}  ${humanSize(f.size)}`));
  return lines;
}

// One bash script that stops the app, restores the DB dump, and restarts.
function restoreDatabaseScript(file: string): string {
  const user = process.env.POSTGRES_USER ?? 'goldilocks';
  const db = process.env.POSTGRES_DB ?? 'goldilocks';
  const dc = `docker compose --env-file .env.${ENV} -f ${composeFile()}`;
  return (
    `${dc} stop backend agent; ` +
    `cat "backups/${file}" | ${dc} exec -T goldilocks-db ` +
    `pg_restore -U ${user} -d ${db} --clean --if-exists --no-owner; rc=$?; ` +
    `${dc} start backend agent; exit $rc`
  );
}

// One bash script that stops the agent, replaces its identity data, restarts.
function restoreAgentScript(file: string): string {
  const dc = `docker compose --env-file .env.${ENV} -f ${composeFile()}`;
  const backups = join(REPO_ROOT, 'backups');
  return (
    `${dc} stop agent; ` +
    `${dc} run --rm --no-deps -v "${backups}:/restore-src:ro" --entrypoint sh agent ` +
    `-c 'rm -rf /var/lib/goldilocks-agent/* && tar xzf "/restore-src/${file}" -C /var/lib/goldilocks-agent'; rc=$?; ` +
    `${dc} start agent; exit $rc`
  );
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
  let content = readFileSync(envTemplatePath(), 'utf8');
  content = setEnvValue(content, 'JWT_SECRET', generateSecret());
  content = setEnvValue(content, 'AGENT_DB_ENCRYPTION_KEY', generateSecret());
  if (ENV === 'prod') {
    content = setEnvValue(content, 'POSTGRES_PASSWORD', generateSecret());
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
      setNotice(
        ENV === 'prod'
          ? `Wrote .env.prod — back up AGENT_DB_ENCRYPTION_KEY, losing it loses the agents.`
          : 'Wrote .env.dev — dev defaults cover everything else.',
      );
      setScreen('dashboard');
      refresh();
    } catch (err) {
      setNotice(`Setup failed: ${(err as Error).message}`);
      setScreen('settings');
    }
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
    startCommand({ title, command: 'docker', args: dockerComposeArgs(rest), returnTo, ...spec });
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

  // pg_dump the dev Postgres container into ./backups. Custom format so it
  // restores with pg_restore; the `dev-` prefix keeps these dumps out of
  // the prod Backups restore picker.
  const devBackup = (): void => {
    const file = `dev-db-${timestamp()}.dump`;
    const script = [
      'mkdir -p backups',
      `if docker compose -f docker-compose.yml exec -T goldilocks-db ` +
        `pg_dump -U goldilocks -d goldilocks -Fc > "backups/${file}"; then`,
      `  echo "Saved backups/${file}"`,
      'else',
      `  rm -f "backups/${file}"`,
      '  echo "Backup failed — start the dev environment first."',
      '  exit 1',
      'fi',
    ].join('\n');
    startCommand({
      title: 'Back up dev database',
      command: 'bash',
      args: ['-c', script],
      returnTo: 'systems',
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
      { label: 'Clients', value: 'clients', hint: 'view client plans' },
      { label: 'Payments', value: 'payments', hint: 'Stripe keys + webhook config' },
    ];
    if (ENV === 'prod') {
      menu.push({ label: 'Deploy', value: 'deploy', hint: 'pull, preflight, build, migrate, restart' });
      menu.push({ label: 'Production stack', value: 'stack', hint: 'status, start / stop, restart' });
      menu.push({ label: 'Backups', value: 'backups', hint: 'list, run, restore' });
      menu.push({ label: 'Cloudflare tunnel', value: 'tunnel', hint: 'start / stop, public URL' });
    }
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

  // Systems (dev environment start/stop).
  if (screen === 'systems') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'up') devUp();
      else if (v === 'down') devDown();
      else if (v === 'backup') devBackup();
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
            { label: 'Backup', value: 'backup', hint: 'dump the dev database to backups/' },
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

  // Backups.
  if (screen === 'backups') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'refresh') refresh();
      else if (v === 'run') {
        runDocker('Run a backup', ['exec', 'backup', 'bash', '/usr/local/bin/backup.sh'], 'backups');
      } else if (v === 'restore-db') go('restore-db');
      else if (v === 'restore-agent') go('restore-agent');
    };
    return (
      <Box flexDirection="column">
        <Text bold>Backups</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>Daily pg_dump + agent-identity archive, kept 30 days in backups/.</Text>
        </Box>
        <Panel title="Available backups" lines={formatBackups()} />
        <SectionLabel text="Actions" />
        <SelectList
          key="backups"
          choices={[
            { label: 'Run a backup now', value: 'run' },
            { label: 'Restore the database from a backup', value: 'restore-db' },
            { label: 'Restore agent identities from a backup', value: 'restore-agent' },
            { label: 'Refresh', value: 'refresh' },
            { label: 'Back', value: 'back' },
          ]}
          onSelect={onSelect}
        />
      </Box>
    );
  }

  // Backups — restore database picker.
  if (screen === 'restore-db') {
    const dumps = listBackups('db-', '.dump');
    const choices: Choice<string | null>[] = [
      ...dumps.map((f): Choice<string | null> => ({ label: `${f.name}  ${humanSize(f.size)}`, value: f.name })),
      { label: 'Cancel', value: null },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Restore the database from which dump?</Text>
        <Box marginTop={1}>
          <SelectList
            key="restore-db"
            choices={choices}
            onSelect={(file) => {
              if (!file) {
                go('backups');
                return;
              }
              setConfirmState({
                message: `Overwrite the current database with "${file}"? This cannot be undone.`,
                onYes: () =>
                  startCommand({
                    title: `Restore database — ${file}`,
                    command: 'bash',
                    args: ['-c', restoreDatabaseScript(file)],
                    returnTo: 'backups',
                  }),
              });
            }}
          />
        </Box>
      </Box>
    );
  }

  // Backups — restore agent identities picker.
  if (screen === 'restore-agent') {
    const tars = listBackups('agent-data-', '.tar.gz');
    const choices: Choice<string | null>[] = [
      ...tars.map((f): Choice<string | null> => ({ label: `${f.name}  ${humanSize(f.size)}`, value: f.name })),
      { label: 'Cancel', value: null },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Restore agent identities from which archive?</Text>
        <Box marginTop={1}>
          <SelectList
            key="restore-agent"
            choices={choices}
            onSelect={(file) => {
              if (!file) {
                go('backups');
                return;
              }
              setConfirmState({
                message: `Replace the agents' identity data with "${file}"? This cannot be undone.`,
                onYes: () =>
                  startCommand({
                    title: `Restore agent identities — ${file}`,
                    command: 'bash',
                    args: ['-c', restoreAgentScript(file)],
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
      label: 'View logs',
      value: 'logs',
      hint: ENV === 'dev' ? 'open the .dev-run log folder' : 'stream a service log',
    });
    items.push({ label: exists ? 'Re-run setup' : 'Run setup', value: 'setup', hint: 'create the .env file + secrets' });
    items.push({ label: 'Open .env in editor', value: 'edit' });
    items.push({ label: 'Back', value: 'back' });

    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
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
        setNotice(`Opened .env.${ENV} in your default editor.`);
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
