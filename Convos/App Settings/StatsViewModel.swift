import ConvosCore
import Foundation
import SwiftUI

@MainActor
@Observable
final class StatsViewModel {
    enum LoadState {
        case loading
        case loaded(ConvosAPI.GoldilocksAdminStatsResponse)
        case failed(String)
    }

    private(set) var state: LoadState = .loading

    private let session: any SessionManagerProtocol

    init(session: any SessionManagerProtocol) {
        self.session = session
    }

    func load() async {
        state = .loading
        do {
            let stats: ConvosAPI.GoldilocksAdminStatsResponse = try await session.fetchAdminStats()
            state = .loaded(stats)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
