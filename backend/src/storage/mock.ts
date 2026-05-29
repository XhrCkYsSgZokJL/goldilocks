import { randomUUID } from 'node:crypto';
import type { DirectUpload, PresignedUpload, RenewResult, StorageProvider } from './provider.js';

// In-dev mock that returns a fake upload URL pointing at an internal
// endpoint and a fake asset URL. Useful when you don't want to spend
// gas / API quota during local testing.
//
// The fake "upload" endpoint is mounted at /v2/_mock-upload/:objectKey and
// just discards the body.
export class MockStorageProvider implements StorageProvider {
  constructor(private readonly publicBaseUrl: string) {}

  async presignedUpload(args: { contentType: string; filename: string }): Promise<PresignedUpload> {
    const objectKey = `mock-${randomUUID()}`;
    return {
      objectKey,
      uploadUrl: `${this.publicBaseUrl}/v2/_mock-upload/${objectKey}`,
      assetUrl: `${this.publicBaseUrl}/v2/_mock-asset/${objectKey}`,
    };
  }

  async uploadBytes(_args: {
    bytes: Buffer;
    filename: string;
    contentType: string;
  }): Promise<DirectUpload> {
    // Bytes are intentionally discarded — the mock asset URL points at a
    // no-op endpoint, matching the presigned-flow behaviour above.
    const objectKey = `mock-${randomUUID()}`;
    return {
      objectKey,
      assetUrl: `${this.publicBaseUrl}/v2/_mock-asset/${objectKey}`,
    };
  }

  async renew(keys: string[]): Promise<RenewResult[]> {
    return keys.map((key) => ({ key, success: true }));
  }
}
