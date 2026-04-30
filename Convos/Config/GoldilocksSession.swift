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

    private(set) var identity: GoldilocksAuth.Identity?
    private(set) var adminInboxIds: [String] = []
    private(set) var isRegistering: Bool = false
    private(set) var lastError: String?

    var clientNumber: Int64? { identity?.clientNumber }
    var isAdmin: Bool { identity?.isAdmin ?? false }

    private init() {}

    /// Run the SIWE handshake exactly once per app launch, then fetch the
    /// admin inbox list. Subsequent calls are no-ops while a registration
    /// is in flight or once one has succeeded.
    ///
    /// In DEBUG builds, if the launch env var GOLDILOCKS_AUTO_ADMIN=1, we
    /// auto-promote ourselves to admin after registration so the spawn
    /// script's "admin sim" works without any manual button-tap.
    func registerIfNeeded(session: any SessionManagerProtocol) async {
        guard identity == nil, !isRegistering else { return }
        isRegistering = true
        defer { isRegistering = false }

        do {
            // For admin builds, claim the admin role inline so the
            // backend can insert admin_inboxes BEFORE clients in the
            // same call. That ordering ensures admin_changed NOTIFY
            // arrives at the agent before client_registered, and
            // reports-agent skips Reports creation entirely — no race,
            // no stranded MLS Reports group on the network. Legacy env
            // var `GOLDILOCKS_AUTO_ADMIN=1` is still respected so the
            // spawn-two-sims script keeps working.
            let envWantsAdmin = ProcessInfo.processInfo.environment["GOLDILOCKS_AUTO_ADMIN"] == "1"
            let claim = (GoldilocksConfig.role == .admin) || envWantsAdmin
            let result = try await session.registerWithGoldilocks(claimAdminRole: claim)
            self.identity = result
            self.lastError = nil
            Log.info("[Goldilocks] Registered as client #\(result.clientNumber), isAdmin=\(result.isAdmin)")
        } catch {
            self.lastError = error.localizedDescription
            Log.warning("[Goldilocks] Registration failed: \(error.localizedDescription)")
            return
        }

        // The inline claim above already promoted the inbox in dev,
        // but `autoPromoteIfRequested` stays as a fallback for any
        // path that didn't pass the flag (e.g. the "Become admin (DEV)"
        // settings toggle a user might tap after launch).
        await autoPromoteIfRequested(session: session)
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
                await reconcileLocalChannelsWithBackend(session: session)
            }
        } catch {
            Log.warning("[Goldilocks] Couldn't fetch agent inboxes: \(error.localizedDescription)")
        }
    }

    /// Reconcile local GRDB against `/v2/me/channels`:
    ///   1. Populate `GoldilocksOwnedChannels` so the staleness filter
    ///      can immediately drop Advisories/Reports we don't own.
    ///   2. For each *active* channel the backend reports, check whether
    ///      its `xmtpGroupId` exists in local DB. Fire `recover` only if
    ///      one is genuinely missing — never on count alone, because
    ///      `local` and `expected` race during launch as welcomes stream
    ///      in and the count check produces false positives that loop
    ///      the agent into wasteful re-welcome cycles.
    private func reconcileLocalChannelsWithBackend(session: any SessionManagerProtocol) async {
        do {
            // Grace period so requestDiscovery() above can land
            // newly-decryptable groups before we check presence.
            try await Task.sleep(nanoseconds: 2_000_000_000)
            let serverChannels = try await session.listGoldilocksChannels()
            // Admins by design don't have a personal Reports group —
            // they see report alerts in the cross-admin Audit Log feed.
            // The agent marks any Reports row exploded on admin
            // promotion, but there's a race: if iOS fetches
            // /v2/me/channels before the agent finishes processing
            // admin_changed, the row is still 'active' and would leak
            // into the owned-channels set. Belt-and-suspenders: iOS
            // already knows its role, so exclude role='reports'
            // unconditionally for admins.
            let active = serverChannels
                .filter { $0.status == "active" }
                .filter { !(isAdmin && $0.role == "reports") }
            // Per-role channel IDs (Advisory/Reports). Recover targets
            // these — admins-group is intentionally excluded because
            // re-welcoming on the cross-admin group can churn the
            // membership for every other admin.
            let perRoleIds = active.compactMap { $0.xmtpGroupId }
            var ownedIds = perRoleIds
            if isAdmin {
                if let adminsGroupId = try? await session.fetchGoldilocksAdminsGroupId(), !adminsGroupId.isEmpty {
                    ownedIds.append(adminsGroupId)
                    Log.info("[Goldilocks] Including Admins group in owned set: \(adminsGroupId)")
                }
                if let alertsGroupId = try? await session.fetchGoldilocksAlertsGroupId(), !alertsGroupId.isEmpty {
                    ownedIds.append(alertsGroupId)
                    Log.info("[Goldilocks] Including Alerts group in owned set: \(alertsGroupId)")
                }
                // Admins are added as members to every client's Advisory
                // (admins-agent maintains this invariant via reconcile).
                // Pull the full org-wide list from /v2/admin/channels and
                // merge active Advisory rows into the owned set so the
                // staleness filter doesn't hide them from the conversations
                // list. Reports groups are NOT included — admins aren't
                // members and shouldn't see them in the sidebar.
                if let adminChannels = try? await session.fetchAdminChannels() {
                    let advisoryIds = adminChannels
                        .filter { $0.role == "advisory" && $0.status == "active" }
                        .compactMap { $0.xmtpGroupId }
                    if !advisoryIds.isEmpty {
                        ownedIds.append(contentsOf: advisoryIds)
                        Log.info("[Goldilocks] Including \(advisoryIds.count) cross-client Advisory group(s) in owned set")
                    }
                }
            }
            GoldilocksOwnedChannels.set(ownedIds)

            let missing = try await session.missingGoldilocksConversationIds(perRoleIds)
            Log.info("[Goldilocks] channel reconcile: expected=\(perRoleIds.count) missing=\(missing.count) ownedIds=\(ownedIds.count)")
            guard !missing.isEmpty else { return }
            Log.info("[Goldilocks] Missing channels \(missing.map { String($0.prefix(8)) }) — requesting backend recover")
            try await session.recoverGoldilocksChannels()
            // The agent's addMembers commit propagates over the network.
            // Re-running discovery tends to land it faster than waiting.
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await session.messagingService().sessionStateManager.requestDiscovery()
        } catch {
            Log.warning("[Goldilocks] Channel reconcile/recover failed: \(error.localizedDescription)")
        }
    }

    /// DEV-ONLY. Promote this device's inbox to admin via the backend's
    /// dev endpoint, then refresh local identity so isAdmin flips.
    func promoteToAdminDev(session: any SessionManagerProtocol) async {
        do {
            try await session.promoteSelfToAdminDev()
            let refreshed = try await session.refreshGoldilocksIdentity()
            self.identity = refreshed
            Log.info("[Goldilocks] Promoted to admin. isAdmin=\(refreshed.isAdmin)")
            await refreshAdminInboxes(session: session)
        } catch {
            self.lastError = error.localizedDescription
            Log.error("[Goldilocks] Admin promotion failed: \(error.localizedDescription)")
        }
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

    /// Auto-promote when the build-time role is `.admin`. The admin
    /// keychain slot is treated as permanently admin: on first
    /// registration we promote it; on subsequent registrations the inbox
    /// is already in admin_inboxes so /v2/me returns isAdmin=true and we
    /// skip. Legacy env var GOLDILOCKS_AUTO_ADMIN=1 still works as a
    /// fallback.
    private func autoPromoteIfRequested(session: any SessionManagerProtocol) async {
        let envWantsAdmin = ProcessInfo.processInfo.environment["GOLDILOCKS_AUTO_ADMIN"] == "1"
        let roleWantsAdmin = GoldilocksConfig.role == .admin
        guard envWantsAdmin || roleWantsAdmin else { return }
        guard identity?.isAdmin == false else { return }   // already admin → skip
        Log.info("[Goldilocks] Configured role is admin — auto-promoting this inbox...")
        await promoteToAdminDev(session: session)
    }
}
