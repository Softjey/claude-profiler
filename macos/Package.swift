// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "ClaudeProfilerBar",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything testable without a UI: the wire format, the collector
        // process and the number formatting.
        .target(
            name: "ProfilerBarCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "ClaudeProfilerBar",
            dependencies: ["ProfilerBarCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ProfilerBarCoreTests",
            dependencies: ["ProfilerBarCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
