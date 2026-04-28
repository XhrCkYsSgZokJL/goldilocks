import { pgTable, text, timestamp, integer, primaryKey, jsonb, boolean } from 'drizzle-orm/pg-core';

// One row per physical iOS device. The deviceId comes from the iOS app
// (DeviceInfo.deviceIdentifier). We treat it as opaque.
export const devices = pgTable('devices', {
  deviceId: text('device_id').primaryKey(),
  pushToken: text('push_token'),
  pushTokenType: text('push_token_type'), // "apns" | "fcm" | null
  apnsEnv: text('apns_env'),               // "sandbox" | "production" | null
  pushFailures: integer('push_failures').notNull().default(0),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Issued JWTs. We don't strictly need to store the token itself —
// jti + revoked flag is enough for revocation.
export const sessions = pgTable('sessions', {
  jti: text('jti').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.deviceId, { onDelete: 'cascade' }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').notNull().default(false),
});

// Each (deviceId, clientId) is one XMTP installation belonging to one
// physical device. A device can host multiple installations (e.g. one
// per user inbox).
export const installations = pgTable('installations', {
  clientId: text('client_id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.deviceId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Push subscriptions: which (clientId) wants to be pushed for which (topic),
// optionally with HMAC keys for envelope verification by the notification
// server. The XMTP notification server reads from this table.
export const subscriptions = pgTable(
  'subscriptions',
  {
    clientId: text('client_id').notNull().references(() => installations.clientId, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    hmacKeys: jsonb('hmac_keys').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.clientId, t.topic] }) }),
);

// Audit log of attachment uploads. We don't need to keep the file bytes —
// the storage provider handles that. We just remember the CID -> client
// mapping so we can attribute usage and (optionally) garbage-collect
// orphaned uploads later.
export const attachments = pgTable('attachments', {
  objectKey: text('object_key').primaryKey(), // CID for IPFS, S3 key for S3
  uploadedBy: text('uploaded_by'),             // deviceId, nullable for unauthenticated uploads
  contentType: text('content_type').notNull(),
  filename: text('filename'),
  assetUrl: text('asset_url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
