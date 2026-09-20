import AppKit
import Foundation
import Observation
import ProfilerBarCore

/// The app's single source of truth: the latest snapshot from the collector,
/// and the collector's own health. Restarts the collector with backoff when
/// it dies, and polls fast only while someone is looking.
@MainActor
@Observable
final class LiveStore {
    enum Status: Equatable {
        case starting
        case running
        case failed(String)
    }

    enum ProfileState: Equatable {
        case loading
        case loaded(Profile)
        case failed(String)
    }

    private(set) var snapshot: LiveSnapshot?
    /// Full profiles for the sessions whose detail windows are open.
    private(set) var profiles: [String: ProfileState] = [:]
    private(set) var status: Status = .starting
    private(set) var lastCollectorError: String?

    @ObservationIgnored private var collector: CollectorProcess?
    @ObservationIgnored private var restartDelay: TimeInterval = 1
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored let command = CollectorCommand.resolve()
    @ObservationIgnored private var openWindowAction: ((String, String?) -> Void)?
    @ObservationIgnored private var watchedProfiles: [String: Int] = [:]
    @ObservationIgnored private var profileRequests: [String: (activityAt: Double, at: Date)] = [:]

    /// One store per app. The AppKit delegate needs to reach it from outside
    /// the SwiftUI scene tree, to open the window on reopen and first launch.
    static let shared = LiveStore()

    init() {}

    /// A store frozen on one snapshot, for `--render-png`.
    init(preview: LiveSnapshot, profile: (id: String, value: Profile)? = nil) {
        snapshot = preview
        status = .running
        if let profile {
            profiles[profile.id] = .loaded(profile.value)
            watchedProfiles[profile.id] = 1
        }
    }

    private static let fastRateMs = 1_000
    private static let slowRateMs = 5_000
    /// A busy session re-parses its whole transcript per profile, so a detail
    /// window follows it at a slower beat than the snapshot stream.
    private static let profileRefreshInterval: TimeInterval = 3

    func start() {
        guard collector == nil else { return }
        let process = CollectorProcess(command: command)
        process.onMessage = { [weak self] message in self?.handle(message) }
        process.onExit = { [weak self] code, stderr in self?.collectorExited(code: code, stderr: stderr) }
        do {
            try process.start()
            collector = process
            process.setRate(milliseconds: watchers > 0 ? Self.fastRateMs : Self.slowRateMs)
        } catch {
            status = .failed("Could not start \(command.description): \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    /// Called when a popover or detail window appears / disappears.
    func beginWatching() {
        watchers += 1
        if watchers == 1 {
            collector?.setRate(milliseconds: Self.fastRateMs)
            collector?.refresh()
        }
    }

    func endWatching() {
        watchers = max(0, watchers - 1)
        if watchers == 0 { collector?.setRate(milliseconds: Self.slowRateMs) }
    }

    /// SwiftUI's `openWindow` only exists inside a scene, so the menu bar
    /// label — the one view that is always rendered — hands it over here.
    func bindWindowOpener(_ action: @escaping (String, String?) -> Void) {
        openWindowAction = action
    }

    /// The way in when the menu bar icon is not reachable: macOS hides items
    /// when the bar is full, and says nothing about it.
    func openSessionsWindow() {
        openWindowAction?("sessions", nil)
        NSApp.activate()
    }

    func openSessionWindow(id: String) {
        openWindowAction?("session", id)
        NSApp.activate()
    }

    func session(id: String) -> LiveSession? {
        snapshot?.sessions.first { $0.id == id }
    }

    /// Starts following one session's full profile — the same artifact the
    /// terminal UI renders. Refreshed as the session writes more transcript.
    func beginProfile(id: String) {
        watchedProfiles[id, default: 0] += 1
        if profiles[id] == nil {
            profiles[id] = .loading
            requestProfile(id: id)
        }
    }

    func endProfile(id: String) {
        guard let count = watchedProfiles[id] else { return }
        if count <= 1 {
            watchedProfiles.removeValue(forKey: id)
            profiles.removeValue(forKey: id)
            profileRequests.removeValue(forKey: id)
        } else {
            watchedProfiles[id] = count - 1
        }
    }

    func reloadProfile(id: String) {
        profiles[id] = .loading
        requestProfile(id: id)
    }

    private func requestProfile(id: String) {
        profileRequests[id] = (session(id: id)?.lastActivityAt ?? 0, Date())
        collector?.requestProfile(id: id)
    }

    /// Re-requests a watched profile once its session has written more.
    private func refreshWatchedProfiles(for next: LiveSnapshot) {
        let now = Date()
        for id in watchedProfiles.keys {
            let activityAt = next.sessions.first { $0.id == id }?.lastActivityAt ?? 0
            guard let last = profileRequests[id] else {
                requestProfile(id: id)
                continue
            }
            guard activityAt != last.activityAt,
                  now.timeIntervalSince(last.at) >= Self.profileRefreshInterval
            else { continue }
            requestProfile(id: id)
        }
    }

    private func handle(_ message: LiveMessage) {
        switch message {
        case .snapshot(let next):
            notifier.compare(previous: snapshot, next: next)
            refreshWatchedProfiles(for: next)
            snapshot = next
            status = .running
            restartDelay = 1
            lastCollectorError = nil
        case .profile(let id, let profile):
            guard watchedProfiles[id] != nil else { return }
            profiles[id] = .loaded(profile)
        case .profileError(let id, let message):
            guard watchedProfiles[id] != nil else { return }
            profiles[id] = .failed(message)
        case .error(let text):
            lastCollectorError = text
        }
    }

    private func collectorExited(code: Int32, stderr: String) {
        collector = nil
        let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        status = .failed(detail.isEmpty ? "Collector exited with status \(code)" : detail)
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.start()
        }
    }
}
