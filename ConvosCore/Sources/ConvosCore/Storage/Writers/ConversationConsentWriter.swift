import Foundation
import GRDB

public protocol ConversationConsentWriterProtocol: Sendable {
    func join(conversation: Conversation) async throws
    func delete(conversation: Conversation) async throws
    func deleteAll() async throws
}

/// Marked @unchecked Sendable because GRDB's DatabaseWriter provides its own
/// concurrency safety via write{}/read{} closures - all database access is
/// externally synchronized by GRDB's serialized database queue.
class ConversationConsentWriter: ConversationConsentWriterProtocol, @unchecked Sendable {
    enum ConversationConsentWriterError: Error {
        case deleteAllFailedWithErrors([Error])
    }

    private let sessionStateManager: any SessionStateManagerProtocol
    private let databaseWriter: any DatabaseWriter

    init(sessionStateManager: any SessionStateManagerProtocol,
         databaseWriter: any DatabaseWriter) {
        self.sessionStateManager = sessionStateManager
        self.databaseWriter = databaseWriter
    }

    func join(conversation: Conversation) async throws {
        let client = try await sessionStateManager.waitForInboxReadyResult().client
        try await client.update(consent: .allowed, for: conversation.id)
        try await databaseWriter.write { db in
            guard let localConversation = try DBConversation
                .filter(DBConversation.Columns.id == conversation.id)
                .fetchOne(db) else {
                return
            }
            try localConversation.with(consent: .allowed).save(db)
            Log.info("Updated conversation consent state to allowed")
        }
    }

    func delete(conversation: Conversation) async throws {
        let client = try await sessionStateManager.waitForInboxReadyResult().client

        // Goldilocks-managed system channels (Advisory, Reports) are owned
        // by trusted server agents. The agent's periodic reconcile would
        // bring them right back, so a local consent.denied write would
        // just cause a brief flicker before the row reappeared. Skip the
        // write entirely — the explode path is the only way to reset
        // these channels, and the agent will reprovision a fresh one.
        if try await isGoldilocksManaged(conversationId: conversation.id) {
            Log.info("Skipping consent.denied for Goldilocks-managed conversation \(conversation.id)")
            return
        }

        try await client.update(consent: .denied, for: conversation.id)
        try await databaseWriter.write { db in
            guard let localConversation = try DBConversation
                .filter(DBConversation.Columns.id == conversation.id)
                .fetchOne(db) else {
                return
            }
            try localConversation.with(consent: .denied).save(db)
            Log.info("Updated conversation consent state to denied")
        }
    }

    func deleteAll() async throws {
        let client = try await sessionStateManager.waitForInboxReadyResult().client
        let conversationsToDeny = try await databaseWriter.read { db in
            try DBConversation
                .filter(DBConversation.Columns.consent == Consent.unknown)
                .fetchAll(db)
        }

        var errors: [Error] = []
        for dbConversation in conversationsToDeny {
            // Defense in depth: even though Goldilocks channels auto-allow
            // (so they'd never appear in the .unknown filter above), don't
            // deny one if it slipped through.
            if GoldilocksAgentTrust.contains(inboxId: dbConversation.creatorId) {
                Log.info("Skipping consent.denied for Goldilocks-managed conversation \(dbConversation.id)")
                continue
            }

            do {
                try await client.update(consent: .denied, for: dbConversation.id)
                try await databaseWriter.write { db in
                    try dbConversation.with(consent: .denied).save(db)
                    Log.info("Updated conversation \(dbConversation.id) consent state to denied")
                }
            } catch {
                errors.append(error)
            }
        }

        if !errors.isEmpty {
            throw ConversationConsentWriterError.deleteAllFailedWithErrors(errors)
        }
    }

    private func isGoldilocksManaged(conversationId: String) async throws -> Bool {
        let creatorId = try await databaseWriter.read { db in
            try DBConversation
                .filter(DBConversation.Columns.id == conversationId)
                .fetchOne(db)?
                .creatorId
        }
        guard let creatorId else { return false }
        return GoldilocksAgentTrust.contains(inboxId: creatorId)
    }
}
