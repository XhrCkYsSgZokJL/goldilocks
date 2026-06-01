// Reports-watcher
//
// Watches the host's REPORTS_DIR (default ./reports) for files the
// operator has dropped in, and posts them to the matching client's
// Reports XMTP group:
//
//   *.pdf  → end-to-end-encrypted RemoteAttachment
//   *.txt  → plain-text chat message (TextCodec)
//
// Filename convention (both extensions share it):
//
//   <prefix>-<title>.<ext>
//   <prefix>_<title>.<ext>
//
// `<prefix>` selects the recipient(s) (case-insensitive):
//
//   123        a specific client by their human-readable id ("Reports #123")
//   B          broadcast to every client currently in the Bronze tier
//   S          broadcast to every client currently in the Silver tier
//   G          broadcast to every client currently in the Gold tier
//   E          broadcast to every client an admin has marked Emerald
//   0          broadcast to every client with a Reports channel
//
// Tier is computed server-side by `computeTier(seats, coverage,
// emeraldEnabled)` from src/billing/tier.ts — the same logic the iOS
// `GoldilocksMembershipTier` enum uses. Emerald is a manual override
// (admin-controlled flag on the client) and trumps the automatic
// B / S / G rules; an Emerald client appears only in Emerald and "all"
// broadcasts, never in B / S / G.
//
// `<title>` is humanised (- and _ → " ") for the cross-post to the
// admin Alerts group; the PDF's original basename is preserved in the
// RemoteAttachment so the client sees a sensible name when they open it.
// For broadcasts the PDF is encrypted + uploaded once, and the same
// RemoteAttachment is sent to every recipient group — each recipient
// can decrypt the shared blob via the secret carried in their copy of
// the message metadata.
//
// Pairing: if a .pdf and a .txt share the same basename
// (e.g. `1-q4.pdf` + `1-q4.txt`) they're processed together — the text
// is posted first as a chat message, then the PDF as an attachment, so
// the message reads top-down like an email with an attachment. Either
// file may be dropped alone:
//
//   .pdf alone → attachment only (no preamble)
//   .txt alone → standalone chat message (for brief announcements)
//
// Processed files are moved out of the watch root so the next poll
// doesn't re-pick them up:
//
//   reports/sent/<ISO>-<original>          — successfully posted
//   reports/failed/<ISO>-<original>        — could not be processed
//   reports/failed/<ISO>-<original>.err    — adjacent reason file
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
import { clients, clientChannels, reportJobs } from '../db/schema.js';
import { liveBalanceCents } from '../billing/balance.js';
import { computeTier, type MembershipTier, tierLabel } from '../billing/tier.js';
import { AuditLog } from './audit.js';
import { makeStorageProvider, type StorageProvider } from '../storage/index.js';
import { logger } from '../observability/logger.js';

const POLL_INTERVAL_MS = 60_000;
// fs.watch fires multiple events for one write on some filesystems
// (rename + change), so coalesce events that arrive within this window
// before kicking off a scan.
const WATCH_DEBOUNCE_MS = 250;
const PDF_EXT = '.pdf';
const TXT_EXT = '.txt';
const WATCHED_EXTS = [PDF_EXT, TXT_EXT] as const;
// Captures the `<prefix>` + `<title>` parts independent of which
// extension a file has — the extension is matched separately so .pdf
// and .txt can pair on the same basename. The prefix is either a
// numeric client id, one of the single-letter tier broadcasts
// (B/S/G/D), or `0` for the everyone broadcast.
const FILENAME_PATTERN = /^(\d+|[bsge])[-_](.+)\.(pdf|txt)$/i;
// Soft cap on text-message size. XMTP itself allows much larger
// messages, but a multi-megabyte chat bubble is almost always an
// operator mistake (someone dropped the wrong file) and we'd rather
// fail loudly than blast huge content into a group.
const MAX_TEXT_BYTES = 64 * 1024;
const REPORTS_ROLE = 'reports' as const;

// cp1252 → Unicode for the 32 code points where Windows-1252 differs
// from Latin-1 / Unicode. Used to decode `\'XX` escapes from RTF that
// TextEdit emits (smart quotes, em-dash, ellipsis, etc.). Anything
// outside this range maps one-for-one to Unicode and doesn't need an
// entry. The five undefined cp1252 slots (0x81, 0x8D, 0x8F, 0x90, 0x9D)
// are simply absent and fall through to the raw code point.
const CP1252_TO_UNICODE: Map<number, number> = new Map<number, number>([
  [0x80, 0x20AC], [0x82, 0x201A], [0x83, 0x0192], [0x84, 0x201E],
  [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02C6],
  [0x89, 0x2030], [0x8A, 0x0160], [0x8B, 0x2039], [0x8C, 0x0152],
  [0x8E, 0x017D], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201C],
  [0x94, 0x201D], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02DC], [0x99, 0x2122], [0x9A, 0x0161], [0x9B, 0x203A],
  [0x9C, 0x0153], [0x9E, 0x017E], [0x9F, 0x0178],
]);

export interface ReportsWatcherOptions {
  client: Client;
  // Shared audit-log handle for echoing recipient posts to the alerts
  // group. Must be constructed against the admins-agent client (the
  // only agent inbox in the alerts group) — passing the watcher's own
  // reports-agent client would make every audit post silently fail.
  audit: AuditLog;
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
    audit: opts.audit,
  });
  await watcher.start();
  return () => watcher.stop();
}

interface WatcherInternalOptions {
  client: Client;
  storage: StorageProvider;
  reportsDir: string;
  assetBaseUrl: string;
  audit: AuditLog;
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
        if (!filename || !isWatchedFilename(filename)) return;
        // Coalesce burst events from a single write before we scan.
        // Also gives us a small grace window so a .pdf + .txt pair
        // dropped one-after-the-other are picked up together rather
        // than the first triggering a scan before the second has
        // landed (and the second being seen as a standalone afterthought).
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
    // Group watched files by basename (everything before the extension)
    // so a paired drop like `1-q4.pdf` + `1-q4.txt` becomes a single
    // processing unit. Each group is dispatched once even if its files
    // arrived on different scans.
    const groups = new Map<string, FileGroup>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const name = e.name;
      const ext = extOf(name);
      if (!ext) continue;
      const basename = name.slice(0, -ext.length);
      const existing = groups.get(basename) ?? { basename };
      if (ext === PDF_EXT) existing.pdfFile = name;
      else if (ext === TXT_EXT) existing.txtFile = name;
      groups.set(basename, existing);
    }
    for (const group of groups.values()) {
      if (this.inFlight.has(group.basename)) continue;
      this.inFlight.add(group.basename);
      void this.processGroup(group).finally(() => this.inFlight.delete(group.basename));
    }
  }

  private async processGroup(group: FileGroup): Promise<void> {
    const refFile = group.pdfFile ?? group.txtFile;
    // Either pdfFile or txtFile is set (scanOnce only emits non-empty
    // groups), but TypeScript can't see that — guard explicitly.
    if (!refFile) return;

    const parsed = parseFilename(refFile);
    if (!parsed) {
      const reason = 'unrecognised filename — expected <prefix>-<title>.{pdf,txt} where <prefix> is a client number, B/S/G tier letter, or 0 (all clients)';
      for (const name of [group.pdfFile, group.txtFile]) {
        if (name) await this.moveToFailed(join(this.opts.reportsDir, name), name, reason);
      }
      return;
    }
    const { target, title } = parsed;

    // Track which files have already been moved out so the catch
    // block doesn't try to move them again (which would error).
    const moved: Set<string> = new Set<string>();
    const moveToFailedOnce = async (name: string, reason: string): Promise<void> => {
      if (moved.has(name)) return;
      moved.add(name);
      await this.moveToFailed(join(this.opts.reportsDir, name), name, reason);
    };

    try {
      const recipients: ReportRecipient[] = await resolveRecipients(target);
      if (recipients.length === 0) {
        const reason: string = describeEmptyTarget(target);
        for (const name of [group.pdfFile, group.txtFile]) {
          if (name) await moveToFailedOnce(name, reason);
        }
        return;
      }

      // Read + validate the text sidecar once. Even for broadcasts we
      // only do this work a single time and reuse the body across all
      // recipients.
      let messageBody: string | null = null;
      if (group.txtFile) {
        const txtPath: string = join(this.opts.reportsDir, group.txtFile);
        try {
          const raw: Buffer = await readFile(txtPath);
          if (raw.length > MAX_TEXT_BYTES) {
            throw new Error(`text sidecar is ${raw.length} bytes (cap ${MAX_TEXT_BYTES}) — drop a smaller file or use a PDF`);
          }
          // macOS TextEdit defaults to RTF when saving .txt files
          // unless the user has run Format → Make Plain Text. Detect
          // the RTF header and extract just the visible text so the
          // operator doesn't have to remember that toggle every time.
          const utf8: string = raw.toString('utf8').replace(/^﻿/, '');
          const extracted: string = looksLikeRtf(utf8) ? extractTextFromRtf(utf8) : utf8;
          const text: string = extracted.trim();
          if (!text) {
            throw new Error('text sidecar is empty (or could not be extracted from RTF)');
          }
          messageBody = text;
        } catch (err) {
          // Fail just the text file; if there's also a PDF, still send it.
          await moveToFailedOnce(group.txtFile, (err as Error).message);
          messageBody = null;
          if (!group.pdfFile) return;
        }
      }

      // Encrypt + upload the PDF once. RemoteAttachment carries the
      // shared secret in the message metadata for each recipient, so
      // every recipient group's members can decrypt the same ciphertext.
      let remoteAttachment: RemoteAttachment | null = null;
      if (group.pdfFile) {
        const pdfPath: string = join(this.opts.reportsDir, group.pdfFile);
        const bytes: Buffer = await readFile(pdfPath);
        // node-sdk's helper produces ciphertext + the metadata (digest,
        // nonce, salt, secret) the RemoteAttachment content type expects.
        const encrypted = encryptAttachment({
          filename: group.pdfFile,
          mimeType: 'application/pdf',
          content: bytes,
        });
        const { assetUrl } = await this.opts.storage.uploadBytes(
          {
            bytes: Buffer.from(encrypted.payload),
            filename: group.pdfFile,
            // The payload is opaque ciphertext to the storage backend.
            contentType: 'application/octet-stream',
          },
          this.opts.assetBaseUrl,
        );
        remoteAttachment = {
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
          filename: encrypted.filename ?? group.pdfFile,
        };
      }

      // Per-recipient send loop. We track succeeded/failed separately
      // so a partial broadcast still moves the file to sent/ (any
      // success) while individual misses get logged with a reason.
      const succeeded: number[] = [];
      const failed: { clientNumber: number; reason: string }[] = [];
      for (const recipient of recipients) {
        let jobId: number | null = null;
        try {
          // Audit row up-front so a partial failure is still recorded
          // — one row per recipient even for a broadcast.
          const inserted = await db
            .insert(reportJobs)
            .values({
              clientId: recipient.clientId,
              payload: {
                filename: group.pdfFile ?? group.txtFile,
                title,
                hasText: messageBody !== null,
                hasAttachment: group.pdfFile !== undefined,
                broadcastTarget: describeTarget(target),
              },
              scheduledAt: new Date(),
            })
            .returning({ id: reportJobs.id });
          jobId = inserted[0]?.id ?? null;

          const reportsGroup: Group | null = await this.lookupGroup(recipient.channelGroupId);
          if (!reportsGroup) {
            const reason: string = `Reports group ${recipient.channelGroupId.slice(0, 8)}… not present on this agent`;
            if (jobId !== null) await this.markFailed(jobId, reason);
            failed.push({ clientNumber: recipient.clientNumber, reason });
            continue;
          }

          // Refresh the agent's view of the network in two passes
          // before sending.
          //
          // 1) `client.conversations.syncAll()` is a brute-force pull
          //    across every conversation the agent is in. This breaks
          //    "stuck-epoch" log jams where the agent's local libxmtp
          //    state is behind the network because group.sync() is
          //    cursor-conservative and won't pull commits it doesn't
          //    already know about. Symptom that prompted this: every
          //    publishMessages() timing out at ~240ms with epoch never
          //    advancing.
          // 2) The targeted group.sync() then makes sure the per-group
          //    epoch is current. Cheap follow-up after syncAll.
          try {
            const syncAllStart = Date.now();
            const summary = await this.opts.client.conversations.syncAll();
            log(`[reports-watcher] client.syncAll (Reports #${recipient.clientNumber}) OK in ${Date.now() - syncAllStart}ms — eligible=${summary.numEligible} synced=${summary.numSynced}`);
          } catch (err) {
            log(`[reports-watcher] client.syncAll (Reports #${recipient.clientNumber}) failed: ${(err as Error).message} — proceeding`);
          }
          try {
            await reportsGroup.sync();
          } catch (err) {
            log(`[reports-watcher] group.sync (Reports #${recipient.clientNumber}) failed: ${(err as Error).message} — proceeding`);
          }
          // Text first, then attachment — reads top-down like an email.
          if (messageBody !== null) {
            await sendTextWithRetry(reportsGroup, messageBody);
          }
          if (remoteAttachment) {
            await sendAttachmentWithRetry(reportsGroup, remoteAttachment);
          }

          if (jobId !== null) {
            await db
              .update(reportJobs)
              .set({ status: 'posted', postedAt: new Date() })
              .where(eq(reportJobs.id, jobId));
          }
          succeeded.push(recipient.clientNumber);
        } catch (err) {
          const reason: string = (err as Error).message;
          if (jobId !== null) await this.markFailed(jobId, reason);
          failed.push({ clientNumber: recipient.clientNumber, reason });
          log(`[reports-watcher]   Reports #${recipient.clientNumber} failed: ${reason}`);
        }
      }

      // Echo to the admin audit log so admins can see what went out.
      if (succeeded.length > 0) {
        const preface: string = buildAuditPreface(target, title, {
          sentCount: succeeded.length,
          totalCount: recipients.length,
        });
        if (messageBody !== null) {
          await this.opts.audit.postText(`${preface}: ${messageBody}`);
        }
        if (remoteAttachment) {
          await this.opts.audit.postAttachment(remoteAttachment);
        }
      }

      if (succeeded.length === 0) {
        const reason: string = failed.length > 0
          ? `all ${recipients.length} recipient(s) failed: ${failed.slice(0, 3).map((f) => `#${f.clientNumber} (${f.reason})`).join('; ')}`
          : 'no recipients';
        for (const name of [group.pdfFile, group.txtFile]) {
          if (name) await moveToFailedOnce(name, reason);
        }
        log(`[reports-watcher] failed ${group.basename}: ${reason}`);
        return;
      }

      for (const name of [group.txtFile, group.pdfFile]) {
        if (name && !moved.has(name)) {
          await this.moveToSent(join(this.opts.reportsDir, name), name);
          moved.add(name);
        }
      }
      const kind: string = remoteAttachment && messageBody !== null
        ? 'message + report'
        : remoteAttachment
          ? 'report'
          : 'message';
      const scope: string = describeSucceededScope(target, succeeded.length, recipients.length);
      const failedSuffix: string = failed.length === 0
        ? ''
        : ` (failed: ${failed.map((f) => `#${f.clientNumber}`).join(', ')})`;
      log(`[reports-watcher] sent ${kind} "${title}" to ${scope}${failedSuffix}`);
    } catch (err) {
      const msg: string = (err as Error).message;
      // Park any files that haven't already been moved out.
      for (const name of [group.pdfFile, group.txtFile]) {
        if (name && !moved.has(name)) {
          await this.moveToFailed(join(this.opts.reportsDir, name), name, msg);
        }
      }
      log(`[reports-watcher] failed ${group.basename}: ${msg}`);
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
// Send the encrypted attachment synchronously and retry once on a
// transient `SyncFailedToWait` — the in-process auto-responder uses
// the same synchronous-send pattern reliably, so the only thing the
// optimistic + publishMessages pattern bought us was indefinite
// silent queueing when the network commit timed out. The caller has
// already done `group.sync()` so the agent's epoch view is fresh
// before we ask libxmtp to commit.
async function sendAttachmentWithRetry(group: Group, remoteAttachment: RemoteAttachment): Promise<void> {
  // Optimistic mode: writes the intent to the agent's local SQLCipher
  // store and returns immediately. The actual network commit happens
  // in `publishMessages` below, where libxmtp handles MLS-epoch races
  // internally rather than throwing SyncFailedToWait at us.
  await optimisticSendAndPublish('attachment', group, async () => {
    await group.sendRemoteAttachment(remoteAttachment, true);
  });
}

async function sendTextWithRetry(group: Group, body: string): Promise<void> {
  await optimisticSendAndPublish('text', group, async () => {
    await group.sendText(body, true);
  });
}

// Capture the group's MLS state so we have a structural fingerprint to
// stick next to SyncFailedToWait errors. Best-effort — if the SDK call
// itself errors we still want the send path to proceed. Returns a
// short string the caller can log inline.
async function groupDebugFingerprint(group: Group): Promise<string> {
  try {
    const info = await group.debugInfo();
    const epoch = info.epoch.toString();
    const fork = info.maybeForked ? 'forked' : 'ok';
    let memberCount: string;
    try {
      const members = await group.members();
      memberCount = String(members.length);
    } catch {
      memberCount = '?';
    }
    return `epoch=${epoch} members=${memberCount} fork=${fork}`;
  } catch (err) {
    return `debugInfo-failed=${(err as Error).message}`;
  }
}

// Two-step send: optimistic queue first, then publishMessages to push
// every queued intent to the network. publishMessages is the right
// retry surface for the SyncFailedToWait race — it's libxmtp's
// intended pattern for "the client moved the epoch under me." On a
// publish failure we resync and retry; the previously-queued intent
// stays in libxmtp's local store, so the retry just publishes the
// same blob without re-encoding it. Total worst case: 4 attempts
// with 750ms / 2s / 4s / 8s backoffs, ~14.75s before giving up.
async function optimisticSendAndPublish(
  label: string,
  group: Group,
  queueMessage: () => Promise<void>,
): Promise<void> {
  // Step 1: queue locally. This is fast and shouldn't ever fail with
  // SyncFailedToWait (no network commit yet).
  const preFp = await groupDebugFingerprint(group);
  log(`[reports-watcher] queue ${label}: pre-queue ${preFp}`);
  const queueStart = Date.now();
  try {
    await queueMessage();
  } catch (err) {
    log(`[reports-watcher] queue ${label} FAILED in ${Date.now() - queueStart}ms: ${(err as Error).message}`);
    throw err;
  }
  log(`[reports-watcher] queue ${label} OK in ${Date.now() - queueStart}ms`);

  // Step 2: publish, with retries on SyncFailedToWait.
  const backoffMs: readonly number[] = [750, 2000, 4000, 8000] as const;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < backoffMs.length + 1; attempt++) {
    const publishStart = Date.now();
    try {
      await group.publishMessages();
      const elapsedMs = Date.now() - publishStart;
      if (attempt === 0) {
        log(`[reports-watcher] publish ${label} OK in ${elapsedMs}ms (attempt 1)`);
      } else {
        log(`[reports-watcher] publish ${label} OK in ${elapsedMs}ms (attempt ${attempt + 1} of ${backoffMs.length + 1})`);
      }
      return;
    } catch (err) {
      lastErr = err as Error;
      const elapsedMs = Date.now() - publishStart;
      const msg: string = lastErr.message;
      const postFp = await groupDebugFingerprint(group);
      log(`[reports-watcher] publish ${label} attempt ${attempt + 1} FAILED in ${elapsedMs}ms: ${msg}; ${postFp}`);

      if (!msg.includes('SyncFailedToWait')) {
        throw err;
      }
      if (attempt === backoffMs.length) break;
      const delayMs = backoffMs[attempt] ?? 0;
      log(`[reports-watcher] re-syncing group then retrying publish in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const syncStart = Date.now();
        await group.sync();
        log(`[reports-watcher] inter-retry sync OK in ${Date.now() - syncStart}ms`);
      } catch (syncErr) {
        log(`[reports-watcher] inter-retry sync FAILED: ${(syncErr as Error).message} — trying publish anyway`);
      }
    }
  }
  throw lastErr ?? new Error('publishMessages exhausted attempts');
}

// Header line for the admin audit-log echo. The body / attachment
// that follow are exactly what landed in the recipient channel(s);
// this just tells admins WHO received it. Partial broadcasts append
// "(N of M)" so admins can see at a glance if anything was missed.
function buildAuditPreface(
  target: ResolvedTarget,
  _title: string,
  counts: { sentCount: number; totalCount: number },
): string {
  const scope: string = describeTarget(target);
  if (target.kind === 'client') return `Sent to ${scope}`;
  if (counts.sentCount === counts.totalCount) return `Sent to ${scope}`;
  return `Sent to ${scope} (${counts.sentCount} of ${counts.totalCount})`;
}

interface FileGroup {
  basename: string;
  pdfFile?: string;
  txtFile?: string;
}

// Lowercase extension including the leading dot, or null if the file
// isn't one we watch.
function extOf(filename: string): typeof WATCHED_EXTS[number] | null {
  const lower = filename.toLowerCase();
  for (const ext of WATCHED_EXTS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

function isWatchedFilename(filename: string): boolean {
  return extOf(filename) !== null;
}

// macOS TextEdit signature for a default-saved .txt file. The header
// always begins with `{\rtf<version>`, regardless of what version /
// flavour TextEdit emits.
function looksLikeRtf(text: string): boolean {
  return /^\s*\{\\rtf\d/.test(text);
}

// Pull the visible text out of an RTF blob. This is intentionally a
// pragmatic regex-based strip aimed at TextEdit's output rather than a
// full RTF parser — we only need to recover the body of a short
// message a human typed. The steps:
//   1. Drop the well-known header tables (fonttbl, colortbl, …)
//      whose contents are pure markup with no message text.
//   2. Decode `\'XX` hex escapes (used for ANSI extended chars).
//   3. Decode `\uNNNN?` Unicode escapes (full Unicode pass-through).
//   4. Convert `\par` and `\line` into newlines.
//   5. Strip every remaining control word (`\xxx[-N]`) — these are
//      formatting directives the chat doesn't render anyway.
//   6. Unescape `\\`, `\{`, `\}` to literal chars, then drop any
//      stray braces left over from the outermost group.
//   7. Collapse runs of whitespace and trim.
function extractTextFromRtf(rtf: string): string {
  // Each prefix is a literal RTF group opener: `{` + control sequence.
  // Destinations like `{\*\expandedcolortbl …}` use the `\*` marker.
  const groupOpeners: string[] = [
    '{\\fonttbl',
    '{\\colortbl',
    '{\\stylesheet',
    '{\\listtable',
    '{\\listoverridetable',
    '{\\rsidtbl',
    '{\\generator',
    '{\\info',
    '{\\*\\expandedcolortbl',
    '{\\*\\latentstyles',
    '{\\*\\rsidtbl',
  ];
  let text: string = rtf;
  for (const opener of groupOpeners) {
    text = stripBalancedGroup(text, opener);
  }
  // `\'XX` in RTF is a Windows-1252 (cp1252) code point, not raw
  // Unicode. The 0xA0-0xFF range happens to match Latin-1 Supplement
  // one-for-one, but 0x80-0x9F is where cp1252 carries the typographic
  // chars TextEdit emits most often — smart quotes, em/en dash,
  // ellipsis, etc. Translate just that gap so they survive intact.
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex: string) => {
    const code: number = parseInt(hex, 16);
    return String.fromCharCode(CP1252_TO_UNICODE.get(code) ?? code);
  });
  text = text.replace(/\\u(-?\d+)\??/g, (_match, code: string) =>
    String.fromCharCode(parseInt(code, 10) & 0xFFFF),
  );
  text = text.replace(/\\par[d]?\b ?/g, '\n');
  text = text.replace(/\\line\b ?/g, '\n');
  text = text.replace(/\\[a-zA-Z*]+-?\d* ?/g, '');
  text = text.replace(/\\([\\{}])/g, '$1');
  text = text.replace(/[{}]/g, '');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// Remove every occurrence of a `{<opener>…}` group, respecting nested
// braces. RTF tables can contain nested groups (e.g. \fonttbl with
// inner `{\f0 …}` font entries), and a naive regex would stop at the
// first inner `}`.
function stripBalancedGroup(text: string, opener: string): string {
  for (;;) {
    const start: number = text.indexOf(opener);
    if (start < 0) return text;
    let depth: number = 0;
    let end: number = -1;
    for (let i = start; i < text.length; i += 1) {
      const char: string = text.charAt(i);
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return text;
    text = text.slice(0, start) + text.slice(end + 1);
  }
}

// What a parsed filename prefix resolves to. Drives both who gets the
// post and how the audit-channel preface + log lines are phrased.
type ResolvedTarget =
  | { kind: 'client'; clientNumber: number }
  | { kind: 'tier'; tier: MembershipTier }
  | { kind: 'all' };

interface ParsedFilename {
  target: ResolvedTarget;
  title: string;
}

function parseFilename(filename: string): ParsedFilename | null {
  const match: RegExpMatchArray | null = filename.match(FILENAME_PATTERN);
  if (!match) return null;
  const prefixPart: string | undefined = match[1];
  const titlePart: string | undefined = match[2];
  if (!prefixPart || !titlePart) return null;
  const target: ResolvedTarget | null = parsePrefix(prefixPart);
  if (!target) return null;
  // Replace any run of separators with a single space; trim edges.
  const title: string = titlePart.replace(/[-_]+/g, ' ').trim();
  if (!title) return null;
  return { target, title };
}

function parsePrefix(raw: string): ResolvedTarget | null {
  const upper: string = raw.toUpperCase();
  if (upper === '0') return { kind: 'all' };
  if (upper === 'B') return { kind: 'tier', tier: 'bronze' };
  if (upper === 'S') return { kind: 'tier', tier: 'silver' };
  if (upper === 'G') return { kind: 'tier', tier: 'gold' };
  if (upper === 'E') return { kind: 'tier', tier: 'emerald' };
  const n: number = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return { kind: 'client', clientNumber: n };
  return null;
}

// Human-readable label used as the audit-log preface ("Sent to <scope>")
// and the broadcastTarget audit field on report_jobs.payload.
export function describeTarget(target: ResolvedTarget): string {
  switch (target.kind) {
    case 'client': return `Reports #${target.clientNumber}`;
    case 'tier': return `${tierLabel(target.tier)} clients`;
    case 'all': return 'all clients';
  }
}

function describeEmptyTarget(target: ResolvedTarget): string {
  switch (target.kind) {
    case 'client': return `no Reports channel for client #${target.clientNumber}`;
    case 'tier': return `no clients are currently in the ${tierLabel(target.tier)} tier`;
    case 'all': return 'no clients have a Reports channel yet';
  }
}

// "Reports #N" for a single client; "M clients (scope)" for broadcasts.
function describeSucceededScope(target: ResolvedTarget, sentCount: number, totalCount: number): string {
  if (target.kind === 'client') return `Reports #${target.clientNumber}`;
  const scope: string = target.kind === 'tier' ? `${tierLabel(target.tier)} tier` : 'all clients';
  const plural: string = totalCount === 1 ? '' : 's';
  if (sentCount === totalCount) return `${totalCount} client${plural} (${scope})`;
  return `${sentCount}/${totalCount} client${plural} (${scope})`;
}

interface ReportRecipient {
  clientId: string;
  clientNumber: number;
  channelGroupId: string;
}

// Resolve a parsed target to the list of recipients with active
// Reports channels. For broadcasts we pull every channel + the
// billing fields needed to compute each client's tier, then filter
// in-memory — cheap at our scale and centralises the tier math next
// to `liveBalanceCents` rather than expressing it as SQL.
async function resolveRecipients(target: ResolvedTarget): Promise<ReportRecipient[]> {
  if (target.kind === 'client') {
    const [row] = await db
      .select({
        clientId: clientChannels.clientId,
        clientNumber: clients.clientNumber,
        channelGroupId: clientChannels.xmtpGroupId,
      })
      .from(clientChannels)
      .innerJoin(clients, eq(clientChannels.clientId, clients.id))
      .where(and(
        eq(clients.clientNumber, target.clientNumber),
        eq(clientChannels.role, REPORTS_ROLE),
      ))
      .limit(1);
    if (!row?.channelGroupId) return [];
    return [{
      clientId: row.clientId,
      clientNumber: row.clientNumber,
      channelGroupId: row.channelGroupId,
    }];
  }

  const rows = await db
    .select({
      clientId: clients.id,
      clientNumber: clients.clientNumber,
      channelGroupId: clientChannels.xmtpGroupId,
      billingBalanceCents: clients.billingBalanceCents,
      billingSeats: clients.billingSeats,
      billingBalanceAsOf: clients.billingBalanceAsOf,
      emeraldMembershipEnabled: clients.emeraldMembershipEnabled,
    })
    .from(clientChannels)
    .innerJoin(clients, eq(clientChannels.clientId, clients.id))
    .where(eq(clientChannels.role, REPORTS_ROLE));

  // Drop rows whose Reports channel hasn't actually been provisioned
  // yet (xmtpGroupId is nullable in the schema — pending channels), and
  // tier-filter the rest. Stable order by client number so log lines
  // and audit rows are predictable across runs.
  const matched = rows
    .filter((r): r is typeof r & { channelGroupId: string } => r.channelGroupId !== null)
    .filter((r) => {
      if (target.kind === 'all') return true;
      const hasCoverage: boolean = liveBalanceCents(r) > 0;
      const tier: MembershipTier = computeTier(r.billingSeats, hasCoverage, r.emeraldMembershipEnabled);
      return tier === target.tier;
    });
  matched.sort((a, b) => a.clientNumber - b.clientNumber);

  return matched.map((r) => ({
    clientId: r.clientId,
    clientNumber: r.clientNumber,
    channelGroupId: r.channelGroupId,
  }));
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const watcherLog = logger.child({ module: 'agent.reports-watcher' });

function log(msg: string): void {
  watcherLog.info(msg);
}
