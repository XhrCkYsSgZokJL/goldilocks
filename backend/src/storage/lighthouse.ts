import type { DirectUpload, PresignedUpload, RenewResult, StorageProvider } from './provider.js';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

// Lighthouse-backed storage.
//
// Lighthouse doesn't have a native "presigned PUT URL" concept like S3,
// so we proxy uploads through this backend: the iOS client PUTs to a
// short-lived endpoint here, we forward the bytes to Lighthouse, store
// the resulting CID, and the asset URL is the IPFS gateway URL.
//
// This file holds the *issuance* of upload tokens (and renew). The actual
// proxy upload handler lives in src/routes/attachments.ts so it can take
// the raw request body.

import jwt from 'jsonwebtoken';

interface UploadTicket {
  contentType: string;
  filename: string;
  uploadedBy?: string;
  exp: number;
}

const TICKET_TTL_SECONDS = 5 * 60;

export class LighthouseStorageProvider implements StorageProvider {
  constructor(
    private readonly publicBaseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly ipfsGateway: string,
  ) {
    if (!apiKey) {
      // Lighthouse SDK supports wallet-based payment via LIGHTHOUSE_WALLET_PRIVATE_KEY,
      // which we'll wire in once you fund a wallet. Until then surface a clear hint.
      logger.warn('LIGHTHOUSE_API_KEY not set — uploads will fail until configured');
    }
  }

  async presignedUpload(args: {
    contentType: string;
    filename: string;
    uploadedBy?: string;
  }): Promise<PresignedUpload> {
    // Issue a short-lived ticket the client uses as the upload destination.
    // The actual route handler validates this ticket before forwarding to Lighthouse.
    const ticket: UploadTicket = {
      contentType: args.contentType,
      filename: args.filename,
      uploadedBy: args.uploadedBy,
      exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
    };
    const ticketJwt = jwt.sign(ticket, config.JWT_SECRET, { algorithm: 'HS256' });

    return {
      // Until the upload happens we don't know the CID. We return the ticket
      // ID as a placeholder objectKey; the proxy route updates the attachments
      // row with the real CID after upload completes.
      objectKey: `pending-${ticketJwt.slice(-16)}`,
      uploadUrl: `${this.publicBaseUrl}/v2/_lighthouse-upload?ticket=${encodeURIComponent(ticketJwt)}`,
      // The real assetUrl will be built once we have the CID. For now we
      // return a placeholder that the iOS client will replace by reading the
      // upload response. Most XMTP clients store the assetUrl returned from
      // the PUT response, not from this endpoint.
      assetUrl: `${this.ipfsGateway}/PENDING`,
    };
  }

  async uploadBytes(args: {
    bytes: Buffer;
    filename: string;
    contentType: string;
  }): Promise<DirectUpload> {
    if (!this.apiKey) {
      throw new Error('LIGHTHOUSE_API_KEY not configured');
    }

    // Use Lighthouse's HTTP API directly to avoid SDK Node-version quirks.
    // POST multipart to https://node.lighthouse.storage/api/v0/add. The
    // IPFS CID becomes the storage provider's `objectKey` — content-
    // addressed, so the same bytes always produce the same key.
    const form = new FormData();
    form.append('file', new Blob([args.bytes], { type: args.contentType }), args.filename);

    const resp = await fetch('https://node.lighthouse.storage/api/v0/add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Lighthouse upload failed: ${resp.status} ${body}`);
    }
    const data = (await resp.json()) as { Hash: string; Name: string; Size: string };
    return {
      objectKey: data.Hash,
      assetUrl: `${this.ipfsGateway}/${data.Hash}`,
    };
  }

  async renew(keys: string[]): Promise<RenewResult[]> {
    // IPFS is content-addressed; "renewal" for our purposes just means
    // re-pinning. If you're using Lighthouse's perpetual storage you don't
    // need to renew. Return success for everything for now.
    return keys.map((key) => ({ key, success: true }));
  }
}
