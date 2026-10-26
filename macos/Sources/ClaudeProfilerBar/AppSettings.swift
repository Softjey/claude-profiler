import Foundation
import ProfilerBarCore

enum SettingsKey {
    static let notifyFinished = "notifyFinished"
    static let notifyPermission = "notifyPermission"
    static let finishedThresholdSeconds = "finishedThresholdSeconds"
    static let autoRelease = "autoRelease"
    static let autoReleaseIdleSeconds = "autoReleaseIdleSeconds"
    static let autoReleaseMinimumRssMb = "autoReleaseMinimumRssMb"
    static let autoReleaseScope = "autoReleaseScope"
    static let notifyAutoRelease = "notifyAutoRelease"
    /// Not a setting the user sees: `ReleaseHistory`, as JSON.
    static let releaseHistory = "releaseHistory"
}

enum AppSettings {
    /// Call once at launch, before anything reads `UserDefaults`.
    static func registerDefaults() {
        let release = AutoReleaser.Policy.default
        UserDefaults.standard.register(defaults: [
            SettingsKey.notifyFinished: true,
            SettingsKey.notifyPermission: true,
            SettingsKey.finishedThresholdSeconds: 60.0,
            SettingsKey.autoRelease: false,
            SettingsKey.autoReleaseIdleSeconds: release.minimumIdleDuration,
            SettingsKey.autoReleaseMinimumRssMb: release.minimumRssMb,
            SettingsKey.autoReleaseScope: release.scope.rawValue,
            SettingsKey.notifyAutoRelease: true,
        ])
    }
}

extension AutoReleaser.Policy {
    /// The policy the Memory settings describe, or nil while it is off.
    init?(defaults: UserDefaults) {
        guard defaults.bool(forKey: SettingsKey.autoRelease) else { return nil }
        self.init(
            minimumIdleDuration: defaults.double(forKey: SettingsKey.autoReleaseIdleSeconds),
            minimumRssMb: defaults.integer(forKey: SettingsKey.autoReleaseMinimumRssMb),
            scope: AutoReleaser.Scope(rawValue: defaults.string(forKey: SettingsKey.autoReleaseScope) ?? "")
                ?? Self.default.scope
        )
    }
}
