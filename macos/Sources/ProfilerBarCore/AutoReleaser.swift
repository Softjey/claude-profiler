import Foundation

/// Tracks how long each running session has sat idle and picks the ones to
/// release on their own: idle long enough, holding enough memory, and with no
/// load on their process tree. Only `.idle` counts — a busy session or one
/// waiting on approval is never released.
public struct AutoReleaser: Sendable {
    public enum Scope: String, CaseIterable, Identifiable, Sendable {
        /// Terminal sessions only: quitting one drops back to the shell, where
        /// `claude --resume` is one command away. An editor or the desktop app
        /// shows its own error for a process that went away under it.
        case cli
        case all

        public var id: String { rawValue }
    }

    public struct Policy: Sendable {
        public var minimumIdleDuration: TimeInterval
        public var minimumRssMb: Int
        public var scope: Scope

        public init(minimumIdleDuration: TimeInterval, minimumRssMb: Int, scope: Scope) {
            self.minimumIdleDuration = minimumIdleDuration
            self.minimumRssMb = minimumRssMb
            self.scope = scope
        }

        public static let `default` = Policy(minimumIdleDuration: 3_600, minimumRssMb: 500, scope: .cli)
        public static let idleDurationOptions: [TimeInterval] = [1_800, 3_600, 7_200, 14_400]
        public static let minimumRssMbOptions = [200, 500, 1_000]
    }

    /// Average CPU of the session's process tree over `loadWindow` above which
    /// it is working after all — a background build, a busy MCP server. An
    /// average, not a single sample: an idle prompt spikes to 30% for a sample
    /// now and then, and a build dips while it waits on disk or network.
    public static let loadedCpuPct = 10.0
    public static let loadWindow: TimeInterval = 60

    private struct CpuSample: Sendable {
        let at: Date
        let pct: Double
    }

    /// When this app last saw each process do anything. Its own clock, not
    /// the transcript's: typing a prompt writes nothing to the transcript, so
    /// `lastActivityAt` would call a session idle while someone is typing.
    private var idleSince: [Key: Date] = [:]
    private var cpuSamples: [Key: [CpuSample]] = [:]
    /// Processes already handed out once, so a release that failed is not
    /// retried every snapshot.
    private var attempted: Set<Key> = []

    /// A session id with its pid: `claude --resume` brings the same session
    /// back in a new process, which starts its idle clock from scratch.
    private struct Key: Hashable {
        let id: String
        let pid: Int
    }

    public init() {}

    /// Records `snapshot` and returns the sessions to release now, each once.
    /// Call it on every snapshot, with a nil policy while the feature is off,
    /// so idle time is known the moment it is turned on: a session already
    /// idle past the threshold is released then. Sessions in `watched` — an
    /// open detail window — count as active: someone is looking at them.
    public mutating func sessionsToRelease(
        in snapshot: LiveSnapshot,
        policy: Policy?,
        watched: Set<String> = [],
        now: Date = Date()
    ) -> [LiveSession] {
        var seen: Set<Key> = []
        var release: [LiveSession] = []

        for session in snapshot.sessions {
            guard session.state == .idle, let pid = session.pid else { continue }
            let key = Key(id: session.id, pid: pid)
            seen.insert(key)

            var samples = (cpuSamples[key] ?? []).filter { now.timeIntervalSince($0.at) < Self.loadWindow }
            // A missed `ps` tick adds no sample; it does not restart the clock.
            if let cpu = session.cpuPct { samples.append(CpuSample(at: now, pct: cpu)) }
            cpuSamples[key] = samples
            let loaded = !samples.isEmpty && samples.map(\.pct).reduce(0, +) / Double(samples.count) > Self.loadedCpuPct

            if loaded || watched.contains(session.id) || idleSince[key] == nil { idleSince[key] = now }
            guard let policy,
                  let since = idleSince[key],
                  now.timeIntervalSince(since) >= policy.minimumIdleDuration,
                  session.cpuPct != nil,
                  !attempted.contains(key),
                  policy.scope == .all || session.source == .cli,
                  let rss = session.rssMb, rss >= policy.minimumRssMb
            else { continue }
            attempted.insert(key)
            release.append(session)
        }

        // Anything not idle right now starts over next time.
        idleSince = idleSince.filter { seen.contains($0.key) }
        cpuSamples = cpuSamples.filter { seen.contains($0.key) }
        attempted = attempted.filter { seen.contains($0) }
        return release
    }
}
