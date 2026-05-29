// swift-tools-version: 6.2
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "ConvosCore",
    platforms: [
        .iOS(.v26),
        .macOS(.v26)
    ],
    products: [
        .library(
            name: "ConvosCore",
            targets: ["ConvosCore"]
        ),
        .library(
            name: "ConvosCoreiOS",
            targets: ["ConvosCoreiOS"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.5.0"),
        .package(
            url: "https://github.com/xmtp/libxmtp.git",
            revision: "ios-4.10.0"
        ),
        .package(url: "https://github.com/tesseract-one/CSecp256k1.swift.git", from: "0.2.0"),
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.31.1"),
        // Sentry temporarily removed — sentry-cocoa's binary XCFramework ships
        // with a swiftinterface stamped with Swift 5.9.2, which Xcode 26
        // (Swift 6.3.1 effective-5.10) refuses to consume. Every Sentry call
        // site in the security-event code is already guarded by
        // `#if canImport(Sentry)`, so removing the dep makes them no-op
        // cleanly without breaking any functional path. Re-add when Sentry
        // ships an XCFramework built with Swift 5.10 or newer.
        .package(path: "../ConvosLogging"),
        .package(path: "../ConvosInvites"),
        .package(path: "../ConvosAppData"),
    ],
    targets: [
        .target(
            name: "ConvosCore",
            dependencies: [
                .product(name: "XMTPiOS", package: "libxmtp"),
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
                .product(name: "CSecp256k1", package: "CSecp256k1.swift"),
                .product(name: "ConvosLogging", package: "ConvosLogging"),
                .product(name: "ConvosInvites", package: "ConvosInvites"),
                .product(name: "ConvosAppData", package: "ConvosAppData"),
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6),
                // Define DEBUG - will be active based on Xcode's SWIFT_ACTIVE_COMPILATION_CONDITIONS
                .define("DEBUG", .when(configuration: .debug)),
                // Disable optimization for debug builds to enable proper debugging
                .unsafeFlags(["-Onone"], .when(configuration: .debug)),
            ]
        ),
        .target(
            name: "ConvosCoreiOS",
            dependencies: [
                .target(name: "ConvosCore", condition: .when(platforms: [.iOS])),
            ],
            path: "Sources/ConvosCoreiOS",
            swiftSettings: [
                .swiftLanguageMode(.v6),
                .define("DEBUG", .when(configuration: .debug)),
                .unsafeFlags(["-Onone"], .when(configuration: .debug)),
            ]
        ),
        .testTarget(
            name: "ConvosCoreTests",
            dependencies: [
                "ConvosCore",
                "ConvosAppData",
                .target(name: "ConvosCoreiOS", condition: .when(platforms: [.iOS])),
            ]
        ),
    ]
)
