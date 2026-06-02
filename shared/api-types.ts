// Canonical API type definitions for Goldilocks.
// Run `npm run codegen` to regenerate Swift Codable structs and Zod schemas.

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** @swift GoldilocksTokenRequest */
export interface TokenRequest {
  deviceId: string;
}

/** @swift GoldilocksRefreshRequest */
export interface RefreshRequest {
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// SIWE identity registration
// ---------------------------------------------------------------------------

/** @swift GoldilocksChallengeRequest */
export interface ChallengeRequest {
  inboxId: string;
  ethAddress: string;
}

/** @swift GoldilocksChallengeResponse */
export interface ChallengeResponse {
  siweMessage: string;
  nonce: string;
  expiresAt: string;
}

/** @swift GoldilocksMeRequest */
export interface MeRequest {
  inboxId: string;
  siweMessage: string;
  signature: string;
  claimAdminRole?: boolean;
}

/** @swift GoldilocksMeResponse */
export interface MeResponse {
  /** @swift Int64 */
  clientNumber: number;
  isAdmin: boolean;
  inboxId: string;
  /** @swift default(false) */
  emeraldMembershipEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Admin inboxes
// ---------------------------------------------------------------------------

/** @swift GoldilocksAdminInbox */
export interface AdminInbox {
  inboxId: string;
  name: string | null;
}

/** @swift GoldilocksAdminsResponse */
export interface AdminsResponse {
  inboxes: AdminInbox[];
}

/** @swift GoldilocksAdminUpgradeRequest */
export interface AdminUpgradeRequest {
  code: string;
}

// ---------------------------------------------------------------------------
// Server agents
// ---------------------------------------------------------------------------

/** @swift GoldilocksAgent */
export interface Agent {
  kind: string;
  inboxId: string;
}

/** @swift GoldilocksAgentsResponse */
export interface AgentsResponse {
  agents: Agent[];
  adminsGroupId: string | null;
  alertsGroupId: string | null;
}

// ---------------------------------------------------------------------------
// Channel lifecycle
// ---------------------------------------------------------------------------

export type ChannelRole = "advisory" | "reports";

/** @swift GoldilocksChannelRegisterRequest */
export interface ChannelRegisterRequest {
  role: ChannelRole;
  xmtpGroupId: string;
}

/** @swift GoldilocksChannelRecreateRequest */
export interface ChannelRecreateRequest {
  xmtpGroupId: string;
}

/** @swift GoldilocksChannelResponse */
export interface ChannelResponse {
  role: string;
  xmtpGroupId: string;
  status: string;
}

/** @swift GoldilocksChannel */
export interface Channel {
  role: string;
  xmtpGroupId: string | null;
  status: string;
  createdAt: string;
  explodedAt: string | null;
  recreatedAt: string | null;
}

/** @swift GoldilocksChannelsListResponse */
export interface ChannelsListResponse {
  /** @swift Int64 */
  clientNumber: number;
  channels: Channel[];
  expectedRoles?: string[];
}

/** @swift GoldilocksAdminChannel */
export interface AdminChannel {
  /** @swift Int64 */
  clientNumber: number;
  clientInboxId: string;
  role: string;
  xmtpGroupId: string | null;
  status: string;
  createdAt: string;
  explodedAt: string | null;
  recreatedAt: string | null;
  monthlyRateCents: number;
  coverageActive: boolean;
  emeraldMembershipEnabled: boolean;
}

/** @swift GoldilocksAdminChannelsResponse */
export interface AdminChannelsResponse {
  channels: AdminChannel[];
}

// ---------------------------------------------------------------------------
// Emerald membership toggle
// ---------------------------------------------------------------------------

/** @swift GoldilocksEmeraldToggleRequest */
export interface EmeraldToggleRequest {
  enabled: boolean;
}

/** @swift GoldilocksEmeraldToggleResponse */
export interface EmeraldToggleResponse {
  /** @swift Int64 */
  clientNumber: number;
  emeraldMembershipEnabled: boolean;
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Billing (Stripe prepaid balance)
// ---------------------------------------------------------------------------

/** @swift GoldilocksCheckoutRequest */
export interface CheckoutRequest {
  paymentMethod: "card" | "crypto";
  amountCents: number;
}

/** @swift GoldilocksCheckoutResponse */
export interface CheckoutResponse {
  checkoutUrl: string;
  sessionId: string;
}

/** @swift GoldilocksSeatsRequest */
export interface SeatsRequest {
  seats: number;
}

/** @swift GoldilocksBillingStatusResponse */
export interface BillingStatusResponse {
  activeUntil: string | null;
  coverageActive: boolean;
  /** @swift default(true) */
  coverageEnabled: boolean;
  balanceCents: number;
  monthlyRateCents: number;
  seats: number;
  coveredPeople: number;
  reportDay: string;
}

/** @swift GoldilocksReportDayRequest */
export interface ReportDayRequest {
  reportDay: string;
}

/** @swift GoldilocksCoverageToggleRequest */
export interface CoverageToggleRequest {
  enabled: boolean;
}

/** @swift GoldilocksPersonToggleRequest */
export interface PersonToggleRequest {
  personId: string;
  displayName: string;
  enabled: boolean;
}

/** @swift GoldilocksPersonToggleResponse */
export interface PersonToggleResponse extends BillingStatusResponse {
  activated: boolean;
  deductedCents: number;
}

/** @swift GoldilocksCancelResponse */
export interface CancelResponse {
  refundedCents: number;
}

// ---------------------------------------------------------------------------
// People list (encrypted blobs)
// ---------------------------------------------------------------------------

/** @swift GoldilocksPeopleListResponse */
export interface PeopleListResponse {
  version: number;
  ciphertext: string | null;
  salt: string | null;
  nonce: string | null;
}

/** @swift GoldilocksPeopleListSaveRequest */
export interface PeopleListSaveRequest {
  ciphertext: string;
  salt: string;
  nonce: string;
  baseVersion: number;
  auditHint?: AuditHint;
}

/** @swift nested:GoldilocksPeopleListSaveRequest.AuditHint */
export interface AuditHint {
  action: string;
}

/** @swift GoldilocksPeopleListSaveResponse */
export interface PeopleListSaveResponse {
  version: number;
}

// ---------------------------------------------------------------------------
// Device registration
// ---------------------------------------------------------------------------

/** @swift GoldilocksDeviceRegisterRequest */
export interface DeviceRegisterRequest {
  deviceId: string;
  pushToken?: string | null;
  pushTokenType?: "apns" | "fcm" | null;
  apnsEnv?: "sandbox" | "production" | null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** @swift GoldilocksHmacKey */
export interface HmacKey {
  thirtyDayPeriodsSinceEpoch: number;
  key: string;
}

/** @swift GoldilocksTopicSubscription */
export interface TopicSubscription {
  topic: string;
  hmacKeys: HmacKey[];
}

/** @swift GoldilocksSubscribeRequest */
export interface SubscribeRequest {
  deviceId: string;
  clientId: string;
  topics: TopicSubscription[];
}

/** @swift GoldilocksUnsubscribeRequest */
export interface UnsubscribeRequest {
  clientId: string;
  topics: string[];
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** @swift GoldilocksPresignedQuery */
export interface PresignedQuery {
  contentType: string;
  filename: string;
}

/** @swift GoldilocksRenewBatchRequest */
export interface RenewBatchRequest {
  assetKeys: string[];
}
