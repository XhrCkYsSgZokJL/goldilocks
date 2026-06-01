import SwiftUI

struct BrandConfig: Codable, Sendable {
    nonisolated(unsafe) static let shared: BrandConfig = {
        guard let url = Bundle.main.url(forResource: "brand", withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else {
            fatalError("brand.json missing from bundle")
        }
        do {
            return try JSONDecoder().decode(BrandConfig.self, from: data)
        } catch {
            fatalError("brand.json decode error: \(error)")
        }
    }()

    let brand: Brand
    let groups: Groups
    let groupIcons: [String: String]
    let groupImages: [String: String]
    let advisoryTierImages: [String: String]
    let pricing: Pricing
    let tiers: Tiers
    let assets: Assets
    let legal: Legal

    struct Brand: Codable, Sendable {
        let name: String
        let tagline: String
        let privacyIntro: String
        let serviceDescription: String
        let supportEmail: String
        let legalEntity: String
        let footerCredit: String
    }

    struct Groups: Codable, Sendable {
        let client: [String]
        let admin: [String]

        var all: [String] { client + admin }
    }

    struct Pricing: Codable, Sendable {
        let monthlyPricePerPersonCents: Int
        let currency: String
        let priceLabel: String

        var monthlyPricePerPerson: Int { monthlyPricePerPersonCents / 100 }
    }

    struct Tiers: Codable, Sendable {
        let thresholds: Thresholds
        let styles: [String: TierStyle]
        let descriptions: [String: String]

        struct Thresholds: Codable, Sendable {
            let silver: Int
            let gold: Int
        }

        struct TierStyle: Codable, Sendable {
            let colorHex: String
            let colorRGB: [Double]
            let icon: String
        }
    }

    struct Assets: Codable, Sendable {
        let logoImageName: String
    }

    struct Legal: Codable, Sendable {
        let privacyPolicyUrl: String
        let termsOfServiceUrl: String
    }

    func iconSymbolName(for groupName: String) -> String {
        groupIcons[groupName] ?? groupIcons["default"] ?? "bubble.left.and.bubble.right.fill"
    }
}

extension BrandConfig.Tiers.TierStyle {
    var color: Color {
        guard colorRGB.count == 3 else { return .gray }
        return Color(red: colorRGB[0], green: colorRGB[1], blue: colorRGB[2])
    }
}
