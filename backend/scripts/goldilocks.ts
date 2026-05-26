// Goldilocks control CLI — one interactive entry point for everything:
// admins, clients, the dev environment, the production Docker stack, and
// the Cloudflare tunnel.
//
// The CLI always operates on one environment, chosen at launch:
//
//   npm run cli -- --dev             open the interactive menu (development)
//   npm run cli -- --prod            open the interactive menu (production)
//   npm run cli -- --prod admins list        non-interactive (scripting)
//
// The environment can also come from GOLDILOCKS_ENV=dev|prod. With no
// environment given, the interactive CLI asks for one up front.
//
// Arrow keys (or j/k) move, Enter selects. Ctrl+C quits a menu, or stops a
// running command. Run `npm run cli -- help` for the full subcommand list.

import { config as loadEnv } from 'dotenv';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import * as readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

// --- environment -----------------------------------------------------------

type Env = 'dev' | 'prod';

// Set once at startup, before any menu or command runs.
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

// --- colours ---------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

function envBadge(): string {
  return ENV === 'prod' ? `${RED}${BOLD}[PROD]${RESET}` : `${GREEN}${BOLD}[DEV]${RESET}`;
}

// --- interactive primitives ------------------------------------------------

interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

// Arrow-key picker. Renders the choices, redraws them in place on up/down,
// and resolves with the chosen value on Enter. No external dependency.
function select<T>(title: string, choices: Choice<T>[]): Promise<T> {
  return new Promise<T>((resolve) => {
    let index = 0;

    const draw = (redraw: boolean): void => {
      if (redraw) readline.moveCursor(stdout, 0, -(choices.length + 1));
      readline.cursorTo(stdout, 0);
      readline.clearScreenDown(stdout);
      stdout.write(`${BOLD}${title}${RESET}\n`);
      choices.forEach((choice, i) => {
        const active = i === index;
        const pointer = active ? `${CYAN}❯${RESET}` : ' ';
        const label = active ? `${CYAN}${choice.label}${RESET}` : choice.label;
        const hint = choice.hint ? ` ${DIM}— ${choice.hint}${RESET}` : '';
        stdout.write(`${pointer} ${label}${hint}\n`);
      });
    };

    const teardown = (): void => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    const onKey = (_str: string | undefined, key: readline.Key | undefined): void => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        teardown();
        stdout.write('\n');
        process.exit(130);
      } else if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length;
        draw(true);
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length;
        draw(true);
      } else if (key.name === 'return') {
        teardown();
        const chosen = choices[index];
        if (chosen) resolve(chosen.value);
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    draw(false);
  });
}

// Yes / No, defaulting to No.
function confirm(message: string): Promise<boolean> {
  return select<boolean>(message, [
    { label: 'No', value: false },
    { label: 'Yes', value: true },
  ]);
}

// One line of free text.
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function pause(): Promise<void> {
  await ask(`\n${DIM}Press Enter to continue…${RESET}`);
}

function clear(): void {
  if (stdout.isTTY) console.clear();
}

function heading(text: string): void {
  console.log(`${BOLD}${CYAN}${text}${RESET}  ${envBadge()}`);
  console.log(`${DIM}${'─'.repeat(text.length)}${RESET}\n`);
}

// --- dashboard cards -------------------------------------------------------

interface StatItem {
  label: string;
  on: boolean;
}

// A compact 3-line status card; the label sits in the top border.
const CARD_W = 14;

function statCard(label: string, on: boolean): string[] {
  const labelSeg = `─ ${label} `;
  const top = `${DIM}┌${labelSeg}${'─'.repeat(Math.max(0, CARD_W - labelSeg.length))}┐${RESET}`;
  const stateText = on ? 'running' : 'stopped';
  const dot = on ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
  const stateCol = on ? `${GREEN}${stateText}${RESET}` : `${DIM}${stateText}${RESET}`;
  const pad = ' '.repeat(Math.max(0, CARD_W - ` ● ${stateText}`.length));
  const mid = `${DIM}│${RESET} ${dot} ${stateCol}${pad}${DIM}│${RESET}`;
  const bot = `${DIM}└${'─'.repeat(CARD_W)}┘${RESET}`;
  return [top, mid, bot];
}

// Render an array of cards side by side (each card is 3 lines).
function renderStatRow(cards: string[][]): void {
  for (let i = 0; i < 3; i += 1) {
    console.log(cards.map((c) => c[i] ?? '').join(' '));
  }
}

// Run a command with the terminal attached; resolves with its exit code.
// While it runs the parent ignores SIGINT, so Ctrl+C stops the child (e.g.
// `logs -f`) without killing this CLI.
function runShell(command: string, args: string[], cwd: string = REPO_ROOT): Promise<number> {
  console.log(`${DIM}▶ ${command} ${args.join(' ')}${RESET}\n`);
  return new Promise<number>((resolve) => {
    const ignoreSigint = (): void => {};
    process.on('SIGINT', ignoreSigint);
    const child = spawn(command, args, { stdio: 'inherit', cwd });
    child.on('error', (err) => {
      process.removeListener('SIGINT', ignoreSigint);
      console.error(`${RED}✗ ${err.message}${RESET}`);
      resolve(1);
    });
    child.on('close', (code) => {
      process.removeListener('SIGINT', ignoreSigint);
      resolve(code ?? 0);
    });
  });
}

// docker compose against the current environment's compose file.
function compose(args: string[]): Promise<number> {
  return runShell('docker', ['compose', '--env-file', `.env.${ENV}`, '-f', composeFile(), ...args]);
}

function bashScript(name: string, args: string[] = []): Promise<number> {
  return runShell('bash', [join(SCRIPTS_DIR, name), ...args]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a command and capture its stdout (used for status checks + the tunnel URL).
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

// Current public tunnel URL, or '' if cloudflared hasn't published one yet.
async function getTunnelUrl(): Promise<string> {
  const result = await capture('bash', [join(SCRIPTS_DIR, 'tunnel-url.sh')]);
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
// into config.prod.json. The app still needs an Xcode rebuild to pick it up.
function syncIosConfig(tunnelUrl: string): void {
  const path = iosConfigPath();
  if (!existsSync(path)) {
    console.log(`${DIM}iOS repo not found (${path}).`);
    console.log(`Set GOLDILOCKS_IOS so the CLI can update its config automatically.${RESET}`);
    return;
  }
  const result = updateIosBackendUrl(path, `${tunnelUrl}/api`);
  if (result === 'updated') {
    console.log(`${GREEN}✓ iOS production config updated${RESET} — config.prod.json now points at`);
    console.log(`  ${tunnelUrl}/api. Rebuild the app in Xcode to pick it up.`);
  } else if (result === 'unchanged') {
    console.log(`${DIM}iOS production config already points here — no rebuild needed.${RESET}`);
  } else {
    console.log(`${YELLOW}Could not update the iOS config at ${path}.${RESET}`);
  }
}

// Waits for the tunnel URL to settle after a start/restart, prints it, and
// points the iOS app at it.
async function reportTunnelUrl(previous: string): Promise<void> {
  console.log(`\n${DIM}Waiting for Cloudflare to assign the tunnel URL…${RESET}`);
  const url = await waitForTunnelUrl(previous);
  if (!url) {
    console.log(`${YELLOW}The tunnel is starting but hasn't reported a URL yet —`);
    console.log(`run "Show current public URL" again in a moment.${RESET}`);
    return;
  }
  console.log(`\n${GREEN}${BOLD}Tunnel URL:${RESET} ${BOLD}${url}${RESET}`);
  console.log(`${DIM}The backend auto-detects this hostname — nothing else on the server`);
  console.log(`needs updating.${RESET}`);
  syncIosConfig(url);
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

// Wraps a DB-backed menu body; on a connection failure it shows a friendly
// hint instead of crashing the whole CLI, and returns undefined.
async function withDbOrWarn<T>(fn: (client: pg.Client) => Promise<T>): Promise<T | undefined> {
  try {
    return await withDb(fn);
  } catch (err) {
    console.log(`${RED}Could not reach the ${ENV} database.${RESET} ${(err as Error).message}`);
    const where = ENV === 'prod' ? 'Production stack → Start' : 'Settings → Systems → Start';
    console.log(`${DIM}Start the stack first — ${where}.${RESET}`);
    await pause();
    return undefined;
  }
}

// --- admins ----------------------------------------------------------------

interface AdminRow {
  id: string;
  name: string;
  upgrade_code: string;
  inbox_id: string | null;
}

async function loadAdmins(client: pg.Client): Promise<AdminRow[]> {
  const res = await client.query<AdminRow>(
    `SELECT id, name, upgrade_code, inbox_id
       FROM admin_inboxes
       ORDER BY created_at ASC`,
  );
  return res.rows;
}

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

async function addAdmin(client: pg.Client, name: string): Promise<void> {
  const code = await uniqueCode(client);
  await client.query('INSERT INTO admin_inboxes (name, upgrade_code) VALUES ($1, $2)', [name, code]);
  console.log(`\n  ${GREEN}+${RESET} added admin "${name}"`);
  console.log(`    upgrade code: ${BOLD}${code}${RESET}`);
  console.log(`    ${DIM}hand this to the person; they enter it in the app to become admin.${RESET}`);
}

async function removeAdmin(client: pg.Client, row: AdminRow): Promise<void> {
  await client.query('DELETE FROM admin_inboxes WHERE id = $1', [row.id]);
  console.log(`  ${RED}-${RESET} removed "${row.name}" (code ${row.upgrade_code} is now dead)`);
  console.log(`  ${DIM}→ if they were an admin, they lose it the next time the app checks in.${RESET}`);
}

async function adminsMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Admins');
    const admins = await withDbOrWarn(loadAdmins);
    if (!admins) return;
    printAdmins(admins);

    const action = await select<'add' | 'remove' | 'back'>('Choose an action', [
      { label: 'Add an admin', value: 'add', hint: 'creates a slot + upgrade code' },
      { label: 'Remove an admin', value: 'remove', hint: 'deletes the slot; the person loses admin' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === 'back') return;

    if (action === 'add') {
      const name = await ask('\nNew admin name: ');
      if (!name) console.log('  cancelled (no name).');
      else await withDbOrWarn((c) => addAdmin(c, name));
      await pause();
      continue;
    }

    // remove
    if (admins.length === 0) {
      console.log(`  ${DIM}no admins to remove.${RESET}`);
      await pause();
      continue;
    }
    const target = await select<AdminRow | null>('Which admin to remove?', [
      ...admins.map((a) => ({ label: `${a.name}  ${DIM}code ${a.upgrade_code}${RESET}`, value: a })),
      { label: 'Cancel', value: null },
    ]);
    if (!target) continue;
    const ok = await confirm(`Remove "${target.name}"? The upgrade code stops working and they lose admin.`);
    if (!ok) continue;
    await withDbOrWarn((c) => removeAdmin(c, target));
    await pause();
  }
}

// --- clients (view only) ---------------------------------------------------

// Headcount + billing posture are owned by the iOS app; the CLI just lists
// the rows so admins can see who registered.

interface ClientRow {
  id: string;
  client_number: number;
  billing_seats: number;
}

async function loadClients(client: pg.Client): Promise<ClientRow[]> {
  const res = await client.query<ClientRow>(
    `SELECT id, client_number, billing_seats
       FROM clients
       ORDER BY client_number ASC`,
  );
  return res.rows;
}

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

async function clientsMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Clients');
    console.log(`${DIM}Plans are chosen by clients in the app — this is a read-only view.${RESET}\n`);
    const rows = await withDbOrWarn(loadClients);
    if (!rows) return;
    printClients(rows);

    const action = await select<'refresh' | 'back'>('Choose an action', [
      { label: 'Refresh', value: 'refresh' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === 'back') return;
  }
}

// --- dev environment (Systems) ---------------------------------------------

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

// Spawn `npm run <script>` detached, logging to a fresh timestamped file
// under .dev-run/, and record its pid so it can be stopped later.
function startDevProcess(name: string, script: string): void {
  if (devProcessPid(name)) {
    console.log(`  ${DIM}${name} already running.${RESET}`);
    return;
  }
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
    console.log(`  ${GREEN}✓${RESET} ${name} started ${DIM}(pid ${child.pid}, log: .dev-run/${logName})${RESET}`);
  } else {
    console.log(`  ${RED}✗ failed to start ${name}${RESET}`);
  }
}

// SIGTERM the named dev process — its whole group, so tsx + node go too.
function stopDevProcess(name: string): void {
  const pid = devProcessPid(name);
  if (!pid) {
    console.log(`  ${DIM}${name} not running.${RESET}`);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  try {
    unlinkSync(devPidFile(name));
  } catch {
    // ignore
  }
  console.log(`  ${GREEN}✓${RESET} ${name} stopped.`);
}

interface SystemsStatus {
  serverPid: number | null;
  agentPid: number | null;
  xmtpUp: boolean;
  dbUp: boolean;
}

// Live status of the dev environment: the two background processes (by pid)
// and the two docker containers (by `docker compose ps`).
async function devSystemStatus(): Promise<SystemsStatus> {
  const [db, xmtp] = await Promise.all([
    capture('docker', ['compose', '-f', 'docker-compose.yml', 'ps', '-q', 'goldilocks-db'], REPO_ROOT),
    capture('docker', ['compose', '-f', 'dev/docker-compose.yml', '-p', 'convos-ios', 'ps', '-q'], iosRepoDir()),
  ]);
  return {
    serverPid: devProcessPid('server'),
    agentPid: devProcessPid('agent'),
    dbUp: db.code === 0 && db.out.trim().length > 0,
    xmtpUp: xmtp.code === 0 && xmtp.out.trim().length > 0,
  };
}

// Bring the whole dev environment up: node + db + migrations (dev-env.sh),
// then the backend server and agents as background processes.
async function devUp(): Promise<void> {
  const code = await bashScript('dev-env.sh', ['up']);
  if (code !== 0) {
    console.log(`${RED}Dev environment failed to come up — not starting the server/agents.${RESET}`);
    return;
  }
  console.log(`\n${BOLD}Starting the backend server and agents…${RESET}`);
  startDevProcess('server', 'server:dev');
  startDevProcess('agent', 'agents:dev');
  console.log(`\n${GREEN}Dev environment is up.${RESET} ${DIM}See their output via Settings → View logs.${RESET}`);
}

async function devDown(): Promise<void> {
  console.log(`${BOLD}Stopping the backend server and agents…${RESET}`);
  stopDevProcess('server');
  stopDevProcess('agent');
  await bashScript('dev-env.sh', ['down']);
}

async function devReset(): Promise<void> {
  stopDevProcess('server');
  stopDevProcess('agent');
  await bashScript('dev-env.sh', ['reset']);
}

async function systemsMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Systems');
    console.log(`${DIM}checking status…${RESET}`);
    const stats = await dashboardStats();
    clear();
    heading('Systems');
    renderStatRow(stats.map((s) => statCard(s.label, s.on)));
    console.log('');

    const action = await select<'up' | 'down' | 'reset' | 'back'>('Choose an action', [
      { label: 'Start', value: 'up', hint: 'node, db, migrations, server, agents' },
      { label: 'Stop', value: 'down', hint: 'stops everything; data is kept' },
      { label: 'Reset', value: 'reset', hint: 'stop, then wipe the dev database, keys, and sims' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === 'back') return;

    if (action === 'up') {
      await devUp();
    } else if (action === 'down') {
      await devDown();
    } else if (action === 'reset') {
      const ok = await confirm('Stop everything and wipe the dev database, agent keys, and simulator installs?');
      if (!ok) continue;
      await devReset();
    }
    await pause();
  }
}

// Opens the dev log folder in Finder. Each run writes its own timestamped
// log file there, so history is kept.
async function viewDevLogs(): Promise<void> {
  mkdirSync(devRunDir(), { recursive: true });
  await runShell('open', [devRunDir()]);
  console.log(`${DIM}Opened ${devRunDir()} — each run writes its own timestamped log.${RESET}`);
  await pause();
}

// --- production stack ------------------------------------------------------

const PROD_SERVICES = ['goldilocks-db', 'backend', 'agent', 'cloudflared', 'backup'];

async function pickService(title: string): Promise<string | null> {
  return select<string | null>(title, [
    ...PROD_SERVICES.map((s) => ({ label: s, value: s })),
    { label: 'Cancel', value: null },
  ]);
}

async function stackMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Production stack');
    console.log(`${DIM}The docker-compose.prod.yml stack on this box.${RESET}\n`);

    const action = await select<'status' | 'logs' | 'up' | 'down' | 'restart' | 'back'>('Choose an action', [
      { label: 'Status', value: 'status' },
      { label: 'View logs', value: 'logs' },
      { label: 'Start', value: 'up', hint: 'start all services' },
      { label: 'Stop everything', value: 'down', hint: 'containers stop; data volumes are kept' },
      { label: 'Restart a service', value: 'restart' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === 'back') return;

    if (action === 'status') {
      await compose(['ps']);
    } else if (action === 'logs') {
      const service = await pickService('Follow logs for which service?');
      if (!service) continue;
      console.log(`${DIM}Streaming logs — press Ctrl+C to stop.${RESET}`);
      await compose(['logs', '-f', '--tail', '100', service]);
    } else if (action === 'up') {
      await compose(['up', '-d']);
      await reportTunnelUrl('');
    } else if (action === 'down') {
      const ok = await confirm('Stop the whole production stack? (data volumes are kept)');
      if (!ok) continue;
      await compose(['down']);
    } else if (action === 'restart') {
      const service = await pickService('Restart which service?');
      if (!service) continue;
      await compose(['restart', service]);
    }
    await pause();
  }
}

// --- cloudflare tunnel -----------------------------------------------------

async function tunnelMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Cloudflare tunnel');
    console.log(`${DIM}The quick tunnel (cloudflared) that exposes the API.${RESET}\n`);

    const action = await select<'url' | 'start' | 'stop' | 'restart' | 'ios' | 'back'>('Choose an action', [
      { label: 'Show current public URL', value: 'url' },
      { label: 'Start tunnel', value: 'start' },
      { label: 'Stop tunnel', value: 'stop' },
      { label: 'Restart tunnel', value: 'restart', hint: 'issues a NEW url' },
      { label: 'Point the iOS app at this backend', value: 'ios', hint: 'updates config.prod.json' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === 'back') return;

    if (action === 'url') {
      await bashScript('tunnel-url.sh');
    } else if (action === 'start') {
      await compose(['up', '-d', 'cloudflared']);
      await reportTunnelUrl('');
    } else if (action === 'stop') {
      await compose(['stop', 'cloudflared']);
    } else if (action === 'restart') {
      const ok = await confirm('Restarting issues a NEW tunnel URL — the iOS app must then be rebuilt. Continue?');
      if (!ok) continue;
      const before = await getTunnelUrl();
      await compose(['restart', 'cloudflared']);
      await reportTunnelUrl(before);
    } else if (action === 'ios') {
      const url = await getTunnelUrl();
      if (!url) {
        console.log(`${YELLOW}No tunnel URL yet — start the tunnel first.${RESET}`);
      } else {
        console.log(`${BOLD}Tunnel URL:${RESET} ${url}`);
        syncIosConfig(url);
      }
    }
    await pause();
  }
}

// --- deploy ----------------------------------------------------------------

async function deployAction(): Promise<void> {
  clear();
  heading('Deploy');
  console.log(`${DIM}Runs scripts/deploy.sh: git pull, install, preflight checks`);
  console.log(`(typecheck + tests + lint), build images, migrate, restart.${RESET}\n`);
  const ok = await confirm('Run a full production deploy now?');
  if (!ok) return;
  await bashScript('deploy.sh');
  await pause();
}

// --- backups ---------------------------------------------------------------

interface BackupFile {
  name: string;
  size: number;
  mtime: Date;
}

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

function printBackups(): void {
  const dbDumps = listBackups('db-', '.dump');
  const agentTars = listBackups('agent-data-', '.tar.gz');
  console.log(`${BOLD}Database dumps${RESET}  ${DIM}(in backups/)${RESET}`);
  if (dbDumps.length === 0) console.log(`  ${DIM}(none)${RESET}`);
  else dbDumps.forEach((f) => console.log(`  ${f.name}  ${DIM}${humanSize(f.size)}${RESET}`));
  console.log(`\n${BOLD}Agent-identity archives${RESET}`);
  if (agentTars.length === 0) console.log(`  ${DIM}(none)${RESET}`);
  else agentTars.forEach((f) => console.log(`  ${f.name}  ${DIM}${humanSize(f.size)}${RESET}`));
  console.log('');
}

async function restoreDatabase(file: string): Promise<void> {
  const user = process.env.POSTGRES_USER ?? 'goldilocks';
  const db = process.env.POSTGRES_DB ?? 'goldilocks';
  const dc = `docker compose --env-file .env.${ENV} -f ${composeFile()}`;
  // Stop the app, restore, then always bring the app back — even if the
  // restore fails — and propagate the restore's exit code.
  const script =
    `${dc} stop backend agent; ` +
    `cat "backups/${file}" | ${dc} exec -T goldilocks-db ` +
    `pg_restore -U ${user} -d ${db} --clean --if-exists --no-owner; rc=$?; ` +
    `${dc} start backend agent; exit $rc`;
  await runShell('bash', ['-c', script]);
}

async function restoreAgentData(file: string): Promise<void> {
  await compose(['stop', 'agent']);
  const rc = await compose([
    'run', '--rm', '--no-deps',
    '-v', `${join(REPO_ROOT, 'backups')}:/restore-src:ro`,
    '--entrypoint', 'sh', 'agent',
    '-c', `rm -rf /var/lib/goldilocks-agent/* && tar xzf "/restore-src/${file}" -C /var/lib/goldilocks-agent`,
  ]);
  if (rc !== 0) {
    console.log(`${RED}✗ extract failed — the agent data may be incomplete.${RESET}`);
  }
  await compose(['start', 'agent']);
}

async function backupsMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Backups');
    console.log(`${DIM}Daily pg_dump + agent-identity archive, kept 30 days in backups/.${RESET}\n`);
    printBackups();

    const action = await select<'run' | 'restore-db' | 'restore-agent' | 'refresh' | 'back'>('Choose an action', [
      { label: 'Run a backup now', value: 'run' },
      { label: 'Restore the database from a backup', value: 'restore-db' },
      { label: 'Restore agent identities from a backup', value: 'restore-agent' },
      { label: 'Refresh', value: 'refresh' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === 'back') return;

    if (action === 'run') {
      await compose(['exec', 'backup', 'bash', '/usr/local/bin/backup.sh']);
      await pause();
    } else if (action === 'restore-db') {
      const dumps = listBackups('db-', '.dump');
      if (dumps.length === 0) {
        console.log(`  ${DIM}no database dumps to restore from.${RESET}`);
        await pause();
        continue;
      }
      const file = await select<string | null>('Restore the database from which dump?', [
        ...dumps.map((f) => ({ label: `${f.name}  ${DIM}${humanSize(f.size)}${RESET}`, value: f.name })),
        { label: 'Cancel', value: null },
      ]);
      if (!file) continue;
      const ok = await confirm(`Overwrite the current database with "${file}"? This cannot be undone.`);
      if (!ok) continue;
      await restoreDatabase(file);
      await pause();
    } else if (action === 'restore-agent') {
      const tars = listBackups('agent-data-', '.tar.gz');
      if (tars.length === 0) {
        console.log(`  ${DIM}no agent-identity archives to restore from.${RESET}`);
        await pause();
        continue;
      }
      const file = await select<string | null>('Restore agent identities from which archive?', [
        ...tars.map((f) => ({ label: `${f.name}  ${DIM}${humanSize(f.size)}${RESET}`, value: f.name })),
        { label: 'Cancel', value: null },
      ]);
      if (!file) continue;
      const ok = await confirm(`Replace the agents' identity data with "${file}"? This cannot be undone.`);
      if (!ok) continue;
      await restoreAgentData(file);
      await pause();
    }
  }
}

// --- settings --------------------------------------------------------------

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
  if (!envFileExists()) return `${RED}missing — run setup${RESET}`;
  const values = readEnvFile();
  const missing = REQUIRED_KEYS[ENV].filter((key) => {
    const value = values[key] ?? '';
    return value === '' || value.startsWith('replace_me');
  });
  return missing.length === 0
    ? `${GREEN}ready${RESET}`
    : `${YELLOW}${missing.length} required value${missing.length === 1 ? '' : 's'} missing${RESET}`;
}

function checkEnv(): void {
  const values = readEnvFile();
  let allGood = true;
  console.log(`${BOLD}Required values for ${ENV}${RESET}`);
  for (const key of REQUIRED_KEYS[ENV]) {
    const value = values[key] ?? '';
    const ok = value !== '' && !value.startsWith('replace_me');
    if (!ok) allGood = false;
    console.log(`  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${key}`);
  }
  console.log(
    allGood
      ? `\n${GREEN}All required values are set.${RESET}`
      : `\n${YELLOW}Some values are missing — run setup.${RESET}`,
  );
}

// First-run / re-run setup: copy the template, generate secrets, and write
// the per-environment .env file.
async function runSetupWizard(): Promise<void> {
  clear();
  heading(`Set up .env.${ENV}`);
  const target = envFilePath();

  if (envFileExists()) {
    const ok = await confirm(`.env.${ENV} already exists. Overwrite it?`);
    if (!ok) return;
  }

  let content = '';
  const legacyEnv = join(REPO_ROOT, '.env');
  if (!envFileExists() && existsSync(legacyEnv)) {
    const adopt = await confirm('Found an existing .env — start from its values?');
    if (adopt) content = readFileSync(legacyEnv, 'utf8');
  }
  if (!content) content = readFileSync(envTemplatePath(), 'utf8');

  if (ENV === 'dev') {
    content = setEnvValue(content, 'JWT_SECRET', generateSecret());
    content = setEnvValue(content, 'AGENT_DB_ENCRYPTION_KEY', generateSecret());
    console.log(`${DIM}Generated JWT_SECRET and AGENT_DB_ENCRYPTION_KEY. Dev defaults cover the rest.${RESET}`);
  } else {
    content = setEnvValue(content, 'POSTGRES_PASSWORD', generateSecret());
    content = setEnvValue(content, 'JWT_SECRET', generateSecret());
    content = setEnvValue(content, 'AGENT_DB_ENCRYPTION_KEY', generateSecret());
    console.log(`${DIM}Generated POSTGRES_PASSWORD, JWT_SECRET, AGENT_DB_ENCRYPTION_KEY.${RESET}`);
    const xmtp = await ask('XMTP production gRPC endpoint (Enter to fill in later): ');
    if (xmtp) content = setEnvValue(content, 'XMTP_GRPC_URL', xmtp);
  }

  writeFileSync(target, content, { mode: 0o600 });
  chmodSync(target, 0o600);
  loadEnv({ path: target, override: true });
  console.log(`\n${GREEN}✓ wrote ${target}${RESET} ${DIM}(chmod 600)${RESET}`);
  if (ENV === 'prod') {
    console.log(`${YELLOW}Back up AGENT_DB_ENCRYPTION_KEY — losing it loses the agent identities.${RESET}`);
  }
  await pause();
}

async function settingsMenu(): Promise<void> {
  for (;;) {
    clear();
    heading('Settings');
    const exists = envFileExists();
    console.log(`Config file: ${BOLD}.env.${ENV}${RESET}  —  ${envSummaryLine()}\n`);

    const items: Choice<string>[] = [];
    if (ENV === 'dev') {
      items.push({ label: 'Systems', value: 'systems', hint: 'start / stop the dev environment' });
      items.push({ label: 'View logs', value: 'logs', hint: 'open the dev log folder' });
    }
    items.push({ label: exists ? 'Re-run setup' : 'Run setup', value: 'setup', hint: 'create the .env file + secrets' });
    items.push({ label: 'Check required values', value: 'check' });
    items.push({ label: 'Open .env in editor', value: 'edit' });
    items.push({ label: 'Back', value: 'back' });

    const action = await select<string>('Choose an action', items);
    if (action === 'back') return;

    if (action === 'systems') {
      await systemsMenu();
    } else if (action === 'logs') {
      await viewDevLogs();
    } else if (action === 'setup') {
      await runSetupWizard();
    } else if (action === 'check') {
      checkEnv();
      await pause();
    } else if (action === 'edit') {
      if (!exists) {
        console.log(`  ${DIM}no .env.${ENV} yet — run setup first.${RESET}`);
        await pause();
        continue;
      }
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'nano';
      await runShell(editor, [envFilePath()]);
      loadEnv({ path: envFilePath(), override: true });
    }
  }
}

// --- environment picker + main menu ---------------------------------------

async function pickEnvironment(): Promise<Env> {
  clear();
  console.log(`${BOLD}${CYAN}Goldilocks${RESET} ${DIM}control panel${RESET}\n`);
  return select<Env>('Which environment?', [
    { label: 'Development', value: 'dev', hint: 'local XMTP node + dev database' },
    { label: 'Production', value: 'prod', hint: 'the docker-compose.prod.yml stack' },
  ]);
}

// True if the named compose service has a running container.
async function composeServiceRunning(service: string): Promise<boolean> {
  const r = await capture(
    'docker',
    ['compose', '--env-file', `.env.${ENV}`, '-f', composeFile(), 'ps', '-q', service],
  );
  return r.code === 0 && r.out.trim().length > 0;
}

// On/off status for the current environment, shown as the dashboard cards.
async function dashboardStats(): Promise<StatItem[]> {
  if (ENV === 'dev') {
    const s = await devSystemStatus();
    return [
      { label: 'server', on: s.serverPid !== null },
      { label: 'agents', on: s.agentPid !== null },
      { label: 'database', on: s.dbUp },
      { label: 'XMTP node', on: s.xmtpUp },
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

function printDashboard(stats: StatItem[]): void {
  console.log(`${BOLD}${CYAN}Goldilocks${RESET} ${DIM}control panel${RESET}  ${envBadge()}\n`);
  renderStatRow(stats.map((s) => statCard(s.label, s.on)));
  console.log('');
}

async function mainMenu(): Promise<void> {
  for (;;) {
    clear();
    console.log(`${BOLD}${CYAN}Goldilocks${RESET} ${DIM}control panel${RESET}  ${envBadge()}`);
    console.log(`${DIM}refreshing status…${RESET}`);
    const stats = await dashboardStats();
    clear();
    printDashboard(stats);

    const items: Choice<string>[] = [
      { label: 'Admins', value: 'admins', hint: 'add / remove admin slots' },
      { label: 'Clients', value: 'clients', hint: 'view client plans' },
    ];
    if (ENV === 'prod') {
      items.push({ label: 'Deploy', value: 'deploy', hint: 'pull, preflight, build, migrate, restart' });
      items.push({ label: 'Production stack', value: 'stack', hint: 'status, logs, start / stop' });
      items.push({ label: 'Backups', value: 'backups', hint: 'list, run, restore' });
      items.push({ label: 'Cloudflare tunnel', value: 'tunnel', hint: 'start / stop, show URL' });
    }
    items.push({
      label: 'Settings',
      value: 'settings',
      hint: ENV === 'dev' ? 'systems, logs, .env config' : '.env config',
    });
    items.push({ label: 'Quit', value: 'quit' });

    const choice = await select<string>('What do you want to do?', items);
    if (choice === 'quit') return;
    if (choice === 'admins') await adminsMenu();
    else if (choice === 'clients') await clientsMenu();
    else if (choice === 'deploy') await deployAction();
    else if (choice === 'stack') await stackMenu();
    else if (choice === 'backups') await backupsMenu();
    else if (choice === 'tunnel') await tunnelMenu();
    else if (choice === 'settings') await settingsMenu();
  }
}

// --- non-interactive subcommands ------------------------------------------

const USAGE = `Goldilocks CLI

  npm run cli -- --dev             open the interactive menu (development)
  npm run cli -- --prod            open the interactive menu (production)

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
      await addAdmin(c, name);
      return;
    }
    if (verb === 'remove') {
      const target = resolveAdmin(await loadAdmins(c), args[1] ?? '');
      if (!target) {
        console.error(`no admin matches "${args[1] ?? ''}"`);
        process.exitCode = 1;
        return;
      }
      await removeAdmin(c, target);
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
  if (verb === 'url') await bashScript('tunnel-url.sh');
  else if (verb === 'start') await compose(['up', '-d', 'cloudflared']);
  else if (verb === 'stop') await compose(['stop', 'cloudflared']);
  else if (verb === 'restart') await compose(['restart', 'cloudflared']);
  else {
    console.error(`unknown: tunnel ${verb}`);
    process.exitCode = 1;
  }
}

async function stackOneShot(args: string[]): Promise<void> {
  const verb = (args[0] ?? 'status').toLowerCase();
  if (ENV === 'dev') {
    if (verb === 'up') await devUp();
    else if (verb === 'down') await devDown();
    else if (verb === 'status') await bashScript('dev-env.sh', ['status']);
    else if (verb === 'reset') await devReset();
    else {
      console.error(`unknown: stack ${verb} — in --dev it is one of: up, down, reset, status`);
      process.exitCode = 1;
    }
    return;
  }
  if (verb === 'deploy') {
    await bashScript('deploy.sh');
  } else if (verb === 'status') {
    await compose(['ps']);
  } else if (verb === 'up') {
    await compose(['up', '-d']);
  } else if (verb === 'down') {
    await compose(['down']);
  } else if (verb === 'backup') {
    await compose(['exec', 'backup', 'bash', '/usr/local/bin/backup.sh']);
  } else if (verb === 'logs' || verb === 'restart') {
    const service = args[1];
    if (!service) {
      console.error(`usage: stack ${verb} <service>`);
      process.exitCode = 1;
      return;
    }
    if (verb === 'logs') await compose(['logs', '-f', '--tail', '100', service]);
    else await compose(['restart', service]);
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
  readline.emitKeypressEvents(stdin);
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

  if (!stdin.isTTY) {
    console.error('The interactive CLI needs a terminal. Try a subcommand, e.g.:');
    console.error('  npm run cli -- --prod admins list');
    process.exitCode = 1;
    return;
  }

  ENV = env ?? (await pickEnvironment());
  loadEnv({ path: envFilePath() });
  if (!envFileExists()) {
    clear();
    heading('Settings');
    console.log(`${YELLOW}No .env.${ENV} file found — the ${ENV} environment needs one.${RESET}\n`);
    const ok = await confirm(`Set up .env.${ENV} now?`);
    if (ok) await runSetupWizard();
  }
  await mainMenu();
  clear();
  console.log('Bye.');
}

main().catch((err) => {
  console.error(`${RED}CLI error:${RESET}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
