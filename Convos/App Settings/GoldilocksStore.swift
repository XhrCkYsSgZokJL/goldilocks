import ConvosCore
import Observation
import StoreKit

/// Product identifiers for Goldilocks coverage subscriptions. Each ID encodes
/// the duration so the backend can map verified receipts to the right balance
/// top-up amount. Product IDs must match App Store Connect configuration.
enum GoldilocksProductID {
    static let oneMonth: String = "com.goldilocks.coverage.1mo"
    static let threeMonths: String = "com.goldilocks.coverage.3mo"
    static let sixMonths: String = "com.goldilocks.coverage.6mo"

    static func forDuration(_ duration: GoldilocksPrepaidDuration) -> String {
        switch duration {
        case .oneMonth: return oneMonth
        case .threeMonths: return threeMonths
        case .sixMonths: return sixMonths
        }
    }

    static var all: [String] {
        [oneMonth, threeMonths, sixMonths]
    }
}

/// Manages StoreKit2 subscription products and purchases for Goldilocks
/// coverage. Handles product fetching, purchase initiation, and transaction
/// observation. The actual balance crediting happens server-side once the
/// backend verifies the App Store Server Notification or the JWS transaction.
@Observable
@MainActor
final class GoldilocksStore {
    static let shared: GoldilocksStore = GoldilocksStore()

    var products: [String: Product] = [:]
    var purchaseState: PurchaseState = .idle
    var lastError: String?

    enum PurchaseState: Equatable {
        case idle
        case purchasing
        case verifying
        case succeeded
        case failed
    }

    private let transactionListener: Task<Void, Never>

    private init() {
        transactionListener = Task.detached {
            for await result in Transaction.updates {
                if case .verified(let transaction) = result {
                    await transaction.finish()
                    Log.info("[GoldilocksStore] Transaction update: \(transaction.productID)")
                }
            }
        }
    }

    func loadProducts() async {
        do {
            let storeProducts: [Product] = try await Product.products(for: GoldilocksProductID.all)
            for product in storeProducts {
                products[product.id] = product
            }
        } catch {
            Log.warning("[GoldilocksStore] Failed to load products: \(error.localizedDescription)")
        }
    }

    /// Initiate a purchase for the given duration. Returns true on success,
    /// false on failure or cancellation.
    func purchase(
        duration: GoldilocksPrepaidDuration,
        seats: Int,
        session: any SessionManagerProtocol
    ) async -> Bool {
        let productId: String = GoldilocksProductID.forDuration(duration)
        guard let product = products[productId] else {
            lastError = "Product not available. Please try again later."
            purchaseState = .failed
            return false
        }

        purchaseState = .purchasing
        lastError = nil

        do {
            let result: Product.PurchaseResult = try await product.purchase()
            switch result {
            case .success(let verification):
                purchaseState = .verifying
                let transaction: Transaction = try checkVerified(verification)
                let verified: Bool = await verifyWithBackend(
                    transaction: transaction,
                    duration: duration,
                    seats: seats,
                    session: session
                )
                await transaction.finish()
                if verified {
                    purchaseState = .succeeded
                    return true
                } else {
                    purchaseState = .failed
                    lastError = "Purchase completed but verification failed. Contact support."
                    return false
                }
            case .userCancelled:
                purchaseState = .idle
                return false
            case .pending:
                purchaseState = .idle
                lastError = "Purchase is pending approval."
                return false
            @unknown default:
                purchaseState = .failed
                lastError = "Unexpected purchase result."
                return false
            }
        } catch {
            purchaseState = .failed
            lastError = error.localizedDescription
            return false
        }
    }

    func resetState() {
        purchaseState = .idle
        lastError = nil
    }

    private func checkVerified(_ result: VerificationResult<Transaction>) throws -> Transaction {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let transaction):
            return transaction
        }
    }

    /// Send the transaction's JWS to the backend for server-side verification
    /// and balance crediting.
    private func verifyWithBackend(
        transaction: Transaction,
        duration: GoldilocksPrepaidDuration,
        seats: Int,
        session: any SessionManagerProtocol
    ) async -> Bool {
        do {
            try await session.verifyApplePurchase(
                transactionId: String(transaction.id),
                productId: transaction.productID,
                durationMonths: duration.months,
                seats: seats
            )
            return true
        } catch {
            Log.warning("[GoldilocksStore] Backend verification failed: \(error.localizedDescription)")
            return false
        }
    }
}
