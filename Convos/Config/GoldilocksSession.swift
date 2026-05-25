import ConvosCore
import Foundation
import Observation

/// App-wide singleton for the Goldilocks identity assigned to this device.
///
/// After XMTP authorization completes (via `SessionManagerProtocol`), we
/// kick off a SIWE handshake with the Goldilocks backend. On success we
/// store the resulting `clientNumber` (the "#55" admins see) and `isAdmin`
/// flag here so the rest of the UI can read them synchronously.
///
/// We also pull the dynamic list of admin inbox IDs (`/v2/admins`) so a
/// client app can use them as the recipients for its Advisory/Reports
/// channels. This replaces the previous hardcoded approach where Morgan
/// and Tillie's inbox IDs were baked into the iOS source — now whichever
/// inbox is on the backend's admin allowlist becomes the canonical
/// recipient.
///
/// Registration is idempotent. Failures are logged and retried on the
/// next launch; nothing crashes if the backend is unreachable.
@MainActor
@Observable
final class GoldilocksSession {
    static let shared: GoldilocksSession = GoldilocksSession()

    /// Backend identity. Setting it keeps `GoldilocksConfig.role` in sync
    /// so non-observing call sites (Conversation extensions, groupNames)
    /// see the right role after registration or a mid-session upgrade.
    private(set) var identity: GoldilocksAuth.Identity? {
        didSet {
            GoldilocksConfig.role = (identity?.isAdmin ?? false) ? .admin : .client
            GoldilocksConfig.ownClientNumber = identity?.clientNumber
        }
    }
    private(set) var adminInboxIds: [String] = []
    private(set) var isRegistering: Bool = false
    private(set) var lastError: String?

    /// Whether this client has an invoice awaiting payment. Placeholder:
    /// invoices are not built yet, so this stays false until a real data
    /// source (a backend field) sets it. Drives the "Pending" chip on the
    /// conversations list.
    var hasPendingInvoice: Bool = false

    /// Latched true once every expected Goldilocks channel (Advisory +
    /// Reports) has been confirmed present in the local database.
    /// `ensureGoldilocksChannelsPresent` no-ops once this is set.
    @ObservationIgnored
    private var channelsConfirmed: Bool = false
    /// In-flight guard so concurrent callers of
    /// `ensureGoldilocksChannelsPresent` coalesce into a single run.
    @ObservationIgnored
    private var isEnsuringChannels: Bool = false

    var clientNumber: Int64? { identity?.clientNumber }
    var isAdmin: Bool { identity?.isAdmin ?? false }

    /// Current subscription plan, or nil if the client has no plan yet.
    var subscriptionTier: GoldilocksSubscriptionTier? { identity?.subscriptionTier }

    /// Effective role, derived from `isAdmin`. Observable: SwiftUI views
    /// reading this re-render when `identity` changes (e.g. after an
    /// admin upgrade).
    var role: GoldilocksRole { isAdmin ? .admin : .client }

    private init() {}

    /// Run the SIWE handshake exactly once per app launch, then fetch the
    /// admin inbox list. Subsequent calls are no-ops while a registration
    /// is in flight or once one has succeeded.
    ///
    /// Every install registers as a plain client. A user becomes an admin
    /// only by entering the upgrade code in the debug area's "Upgrade"
    /// row — see `upgradeToAdmin(session:code:)`. If the inbox is already
    /// on the admin allowlist (a prior upgrade), `/v2/me` returns
    /// `isAdmin=true` and the role reflects it immediately.
    func registerIfNeeded(session: any SessionManagerProtocol) async {
        guard identity == nil, !isRegistering else { return }
        isRegistering = true
        defer { isRegistering = false }

        do {
            let result = try await session.registerWithGoldilocks(claimAdminRole: false)
            self.identity = result
            self.lastError = nil
            Log.info("[Goldilocks] Registered as client #\(result.clientNumber), isAdmin=\(result.isAdmin)")
        } catch {
            self.lastError = error.localizedDescription
            Log.warning("[Goldilocks] Registration failed: \(error.localizedDescription)")
            return
        }

        await refreshAdminInboxes(session: session)
        await refreshAgentInboxes(session: session)
    }

    /// Pull the inbox IDs of the server agents (admins-agent, reports-agent)
    /// and register them with `GoldilocksAgentTrust` so StreamProcessor
    /// auto-allows agent-created group welcomes past the consent gate.
    ///
    /// Also kicks a `requestDiscovery()` afterward to re-run conversation
    /// discovery: on relaunches, iOS's initial sync runs *before* `/v2/agents`
    /// returns, so the consent gate had nothing to compare against and
    /// dropped the agent's groups on the floor. Re-running discovery once
    /// the trust set is populated lets those groups land in GRDB.
    func refreshAgentInboxes(session: any SessionManagerProtocol) async {
        do {
            let inboxes = try await session.fetchGoldilocksAgentInboxIds()
            GoldilocksAgentTrust.setTrustedInboxIds(inboxes)
            Log.info("[Goldilocks] Loaded \(inboxes.count) trusted agent inbox(es)")

            // Trigger a re-discovery so any groups that were dropped during
            // initial sync (because the trust set was empty then) get
            // re-evaluated and stored.
            if !inboxes.isEmpty {
                await session.messagingService().sessionStateManager.requestDiscovery()
                Log.info("[Goldilocks] Re-ran conversation discovery after agent trust loaded")
            }
        } catch {
            Log.warning("[Goldilocks] Couldn't fetch agent inboxes: \(error.localizedDescription)")
        }
    }

    /// Drive this client's Goldilocks channels (Advisory + Reports) all the
    /// way into the local database, retrying until they are actually there.
    ///
    /// A channel welcome can be *permanently* undecryptable on the client:
    /// XMTP rotates the installation on launch (the "Error building client,
    /// trying create…" path), and a welcome sealed to a previous
    /// installation or a stale key package fails HPKE decryption — libxmtp
    /// then marks it non-retryable and drops it for good. Once that
    /// happens, no amount of relaunching helps, because the welcome is
    /// gone and the backend's `addMembers`-style recovery no-ops for an
    /// inbox that is already a group member. The only cure is a brand-new
    /// group from the backend whose welcome is sealed to this install's
    /// current key packages.
    ///
    /// This routine therefore loops:
    ///   1. Publishes the backend's channel set to `GoldilocksOwnedChannels`
    ///      (which drives the conversation-list staleness filter).
    ///   2. Re-runs discovery to land any welcome already waiting.
    ///   3. If a channel is still missing, asks the backend to recreate it
    ///      (`recover` → the agent rebuilds the group with a fresh welcome).
    ///   4. Repeats until every expected channel is in the database.
    ///
    /// It latches `channelsConfirmed` on success and then no-ops, and an
    /// in-flight guard coalesces concurrent callers. Re-armed on every app
    /// foreground (see `ConversationsViewModel`), so a transient backend or
    /// network outage can never leave the app permanently stuck on the
    /// "Setting up your channels…" state.
    func ensureGoldilocksChannelsPresent(session: any SessionManagerProtocol) async {
        guard identity != nil else {
            Log.info("[Goldilocks] ensureChannelsPresent: not registered yet — skipping")
            return
        }
        guard !channelsConfirmed else { return }
        guard !isEnsuringChannels else {
            Log.info("[Goldilocks] ensureChannelsPresent: a run is already in flight — skipping")
            return
        }
        isEnsuringChannels = true
        defer { isEnsuringChannels = false }

        // Discovery needs the agent trust set. Prime it if a previous
        // launch populated it but this run hasn't yet.
        if GoldilocksAgentTrust.snapshot().isEmpty {
            Log.info("[Goldilocks] ensureChannelsPresent: agent trust set empty — priming it first")
            await refreshAgentInboxes(session: session)
        }

        let pollInterval: UInt64 = 5_000_000_000
        let recoverInterval: TimeInterval = 30
        let maxRecovers: Int = 4
        let deadline: Date = Date().addingTimeInterval(150)
        var lastRecoverAt: Date?
        var recoverCount: Int = 0
        var attempt: Int = 0

        Log.info("[Goldilocks] ensureChannelsPresent: starting for client #\(clientNumber ?? -1)")

        while Date() < deadline {
            attempt += 1
            do {
                let owned = try await refreshOwnedChannels(session: session)
                let perRoleIds = owned.perRoleIds
                var missing = try await session.missingGoldilocksConversationIds(perRoleIds)
                let channelSummary = "\(perRoleIds.count) channel(s), \(missing.count) missing in local DB"
                Log.info("[Goldilocks] ensureChannelsPresent attempt \(attempt): backend reports \(channelSummary), allRolesProvisioned=\(owned.allRolesProvisioned)")

                // Only latch setup as complete once every expected role has
                // been provisioned by the backend *and* is present locally —
                // never on a partial set the agents are still filling in
                // (the registration-time race).
                if owned.allRolesProvisioned, !perRoleIds.isEmpty, missing.isEmpty {
                    channelsConfirmed = true
                    Log.info("[Goldilocks] ensureChannelsPresent: all \(perRoleIds.count) expected channel(s) present — setup complete")
                    return
                }

                // Land anything already waiting in the welcome queue.
                await session.messagingService().sessionStateManager.requestDiscovery()
                missing = try await session.missingGoldilocksConversationIds(perRoleIds)
                if owned.allRolesProvisioned, !perRoleIds.isEmpty, missing.isEmpty {
                    channelsConfirmed = true
                    Log.info("[Goldilocks] ensureChannelsPresent: all \(perRoleIds.count) expected channel(s) present after discovery — setup complete")
                    return
                }

                // Still missing. Ask the backend to recreate the channel
                // with a welcome sealed to this install's current key
                // packages. Bounded: after `maxRecovers` requests the
                // backend has been told enough — asking more would only
                // churn dead groups. The agent caps recreates on its side
                // too and logs the underlying cause when it gives up.
                let now: Date = Date()
                let intervalElapsed: Bool
                if let last = lastRecoverAt {
                    intervalElapsed = now.timeIntervalSince(last) >= recoverInterval
                } else {
                    intervalElapsed = true
                }
                if recoverCount >= maxRecovers {
                    let status: String = "\(missing.count) channel(s) still missing after \(recoverCount) recover request(s)"
                    let advisory: String = "see the backend agent log for the root cause (likely a stale-installation pile-up on this inbox)"
                    Log.warning("[Goldilocks] ensureChannelsPresent: \(status) — \(advisory). Not requesting more this pass.")
                } else if intervalElapsed {
                    lastRecoverAt = now
                    recoverCount += 1
                    Log.info("[Goldilocks] ensureChannelsPresent: \(missing.count) channel(s) missing — requesting backend recreate (\(recoverCount)/\(maxRecovers))")
                    try await session.recoverGoldilocksChannels()
                }
            } catch {
                Log.warning("[Goldilocks] ensureChannelsPresent attempt \(attempt) failed: \(error.localizedDescription)")
            }
            try? await Task.sleep(nanoseconds: pollInterval)
        }
        Log.warning("[Goldilocks] ensureChannelsPresent: gave up this pass (confirmed=\(channelsConfirmed), recoverRequests=\(recoverCount)) — will retry on next app foreground")
    }

    /// Fetch the backend's channel set, publish it to `GoldilocksOwnedChannels`
    /// (which drives the conversation-list staleness filter), and return the
    /// per-role channel IDs plus whether every expected role (Advisory +
    /// Reports) has actually been provisioned on the backend yet.
    private func refreshOwnedChannels(
        session: any SessionManagerProtocol
    ) async throws -> (perRoleIds: [String], allRolesProvisioned: Bool) {
        let response = try await session.listGoldilocksChannels()
        let active = response.channels.filter { $0.status == "active" }
        let perRoleIds = active.compactMap { $0.xmtpGroupId }
        var ownedIds = perRoleIds
        if isAdmin {
            if let adminsGroupId = try? await session.fetchGoldilocksAdminsGroupId(), !adminsGroupId.isEmpty {
                ownedIds.append(adminsGroupId)
            }
            if let alertsGroupId = try? await session.fetchGoldilocksAlertsGroupId(), !alertsGroupId.isEmpty {
                ownedIds.append(alertsGroupId)
            }
            // Admins are members of every client's Advisory; merge those in
            // so the staleness filter does not hide them from the list.
            if let adminChannels = try? await session.fetchAdminChannels() {
                let advisoryIds = adminChannels
                    .filter { $0.role == "advisory" && $0.status == "active" }
                    .compactMap { $0.xmtpGroupId }
                ownedIds.append(contentsOf: advisoryIds)
            }
        }
        GoldilocksOwnedChannels.set(ownedIds)
        // The backend provisions channels asynchronously; only treat setup
        // as complete once every expected role has a group id. An older
        // backend that omits `expectedRoles` yields an empty set, which is
        // vacuously a subset — falling back to the prior behaviour.
        let expectedRoles: Set<String> = Set(response.expectedRoles ?? [])
        let provisionedRoles: Set<String> = Set(active.filter { $0.xmtpGroupId != nil }.map { $0.role })
        let allRolesProvisioned: Bool = expectedRoles.isSubset(of: provisionedRoles)
        return (perRoleIds: perRoleIds, allRolesProvisioned: allRolesProvisioned)
    }

    /// Promote this device's inbox to admin by submitting the secret
    /// upgrade code to `POST /v2/admin/upgrade`. On success the backend
    /// adds the inbox to `admin_inboxes` (firing `admin_changed`), and
    /// we re-fetch `/v2/me` so `identity.isAdmin` — and therefore
    /// `role` and `GoldilocksConfig.role` — flip to admin.
    ///
    /// Returns `true` iff the upgrade succeeded. A relaunch is still
    /// recommended so every role-dependent view picks up the change.
    func upgradeToAdmin(session: any SessionManagerProtocol, code: String) async -> Bool {
        do {
            try await session.upgradeGoldilocksAdmin(code: code)
            let refreshed = try await session.refreshGoldilocksIdentity()
            self.identity = refreshed
            await refreshAdminInboxes(session: session)
            Log.info("[Goldilocks] Upgrade complete. isAdmin=\(refreshed.isAdmin)")
            return refreshed.isAdmin
        } catch {
            self.lastError = error.localizedDescription
            Log.error("[Goldilocks] Admin upgrade failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Self-downgrade: drop this device's admin role via
    /// `POST /v2/admin/downgrade`. The backend flips the admin_inboxes
    /// row to disabled (firing `admin_changed`), the agent removes the
    /// inbox from the cross-admin groups + every Advisory, and we
    /// re-fetch `/v2/me` so `isAdmin`/`role` flip back to client.
    ///
    /// Returns `true` iff the downgrade succeeded. A relaunch is
    /// recommended so every role-dependent view picks up the change.
    func downgradeFromAdmin(session: any SessionManagerProtocol) async -> Bool {
        do {
            try await session.downgradeGoldilocksAdmin()
            let refreshed = try await session.refreshGoldilocksIdentity()
            self.identity = refreshed
            await refreshAdminInboxes(session: session)
            Log.info("[Goldilocks] Downgrade complete. isAdmin=\(refreshed.isAdmin)")
            return !refreshed.isAdmin
        } catch {
            self.lastError = error.localizedDescription
            Log.error("[Goldilocks] Admin downgrade failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Set this device's subscription plan on the Goldilocks backend, then
    /// refresh the cached identity so `subscriptionTier` reflects it. Backs
    /// the Subscription screen's Create/Update button, which simulates a
    /// billing success while Stripe is not yet wired up. Re-throws on
    /// failure so the caller can surface it.
    func setSubscriptionTier(_ tier: GoldilocksSubscriptionTier, session: any SessionManagerProtocol) async throws {
        try await session.setGoldilocksSubscriptionTier(tier)
        let refreshed = try await session.refreshGoldilocksIdentity()
        self.identity = refreshed
        Log.info("[Goldilocks] Subscription tier set to \(tier.rawValue)")
    }

    /// Re-fetch /v2/admins. Called after registration and after any admin
    /// state change.
    func refreshAdminInboxes(session: any SessionManagerProtocol) async {
        do {
            let inboxes = try await session.fetchGoldilocksAdminInboxIds()
            self.adminInboxIds = inboxes
            Log.info("[Goldilocks] Loaded \(inboxes.count) admin inbox(es)")
        } catch {
            Log.warning("[Goldilocks] Couldn't fetch admin inboxes: \(error.localizedDescription)")
        }
    }
}
