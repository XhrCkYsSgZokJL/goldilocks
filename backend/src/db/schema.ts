import { pgTable, pgEnum, text, timestamp, integer, primaryKey, jsonb, boolean, bigserial, uuid, index } from 'drizzle-orm/pg-core';
import { encryptedText } from '../crypto/encrypted-text.js';
import { encryptedJson } from '../crypto/encrypted-json.js';

// Shape of one HMAC key stored in subscriptions.hmac_keys. The XMTP
// notification server verifies push envelopes against these keys.
export interface HmacKey {
  thirtyDayPeriodsSinceEpoch: number;
  key: string;
}

// One row per physical iOS device. The deviceId comes from the iOS app
// (DeviceInfo.deviceIdentifier). We treat it as opaque.
//
// `inbox_id` is the XMTP inbox identifier the device claimed during the
// first /v2/me call. `eth_address` is the Ethereum address the device used
// to sign the registration challenge. Together they're verified against
// the XMTP node's identity ledger (the eth_address must be associated with
// the inbox_id) so a caller can't claim someone else's inbox.
//
// Locked on first successful registration — subsequent calls from this
// deviceId must sign with the same eth key.
export const devices = pgTable('devices', {
  deviceId: text('device_id').primaryKey(),
  inboxId: text('inbox_id'),               // null until first /v2/me call
  ethAddress: text('eth_address'),         // null until first /v2/me call
  pushToken: encryptedText('push_token', 'devices.push_token'),
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

// Refresh tokens. One row per refresh token ever issued; `family_id`
// links a chain of rotations from a single login. RFC 6819 §5.2.2.3
// theft detection — if a `used_at` token is presented again, the whole
// family is revoked (src/auth/refresh-tokens.ts).
//
// The token itself is never stored — only the SHA-256 hash, so a DB
// dump can't be replayed without the original 256-bit secret.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id'),
    deviceId: text('device_id').notNull().references(() => devices.deviceId, { onDelete: 'cascade' }),
    inboxId: text('inbox_id'),
    tokenHash: text('token_hash').notNull().unique(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    familyIdx: index('refresh_tokens_family_idx').on(t.familyId),
    deviceIdx: index('refresh_tokens_device_idx').on(t.deviceId),
  }),
);

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
//
// hmac_keys is at-rest encrypted (F4): the column type is `text`, holding
// either v1-enveloped ciphertext over the JSON-stringified array or, for
// legacy rows during rollout, plaintext JSON. See encrypted-json.ts.
export const subscriptions = pgTable(
  'subscriptions',
  {
    clientId: text('client_id').notNull().references(() => installations.clientId, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    hmacKeys: encryptedJson<HmacKey[]>('hmac_keys', 'subscriptions.hmac_keys').notNull().default([]),
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

// =============================================================================
// Goldilocks customer model
// =============================================================================
//
// One Goldilocks customer ("client") = one XMTP inbox. We assign an
// auto-incrementing `client_number` so admins can refer to channels as
// "Advisory #55" / "Reports #55" without needing to memorise UUIDs or
// inbox IDs. The mapping is:
//
//   inbox_id  ←──   clients   ──→  client_number (the "#55")
//                       │
//                       └──→  client_channels  (one row per (client, role))
//
// Admins are rows in `admin_inboxes`, created by the `admins` CLI. The
// `/v2/me` endpoint returns `isAdmin: true` if the caller's inbox_id is
// bound to an enabled row — the iOS app uses this to switch between
// client UI and admin UI.

// One-time-use SIWE nonces. Issued by /v2/auth/challenge, consumed by
// /v2/me. We store the issuing device + the inbox_id the challenge was
// issued for so we can validate everything matches at consumption time.
export const authChallenges = pgTable('auth_challenges', {
  nonce: text('nonce').primaryKey(),
  deviceId: text('device_id').notNull().references(() => devices.deviceId, { onDelete: 'cascade' }),
  inboxId: text('inbox_id').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const clients = pgTable('clients', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Auto-incrementing big-int that becomes the human-readable label
  // ("Advisory #55") in the admin UI.
  clientNumber: bigserial('client_number', { mode: 'number' }).notNull().unique(),
  inboxId: text('inbox_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Prepaid-balance billing (see migration 012). stripeCustomerId is
  // created on the client's first checkout and reused thereafter.
  // billingBalanceCents is the prepaid balance; billingSeats is the
  // billable headcount that sets the monthly burn rate;
  // billingBalanceAsOf is when the balance was last settled. "Active
  // until" is derived: billingBalanceAsOf + (balance / rate).
  stripeCustomerId: encryptedText('stripe_customer_id', 'clients.stripe_customer_id'),
  billingBalanceCents: integer('billing_balance_cents').notNull().default(0),
  billingSeats: integer('billing_seats').notNull().default(0),
  billingBalanceAsOf: timestamp('billing_balance_as_of', { withTimezone: true }),
  // Admin-toggled Emerald membership (migration 015). When true,
  // overrides the auto-computed tier from seats + coverage — see
  // `computeTier` in src/billing/tier.ts.
  emeraldMembershipEnabled: boolean('emerald_membership_enabled').notNull().default(false),
  // Report delivery day: '1st' or '14th' of each month (migration 021).
  reportDay: text('report_day').notNull().default('1st'),
  // Client-controlled coverage toggle (migration 022). When false, the
  // monthly tick skips this client and reports are not delivered.
  coverageEnabled: boolean('coverage_enabled').notNull().default(true),
  // How many people currently have active coverage (report delivered,
  // live events running). The monthly tick charges $125 * this.
  coveredPeople: integer('covered_people').notNull().default(0),
  // When the monthly balance tick last ran for this client.
  lastBalanceTickAt: timestamp('last_balance_tick_at', { withTimezone: true }),
  // Unique referral code for shareable Gold code URL (migration 024).
  referralCode: text('referral_code').unique(),
});

// Referral tracking (migration 024). One row per referred client.
export const referrals = pgTable('referrals', {
  id: uuid('id').defaultRandom().primaryKey(),
  referrerClientId: uuid('referrer_client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  referredClientId: uuid('referred_client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }).unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Audit trail for Stripe Checkout Sessions — one row per top-up. Inserted
// 'pending' by POST /v2/billing/checkout, flipped to 'completed' by the
// Stripe webhook on checkout.session.completed. `amountCents` is added to
// the client's prepaid balance; `refundedCents` tracks how much of it has
// since been refunded (by POST /v2/billing/cancel).
export const billingCheckouts = pgTable(
  'billing_checkouts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
    stripeSessionId: encryptedText('stripe_session_id', 'billing_checkouts.stripe_session_id').notNull().unique(),
    // The Stripe PaymentIntent — refunds are issued against it.
    stripePaymentIntentId: encryptedText('stripe_payment_intent_id', 'billing_checkouts.stripe_payment_intent_id'),
    // 'card' | 'crypto'. Only 'card' is wired up today.
    paymentMethod: text('payment_method').notNull().default('card'),
    // How many months of cover this top-up bought, at the rate below.
    durationMonths: integer('duration_months'),
    seats: integer('seats').notNull().default(0),
    // Total the session charges, in cents, added to the prepaid balance.
    amountCents: integer('amount_cents').notNull(),
    // How much of `amountCents` has been refunded so far.
    refundedCents: integer('refunded_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    // 'pending' | 'completed' | 'expired'.
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({ clientIdx: index('billing_checkouts_client_idx').on(t.clientId) }),
);

// Admin registry managed via `./dev/admins`. Creates one row per admin
// with a human name and a uniquely-generated `upgrade_code`.
// The person installs the app, registers as a client, and types that
// code in the debug area to claim the slot — that fills in `inbox_id` +
// `claimed_at`. /v2/me returns `isAdmin: true` once an enabled row
// matches the caller's inbox_id.
export const adminInboxes = pgTable('admin_inboxes', {
  // Surrogate key, so a slot can exist before the admin claims an inbox.
  id: uuid('id').defaultRandom().primaryKey(),
  // Who this admin is (e.g. "morgan") — set by the CLI when the slot is
  // created. Shown in the CLI listing and surfaced to /v2/admins.
  name: text('name').notNull(),
  // The secret the person types in the iOS debug area to claim the slot.
  // Generated by the CLI. F4-encrypted at rest — every encrypt call
  // uses a fresh nonce, so this column cannot be used in equality
  // filters. Look the slot up via `upgradeCodeLookup` instead.
  //
  // The `.unique()` from the schema's earlier life was silently broken
  // under encryption (two writes of the same plaintext produce
  // different ciphertexts, both passing the UNIQUE check). Migration
  // 019 drops the constraint. Uniqueness now lives on
  // `upgrade_code_lookup`, which IS deterministic.
  upgradeCode: encryptedText('upgrade_code', 'admin_inboxes.upgrade_code').notNull(),
  // Deterministic keyed HMAC of the plaintext upgrade code. Used for
  // O(1) equality lookups against the encrypted column above. See
  // src/crypto/lookup-hash.ts for construction and threat model.
  // Nullable during the rollout — backfilled by
  // scripts/backfill-admin-upgrade-lookups.ts — then carried forward
  // as a hard requirement by application code.
  upgradeCodeLookup: text('upgrade_code_lookup').unique(),
  // Null until the slot is claimed. Unique once set.
  inboxId: text('inbox_id').unique(),
  // Hard revoke. A disabled row is treated as a non-admin everywhere
  // (loadAdminInboxIds, /v2/me, /v2/admins) — the agent removes the
  // inbox from the cross-admin groups + every Advisory on the next
  // reconcile. Toggled by the CLI. The row is kept so re-enabling
  // preserves the name + code.
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // When the slot was bound to an inbox (the upgrade landed).
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
});

export const channelRoleEnum = pgEnum('channel_role', ['advisory', 'reports']);
export const channelStatusEnum = pgEnum('channel_status', ['active', 'exploded']);
export const reportJobStatusEnum = pgEnum('report_job_status', ['pending', 'posted', 'failed', 'cancelled']);

// One row per (client, role). The xmtp_group_id changes when a client
// explodes and recreates a channel — recreates overwrite in place rather
// than appending a new row, so the slot identity ("client 55's Advisory")
// is stable across the channel's lifecycle.
export const clientChannels = pgTable(
  'client_channels',
  {
    clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
    role: channelRoleEnum('role').notNull(),
    // Null only if the channel is currently exploded and not yet recreated.
    xmtpGroupId: text('xmtp_group_id'),
    status: channelStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    explodedAt: timestamp('exploded_at', { withTimezone: true }),
    recreatedAt: timestamp('recreated_at', { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.clientId, t.role] }) }),
);

// =============================================================================
// Server-side XMTP agents (admins-agent, reports-agent)
// =============================================================================

// One row per long-lived server agent. The same identity comes back across
// process restarts so the XMTP groups they own keep working.
export const serverAgents = pgTable('server_agents', {
  // 'admins' or 'reports' — exactly one of each.
  kind: text('kind').primaryKey(),
  // Null until the agent's XMTP client registers for the first time;
  // recordInboxId() fills it in immediately after Client.create resolves.
  inboxId: text('inbox_id').unique(),
  ethAddress: text('eth_address').notNull(),
  privateKeyHex: encryptedText('private_key_hex', 'server_agents.private_key_hex').notNull(),
  xmtpDbPath: text('xmtp_db_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Server-owned XMTP groups (vs client-owned ones in client_channels).
// Today this is just the cross-admin "Admins" group. Modeled as a table so
// adding more system groups later doesn't need a migration.
export const serverGroups = pgTable('server_groups', {
  kind: text('kind').primaryKey(),
  xmtpGroupId: text('xmtp_group_id').notNull().unique(),
  managedBy: text('managed_by').notNull().references(() => serverAgents.kind),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Skeleton queue for the future Reports cron pipeline. The reports-agent
// will eventually scan pending+due rows on a tick and post them. No worker
// is wired up yet — only the table.
export const reportJobs = pgTable('report_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  status: reportJobStatusEnum('status').notNull().default('pending'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Covered persons — clear-text tracking of individuals on a client's
// plan. Used by the reports-watcher to know who needs a monthly report
// and by billing to deduct the initial activation fee. The encrypted
// people-list blob is the client's source of truth for PII; this table
// only stores the person_id (SeatMember UUID) and display name for
// operational purposes.
export const coveredPersons = pgTable('covered_persons', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  personId: uuid('person_id').notNull(),
  displayName: text('display_name').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
  initialReportSentAt: timestamp('initial_report_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Encrypted people list — see migration 013. The blob is AES-256-GCM
// ciphertext; the key is the Advisory group's key and never reaches this
// database, so a dump of this table is opaque. `version` drives
// optimistic concurrency between the client and admin writers.
export const clientPeopleList = pgTable('client_people_list', {
  clientId: uuid('client_id').primaryKey().references(() => clients.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  salt: text('salt').notNull(),
  nonce: text('nonce').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
