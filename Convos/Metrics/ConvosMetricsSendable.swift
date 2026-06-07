import ConvosMetrics

// The metrics enums in `convos-shared`'s `ConvosMetrics` module are plain
// payload-free cases but aren't declared `Sendable` upstream. Under the app
// target's complete-concurrency checking they get passed into detached
// `Task`s that call `CoreActions` (a `Sendable` protocol whose async methods
// run off the main actor), which trips "sending value risks data races".
// They carry no storage, so the conformance is sound; declared retroactively
// here to avoid forking the dependency.
extension ConvosMetrics.AgentBuilderEntryMode: @retroactive @unchecked Sendable {}
extension ConversationSource: @retroactive @unchecked Sendable {}
extension ShareTarget: @retroactive @unchecked Sendable {}
extension PaywallSource: @retroactive @unchecked Sendable {}
extension SubscriptionTier: @retroactive @unchecked Sendable {}
extension SubscriptionPeriod: @retroactive @unchecked Sendable {}
extension PurchaseFailureReason: @retroactive @unchecked Sendable {}
