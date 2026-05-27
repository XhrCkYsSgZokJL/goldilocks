// Reports-watcher
//
// Watches the host's REPORTS_DIR (default ./reports) for PDF files the
// operator has dropped in, and posts each one as an end-to-end-encrypted
// RemoteAttachment to the matching client's Reports XMTP group.
//
// Filename convention:
//
//   <clientNumber>-<title>.pdf
//   <clientNumber>_<title>.pdf
//
// `<clientNumber>` is the human-readable id ("Reports #55" → 55).
// `<title>` is humanised (- and _ → " ") for the cross-post to the
// admin Alerts group; the file's original basename is preserved in the
// RemoteAttachment so the client sees a sensible name when they open it.
//
// Processed files are moved out of the watch root so the next poll
// doesn't re-pick them up:
//
//   reports/sent/<ISO>-<original>.pdf      — successfully posted
//   reports/failed/<ISO>-<original>.pdf    — could not be processed
//   reports/failed/<ISO>-<original>.pdf.err — adjacent reason file
//
// The watch loop is a simple poller (every 60s) plus an immediate scan
// at boot, so any file dropped while the agent was down still gets
// picked up. `fs.watch` is intentionally avoided — it's flaky over
// network volumes and bind mounts, and a 60s lag on a "drop a finished
// report" workflow is fine.

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  type Client,
  type Group,
  encryptAttachment,
  type RemoteAttachment,
} from '@xmtp/node-sdk';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { clients, clientChannels, reportJobs, serverGroups } from '../db/schema.js';
import { makeStorageProvider, type StorageProvider } from '../storage/index.js';

const POLL_INTERVAL_MS = 60_000;
// fs.watch fires multiple events for one write on some filesystems
// (rename + change), so coalesce events that arrive within this window
// before kicking off a scan.
const WATCH_DEBOUNCE_MS = 250;
const PDF_EXT = '.pdf';
const FILENAME_PATTERN = /^(\d+)[-_](.+)\.pdf$/i;
const ALERTS_GROUP_KIND = 'alerts';
const REPORTS_ROLE = 'reports' as const;

export interface ReportsWatcherOptions {
  client: Client;
}

/**
 * Start the reports-watcher. Returns a `stop()` function the caller
 * should call from its shutdown handler so the polling timer doesn't
 * keep the process alive after the agent's other resources have torn
 * down.
 */
export async function startReportsWatcher(opts: ReportsWatcherOptions): Promise<() => void> {
  const reportsDir = config.REPORTS_DIR;
  // Mirrors the fallback in server.ts so the local storage provider
  // gets a usable baseUrl even when PUBLIC_BASE_URL isn't set — needed
  // for the `_local-asset` URL the iOS client GETs.
  const publicBaseUrl = config.PUBLIC_BASE_URL
    ?? `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`;
  // All HTTP routes (including `_local-asset`) are mounted under /api
  // in server.ts. The watcher hands this as the asset base to the
  // storage provider so generated URLs land on the actual route and
  // not on the bare host (which Fastify 404s — iOS then hashes the
  // 404 JSON body and rejects the RemoteAttachment as invalidDigest).
  const assetBaseUrl = `${publicBaseUrl.replace(/\/+$/, '')}/api`;
  const storage = makeStorageProvider(assetBaseUrl);

  const watcher = new ReportsWatcher({
    client: opts.client,
    storage,
    reportsDir,
    assetBaseUrl,
  });
  await watcher.start();
  return () => watcher.stop();
}

interface WatcherInternalOptions {
  client: Client;
  storage: StorageProvider;
  reportsDir: string;
  assetBaseUrl: string;
}

class ReportsWatcher {
  private intervalHandle: NodeJS.Timeout | null = null;
  private fsWatcher: FSWatcher | null = null;
  private debounceHandle: NodeJS.Timeout | null = null;
  private readonly inFlight: Set<string> = new Set();

  constructor(private readonly opts: WatcherInternalOptions) {}

  async start(): Promise<void> {
    await this.ensureDirs();
    log(`[reports-watcher] watching ${this.opts.reportsDir}`);
    // Boot scan: catch anything dropped while the agent was down.
    await this.scanOnce();
    // 60s safety-net poll for filesystems where fs.watch is unreliable
    // (network mounts, bind volumes). fs.watch is the fast path —
    // catches drops within a few hundred milliseconds.
    this.intervalHandle = setInterval(() => {
      this.scanOnce().catch((err) => log(`[reports-watcher] scan error: ${(err as Error).message}`));
    }, POLL_INTERVAL_MS);
    this.startFsWatcher();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch {}
      this.fsWatcher = null;
    }
  }

  private startFsWatcher(): void {
    try {
      this.fsWatcher = fsWatch(this.opts.reportsDir, (_eventType, filename) => {
        if (!filename || !filename.toLowerCase().endsWith(PDF_EXT)) return;
        // Coalesce burst events from a single write before we scan.
        if (this.debounceHandle) clearTimeout(this.debounceHandle);
        this.debounceHandle = setTimeout(() => {
          this.debounceHandle = null;
          this.scanOnce().catch((err) =>
            log(`[reports-watcher] watch-triggered scan error: ${(err as Error).message}`),
          );
        }, WATCH_DEBOUNCE_MS);
      });
      this.fsWatcher.on('error', (err) => {
        log(`[reports-watcher] fs.watch error: ${err.message} (falling back to polling)`);
      });
    } catch (err) {
      log(`[reports-watcher] fs.watch unavailable: ${(err as Error).message} (polling only)`);
    }
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.opts.reportsDir, { recursive: true });
    await mkdir(join(this.opts.reportsDir, 'sent'), { recursive: true });
    await mkdir(join(this.opts.reportsDir, 'failed'), { recursive: true });
  }

  private async scanOnce(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.opts.reportsDir, { withFileTypes: true });
    } catch (err) {
      log(`[reports-watcher] readdir failed: ${(err as Error).message}`);
      return;
    }
    const pdfs = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(PDF_EXT))
      .map((e) => e.name);
    for (const name of pdfs) {
      if (this.inFlight.has(name)) continue;
      this.inFlight.add(name);
      // Fire and forget — the in-flight set prevents the next tick from
      // double-processing while we're still working on this one.
      void this.processFile(name).finally(() => this.inFlight.delete(name));
    }
  }

  private async processFile(filename: string): Promise<void> {
    const filePath = join(this.opts.reportsDir, filename);
    const parsed = parseFilename(filename);
    if (!parsed) {
      await this.moveToFailed(filePath, filename, 'unrecognised filename — expected <clientNumber>-<title>.pdf or <clientNumber>_<title>.pdf');
      return;
    }
    const { clientNumber, title } = parsed;

    let jobId: number | null = null;
    try {
      const target = await resolveClientAndChannel(clientNumber);
      if (!target) {
        await this.moveToFailed(filePath, filename, `no Reports channel for client #${clientNumber}`);
        return;
      }
      const { clientId, channelGroupId } = target;

      // Audit row up-front so a partial failure is still recorded.
      const inserted = await db
        .insert(reportJobs)
        .values({
          clientId,
          payload: { filename, title },
          scheduledAt: new Date(),
        })
        .returning({ id: reportJobs.id });
      jobId = inserted[0]?.id ?? null;

      const bytes = await readFile(filePath);
      // node-sdk's helper produces ciphertext + the metadata (digest,
      // nonce, salt, secret) the RemoteAttachment content type expects.
      const encrypted = encryptAttachment({
        filename,
        mimeType: 'application/pdf',
        content: bytes,
      });

      const { assetUrl } = await this.opts.storage.uploadBytes(
        {
          bytes: Buffer.from(encrypted.payload),
          filename,
          // The payload is opaque ciphertext to the storage backend.
          contentType: 'application/octet-stream',
        },
        this.opts.assetBaseUrl,
      );

      const remoteAttachment: RemoteAttachment = {
        url: assetUrl,
        contentDigest: encrypted.contentDigest,
        secret: encrypted.secret,
        salt: encrypted.salt,
        nonce: encrypted.nonce,
        // XMTP iOS rejects RemoteAttachments whose `scheme` metadata
        // isn't "https" (RemoteAttachmentError.invalidScheme). The
        // field is validated as metadata, not used to construct the
        // fetch URL (that's `url`), so it's safe to always declare
        // "https" even when the dev-local URL is http. In production
        // both the storage backend (lighthouse / S3) and the URL
        // scheme will actually be https, so this is a no-op.
        scheme: 'https',
        contentLength: encrypted.contentLength,
        filename: encrypted.filename ?? filename,
      };

      const reportsGroup = await this.lookupGroup(channelGroupId);
      if (!reportsGroup) {
        await this.moveToFailed(
          filePath,
          filename,
          `Reports group ${channelGroupId.slice(0, 8)}… not present on this agent — sync first`,
        );
        if (jobId !== null) await this.markFailed(jobId, 'group not present on agent');
        return;
      }
      await sendOptimisticAttachment(reportsGroup, remoteAttachment);

      // Best-effort cross-post to admin Alerts so admins see what went
      // out. Failures here don't roll back the client-side post.
      await this.crossPostToAlerts(`[Reports #${clientNumber}] ${title}`);

      if (jobId !== null) {
        await db
          .update(reportJobs)
          .set({ status: 'posted', postedAt: new Date() })
          .where(eq(reportJobs.id, jobId));
      }
      await this.moveToSent(filePath, filename);
      log(`[reports-watcher] sent "${title}" to Reports #${clientNumber}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (jobId !== null) await this.markFailed(jobId, msg);
      await this.moveToFailed(filePath, filename, msg);
      log(`[reports-watcher] failed ${filename}: ${msg}`);
    }
  }

  private async lookupGroup(groupId: string): Promise<Group | null> {
    try {
      await this.opts.client.conversations.sync();
      const conv = await this.opts.client.conversations.getConversationById(groupId);
      if (!conv) return null;
      // RemoteAttachment posting only makes sense on a Group.
      return conv as Group;
    } catch (err) {
      log(`[reports-watcher] lookupGroup(${groupId.slice(0, 8)}…) failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async crossPostToAlerts(line: string): Promise<void> {
    try {
      const [row] = await db
        .select({ xmtpGroupId: serverGroups.xmtpGroupId })
        .from(serverGroups)
        .where(eq(serverGroups.kind, ALERTS_GROUP_KIND))
        .limit(1);
      if (!row?.xmtpGroupId) return;
      const group = await this.lookupGroup(row.xmtpGroupId);
      if (!group) return;
      await group.sendText(line);
    } catch (err) {
      log(`[reports-watcher] alerts cross-post failed: ${(err as Error).message}`);
    }
  }

  private async markFailed(jobId: number, error: string): Promise<void> {
    try {
      await db
        .update(reportJobs)
        .set({ status: 'failed', error })
        .where(eq(reportJobs.id, jobId));
    } catch (err) {
      log(`[reports-watcher] markFailed(${jobId}) failed: ${(err as Error).message}`);
    }
  }

  private async moveToSent(filePath: string, filename: string): Promise<void> {
    const stamped = `${timestampPrefix()}-${filename}`;
    try {
      await rename(filePath, join(this.opts.reportsDir, 'sent', stamped));
    } catch (err) {
      log(`[reports-watcher] moveToSent(${filename}) failed: ${(err as Error).message}`);
    }
  }

  private async moveToFailed(filePath: string, filename: string, reason: string): Promise<void> {
    const stamped = `${timestampPrefix()}-${filename}`;
    const dest = join(this.opts.reportsDir, 'failed', stamped);
    try {
      await rename(filePath, dest);
      await writeFile(`${dest}.err`, `${reason}\n`, 'utf8');
    } catch (err) {
      log(`[reports-watcher] moveToFailed(${filename}) failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Send the attachment optimistically: the intent is recorded in the
 * agent's local SQLCipher store immediately and `publishMessages()`
 * pushes it to the XMTP network in a separate step. This sidesteps
 * libxmtp's `SyncFailedToWait` error, which fires when the synchronous
 * send waits for a commit acknowledgement that takes too long. With
 * optimistic send we never wait, so we never time out; if the publish
 * itself errors transiently, the intent stays queued and gets
 * republished on the agent's next activity, so the message still
 * lands on the client side.
 */
async function sendOptimisticAttachment(group: Group, remoteAttachment: RemoteAttachment): Promise<void> {
  await group.sendRemoteAttachment(remoteAttachment, true);
  try {
    await group.publishMessages();
  } catch (err) {
    // Best-effort — the intent is durably queued, so we treat publish
    // failures as warnings rather than rolling back the file. The
    // agent's periodic reconcile + any future activity on the group
    // will re-attempt the push.
    log(`[reports-watcher] publishMessages deferred: ${(err as Error).message} (intent queued, will republish)`);
  }
}

function parseFilename(filename: string): { clientNumber: number; title: string } | null {
  const match = filename.match(FILENAME_PATTERN);
  if (!match) return null;
  const numberPart = match[1];
  const titlePart = match[2];
  if (!numberPart || !titlePart) return null;
  const clientNumber = Number.parseInt(numberPart, 10);
  if (!Number.isFinite(clientNumber) || clientNumber <= 0) return null;
  // Replace any run of separators with a single space; trim edges.
  const title = titlePart.replace(/[-_]+/g, ' ').trim();
  if (!title) return null;
  return { clientNumber, title };
}

interface ReportTarget {
  clientId: string;
  channelGroupId: string;
}

async function resolveClientAndChannel(clientNumber: number): Promise<ReportTarget | null> {
  const [row] = await db
    .select({
      clientId: clientChannels.clientId,
      channelGroupId: clientChannels.xmtpGroupId,
    })
    .from(clientChannels)
    .innerJoin(clients, eq(clientChannels.clientId, clients.id))
    .where(and(
      eq(clients.clientNumber, clientNumber),
      eq(clientChannels.role, REPORTS_ROLE),
    ))
    .limit(1);
  if (!row?.channelGroupId) return null;
  return { clientId: row.clientId, channelGroupId: row.channelGroupId };
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}
