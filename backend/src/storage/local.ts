import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { PresignedUpload, RenewResult, StorageProvider } from './provider.js';

// Local-disk storage. Attachment bytes are written to a directory on the
// box (a Docker volume in production) and served back by this backend.
//
// The iOS client stays provider-agnostic: it just sees an upload URL and an
// asset URL, both pointing at this backend. Bytes are end-to-end encrypted
// by the iOS app before upload, so what lands on disk is ciphertext; the
// unguessable object key is the access control on the asset URL, the same
// model IPFS uses.
//
// Upload and asset URLs are built from a per-request base URL the route
// handler passes in, so they track whatever host the client reached the
// server at — handy when that host is an ephemeral tunnel.
//
// This file holds upload-token issuance and disk read/write helpers. The
// HTTP routes (_local-upload, _local-asset) live in src/routes/attachments.ts.

interface UploadTicket {
  objectKey: string;
  contentType: string;
  filename: string;
  uploadedBy?: string;
  exp: number;
}

const TICKET_TTL_SECONDS = 5 * 60;

// Object keys are server-generated as `local-<uuid>`. This guard rejects
// anything else, so a crafted asset path cannot escape the storage dir.
const OBJECT_KEY_PATTERN = /^local-[0-9a-f-]+$/;

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly storageDir: string) {}

  static isValidObjectKey(objectKey: string): boolean {
    return OBJECT_KEY_PATTERN.test(objectKey);
  }

  assetUrlFor(baseUrl: string, objectKey: string): string {
    return `${baseUrl}/v2/_local-asset/${objectKey}`;
  }

  async presignedUpload(
    args: { contentType: string; filename: string; uploadedBy?: string },
    baseUrl?: string,
  ): Promise<PresignedUpload> {
    if (!baseUrl) {
      throw new Error('LocalStorageProvider.presignedUpload requires a baseUrl');
    }
    const objectKey = `local-${randomUUID()}`;
    const ticket: UploadTicket = {
      objectKey,
      contentType: args.contentType,
      filename: args.filename,
      uploadedBy: args.uploadedBy,
      exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
    };
    const ticketJwt = jwt.sign(ticket, config.JWT_SECRET, { algorithm: 'HS256' });

    return {
      objectKey,
      uploadUrl: `${baseUrl}/v2/_local-upload?ticket=${encodeURIComponent(ticketJwt)}`,
      assetUrl: this.assetUrlFor(baseUrl, objectKey),
    };
  }

  async writeBytes(objectKey: string, bytes: Buffer): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.filePath(objectKey), bytes);
  }

  async readBytes(objectKey: string): Promise<Buffer | null> {
    try {
      return await readFile(this.filePath(objectKey));
    } catch {
      return null;
    }
  }

  async renew(keys: string[]): Promise<RenewResult[]> {
    // Files persist on disk until explicitly deleted — nothing to renew.
    return keys.map((key) => ({ key, success: true }));
  }

  private filePath(objectKey: string): string {
    if (!LocalStorageProvider.isValidObjectKey(objectKey)) {
      throw new Error(`invalid object key: ${objectKey}`);
    }
    return join(this.storageDir, objectKey);
  }
}
