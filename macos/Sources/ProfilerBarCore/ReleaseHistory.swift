import Foundation

/// Which sessions this app ended, and how — the collector only sees that a
/// process went away, not who quit it. Kept for a day: the app lists only
/// today's ended sessions.
public struct ReleaseHistory: Codable, Equatable, Sendable {
    public struct Record: Codable, Equatable, Sendable {
        public enum Trigger: String, Codable, Sendable {
            /// The Free button.
            case manual
            /// Free idle sessions automatically.
            case auto
        }

        public let trigger: Trigger
        public let at: Date
        public let rssMb: Int?

        public init(trigger: Trigger, at: Date, rssMb: Int?) {
            self.trigger = trigger
            self.at = at
            self.rssMb = rssMb
        }
    }

    public static let retention: TimeInterval = 86_400
    /// Claude Code still writes to the transcript as it exits, so activity
    /// this soon after the release is the release itself, not a resume.
    public static let exitGrace: TimeInterval = 60

    private var records: [String: Record] = [:]

    public init() {}

    public mutating func add(_ record: Record, sessionId: String) {
        records[sessionId] = record
    }

    /// The record that explains why `session` ended, or nil when this app did
    /// not end it — or did, but the chat was resumed and used again since.
    public func record(for session: LiveSession) -> Record? {
        guard !session.state.isLive, let record = records[session.id] else { return nil }
        if let last = session.lastActivityAt, last / 1_000 > record.at.timeIntervalSince1970 + Self.exitGrace { return nil }
        return record
    }

    public func pruned(now: Date = Date()) -> ReleaseHistory {
        var copy = self
        copy.records = records.filter { now.timeIntervalSince($0.value.at) < Self.retention }
        return copy
    }
}
