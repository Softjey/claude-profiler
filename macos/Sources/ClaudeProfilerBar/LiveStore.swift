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

    private(set) var snapshot: LiveSnapshot?
    private(set) var status: Status = .starting
    private(set) var lastCollectorError: String?

    @ObservationIgnored private var collector: CollectorProcess?
    @ObservationIgnored private var restartDelay: TimeInterval = 1
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored let notifier = Notifier()
    @ObservationIgnored let command = CollectorCommand.resolve()

    init() {}

    /// A store frozen on one snapshot, for `--render-png`.
    init(preview: LiveSnapshot) {
        snapshot = preview
        status = .running
    }

    private static let fastRateMs = 1_000
    private static let slowRateMs = 5_000

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

    func session(id: String) -> LiveSession? {
        snapshot?.sessions.first { $0.id == id }
    }

    private func handle(_ message: LiveMessage) {
        switch message {
        case .snapshot(let next):
            notifier.compare(previous: snapshot, next: next)
            snapshot = next
            status = .running
            restartDelay = 1
            lastCollectorError = nil
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
