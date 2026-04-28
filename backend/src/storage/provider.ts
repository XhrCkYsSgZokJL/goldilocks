// Abstract over different blob/object stores.
// The iOS client expects a presigned-style flow: server returns an upload URL
// the client PUTs to, plus the final asset URL the recipient will GET from.
//
// For S3 this maps directly to a presigned PUT URL. For IPFS/Lighthouse we
// proxy uploads through the backend (since IPFS doesn't have a native presigned
// concept), but the iOS client doesn't need to know — it just sees an upload
// URL and an asset URL.

export interface PresignedUpload {
  /** Server-issued opaque key. For IPFS this is the CID once uploaded. */
  objectKey: string;
  /** URL the iOS client PUTs the file to. */
  uploadUrl: string;
  /** URL the recipient GETs the file from. Must be a full URL. */
  assetUrl: string;
}

export interface RenewResult {
  key: string;
  success: boolean;
  error?: string;
}

export interface StorageProvider {
  /**
   * Issue a presigned upload destination.
   * @param contentType MIME type the client will set on its PUT.
   * @param filename original filename, used for content-disposition.
   * @param uploadedBy deviceId of the uploader, for audit.
   */
  presignedUpload(args: {
    contentType: string;
    filename: string;
    uploadedBy?: string;
  }): Promise<PresignedUpload>;

  /**
   * Extend the lifetime of stored objects (e.g. re-pin to IPFS,
   * or copy-to-self in S3). Best-effort: returns per-key result.
   */
  renew(keys: string[]): Promise<RenewResult[]>;
}
