import Foundation
import ProfilerBarCore
import UserNotifications

enum SettingsKey {
    static let notifyFinished = "notifyFinished"
    static let notifyPermission = "notifyPermission"
    static let finishedThresholdSeconds = "finishedThresholdSeconds"
}

/// Turns state transitions between two snapshots into user notifications:
/// a long busy stretch that just ended ("Claude finished"), and a session
/// that started waiting on a permission prompt.
@MainActor
final class Notifier {
    private var busySince: [String: Date] = [:]
    private var authorized = false

    /// Notifications need a real bundle; `swift run` has none and would crash.
    private var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }

    init() {
        UserDefaults.standard.register(defaults: [
            SettingsKey.notifyFinished: true,
            SettingsKey.notifyPermission: true,
            SettingsKey.finishedThresholdSeconds: 60.0,
        ])
    }

    func compare(previous: LiveSnapshot?, next: LiveSnapshot) {
        let before = Dictionary(uniqueKeysWithValues: (previous?.sessions ?? []).map { ($0.id, $0) })
        let defaults = UserDefaults.standard
        let now = Date()

        for session in next.sessions {
            let old = before[session.id]
            switch session.state {
            case .busy, .waiting:
                if busySince[session.id] == nil { busySince[session.id] = now }
            default:
                if let since = busySince.removeValue(forKey: session.id),
                   old?.state == .busy || old?.state == .waiting,
                   defaults.bool(forKey: SettingsKey.notifyFinished),
                   now.timeIntervalSince(since) >= defaults.double(forKey: SettingsKey.finishedThresholdSeconds)
                {
                    post(
                        title: "Claude finished",
                        body: "\(session.displayTitle) · \(Format.duration(seconds: now.timeIntervalSince(since)))",
                        id: "finished-\(session.id)"
                    )
                }
            }

            if session.state == .waiting, old?.state != .waiting,
               defaults.bool(forKey: SettingsKey.notifyPermission)
            {
                let tool = session.activity?.tool ?? "a tool"
                post(title: "Claude needs approval", body: "\(session.displayTitle) wants to run \(tool)", id: "perm-\(session.id)")
            }
        }

        let alive = Set(next.sessions.map(\.id))
        busySince = busySince.filter { alive.contains($0.key) }
    }

    private func post(title: String, body: String, id: String) {
        guard available else { return }
        let center = UNUserNotificationCenter.current()
        let deliver = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        }
        if authorized {
            deliver()
            return
        }
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                self.authorized = true
                deliver()
            }
        }
    }
}
