import ConvosCore
import Observation
import StoreKit

/// Product identifiers for Goldilocks deposit tiers. Each ID maps to a
/// fixed deposit amount. Product IDs must match App Store Connect config.
enum GoldilocksProductID {
    static let deposit100: String = "com.goldilocks.deposit.100"
    static let deposit200: String = "com.goldilocks.deposit.200"
    static let deposit300: String = "com.goldilocks.deposit.300"

    static func forAmountCents(_ cents: Int) -> String {
        switch cents {
        case 20_000: return deposit200
        case 30_000: return deposit300
        default: return deposit100
        }
    }

    static var all: [String] {
        [deposit100, deposit200, deposit300]
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

    /// Initiate a purchase for the given deposit amount. Returns true on
    /// success, false on failure or cancellation.
    func purchase(
        amountCents: Int,
        session: any SessionManagerProtocol
    ) async -> Bool {
        let productId: String = GoldilocksProductID.forAmountCents(amountCents)
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
                    amountCents: amountCents,
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
        amountCents: Int,
        session: any SessionManagerProtocol
    ) async -> Bool {
        do {
            try await session.verifyApplePurchase(
                transactionId: String(transaction.id),
                productId: transaction.productID,
                amountCents: amountCents
            )
            return true
        } catch {
            Log.warning("[GoldilocksStore] Backend verification failed: \(error.localizedDescription)")
            return false
        }
    }
}
