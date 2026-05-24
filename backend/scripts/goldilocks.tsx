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

type Tier = 'light' | 'active';

interface ClientRow {
  id: string;
  client_number: number;
  subscription_tier: Tier | null;
}

interface BackupFile {
  name: string;
  size: number;
  mtime: Date;
}

interface DashboardData {
  stats: StatItem[];
  installs: number | null;
  subs: { light: number; active: number; none: number } | null;
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
    console.log(`  [${num}] ${name} code ${a.upgrade_code}  ${claimed}`);
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
    return `[${num}] ${name} code ${a.upgrade_code}  ${claimed}`;
  });
}

function generateCode(): string {
  return String(randomInt(0, 10_000_000_000)).padStart(10, '0');
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

// Client plans are chosen by clients in the iOS app; the CLI only views them.
async function loadClients(client: pg.Client): Promise<ClientRow[]> {
  const res = await client.query<ClientRow>(
    `SELECT id, client_number, subscription_tier
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
    const tier = c.subscription_tier ?? `${DIM}no plan${RESET}`;
    console.log(`  ${num} ${tier}`);
  });
  console.log('');
}

function formatClients(rows: ClientRow[]): string[] {
  if (rows.length === 0) return ['(no clients registered yet)'];
  return rows.map((c) => {
    const num = `#${c.client_number}`.padEnd(6, ' ');
    const tier = c.subscription_tier ?? 'no plan';
    return `${num} ${tier}`;
  });
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

// Spawn `npm run <script>` detached, logging to a fresh timestamped file
// under .dev-run/. Reaps stale stragglers first so `up` always starts clean.
// Returns a human-readable result line.
function startDevProcess(name: string, script: string): string {
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
  const child = spawn('npm', ['run', script], {
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
    return [
      { label: 'server', on: devProcessPid('server') !== null },
      { label: 'agents', on: devProcessPid('agent') !== null },
      { label: 'database', on: db.code === 0 && db.out.trim().length > 0 },
      { label: 'XMTP node', on: xmtp.code === 0 && xmtp.out.trim().length > 0 },
    ];
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
  let subs: DashboardData['subs'] = null;
  let admins: number | null = null;
  try {
    const data = await withDb(async (c) => {
      const cl = await loadClients(c);
      const ad = await loadAdmins(c);
      return { cl, ad };
    });
    installs = data.cl.length;
    subs = {
      light: data.cl.filter((r) => r.subscription_tier === 'light').length,
      active: data.cl.filter((r) => r.subscription_tier === 'active').length,
      none: data.cl.filter((r) => !r.subscription_tier).length,
    };
    admins = data.ad.length;
  } catch {
    // DB not reachable — cards show as “—”.
  }
  let tunnelUrl = '';
  if (ENV === 'prod') tunnelUrl = await getTunnelUrl().catch((): string => '');
  return { stats, installs, subs, admins, tunnelUrl };
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
        <Text>{state.value}</Text>
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
        append('Starting the backend server, agents, and simulator-log mirror…');
        append(startDevProcess('server', 'server:dev'));
        append(startDevProcess('agent', 'agents:dev'));
        append(startDevProcess('simulator', 'logs:sim'));
        append('');
        append('Dev environment is up.');
      },
    });
  };

  const devDown = (): void => {
    const preLines = [
      'Stopping the backend server, agents, and simulator-log mirror…',
      stopDevProcess('server'),
      stopDevProcess('agent'),
      stopDevProcess('simulator'),
      '',
    ];
    runBash('Stop dev environment', 'dev-env.sh', ['down'], 'systems', { preLines });
  };

  const devReset = (): void => {
    const preLines = [
      stopDevProcess('server'),
      stopDevProcess('agent'),
      stopDevProcess('simulator'),
      '',
    ];
    runBash('Reset dev environment', 'dev-env.sh', ['reset'], 'systems', { preLines });
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
      { label: 'No plan', value: dash?.subs ? String(dash.subs.none) : '—' },
      { label: 'Light plan', value: dash?.subs ? String(dash.subs.light) : '—' },
      { label: 'Active plan', value: dash?.subs ? String(dash.subs.active) : '—' },
    ];
    const menu: Choice<string>[] = [
      { label: 'Admins', value: 'admins', hint: 'add / remove admin slots' },
      { label: 'Clients', value: 'clients', hint: 'view client plans' },
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
                setNotice(`Added "${trimmed}" — upgrade code ${code}. Hand it to them to claim admin.`);
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
        label: `${a.name}  (code ${a.upgrade_code})`,
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

  // Systems (dev environment start/stop).
  if (screen === 'systems') {
    const onSelect = (v: string): void => {
      if (v === 'back') go('dashboard');
      else if (v === 'up') devUp();
      else if (v === 'down') devDown();
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
      console.log(`${GREEN}+${RESET} added admin "${name}" — upgrade code ${BOLD}${code}${RESET}`);
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
      console.log(`${RED}-${RESET} removed "${target.name}" (code ${target.upgrade_code} is now dead)`);
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
      console.log(startDevProcess('server', 'server:dev'));
      console.log(startDevProcess('agent', 'agents:dev'));
    } else if (verb === 'down') {
      console.log(stopDevProcess('server'));
      console.log(stopDevProcess('agent'));
      await bashInherit('dev-env.sh', ['down']);
    } else if (verb === 'status') {
      await bashInherit('dev-env.sh', ['status']);
    } else if (verb === 'reset') {
      console.log(stopDevProcess('server'));
      console.log(stopDevProcess('agent'));
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
