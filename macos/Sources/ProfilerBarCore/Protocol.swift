import Foundation

/// Mirror of `src/live/protocol.ts`. Enums fall back to `.other` / `.unknown`
/// on a value they do not know, so a newer collector never breaks decoding.
public let supportedProtocolVersion = 1

public enum SessionSource: String, Decodable, Sendable {
    case cli, vscode, desktop, sdk, other

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionSource(rawValue: raw) ?? .other
    }
}

public enum SessionState: String, Decodable, Sendable {
    case busy, waiting, idle, ended, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionState(rawValue: raw) ?? .unknown
    }

    public var isLive: Bool { self == .busy || self == .waiting || self == .idle }
}

public struct LiveTokens: Decodable, Equatable, Sendable {
    public let input: Int
    public let output: Int
    public let cacheRead: Int
    public let cacheCreate: Int

    public var total: Int { input + output + cacheRead + cacheCreate }
}

public struct LiveActivity: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case tool, permission, unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public let kind: Kind
    public let tool: String
    /// Epoch milliseconds.
    public let since: Double
}

public struct LiveSession: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String?
    public let cwd: String?
    public let source: SessionSource
    public let state: SessionState
    public let pid: Int?
    public let startedAt: Double?
    public let lastActivityAt: Double?
    public let model: String?
    public let tokens: LiveTokens
    public let tokensToday: Int
    public let contextTokens: Int?
    public let costUsd: Double?
    public let subagents: Int
    public let cpuPct: Double?
    public let rssMb: Int?
    public let activity: LiveActivity?
    public let burn: [Int]
    public let transcriptPath: String?

    public var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return projectName ?? String(id.prefix(8))
    }

    public var projectName: String? {
        guard let cwd else { return nil }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }
}

public struct LiveToday: Decodable, Equatable, Sendable {
    public let tokens: Int
    public let sessions: Int
    public let costUsd: Double?
}

public struct LiveSnapshot: Decodable, Equatable, Sendable {
    public let v: Int
    public let at: Double
    public let hooksInstalled: Bool
    public let today: LiveToday
    public let sessions: [LiveSession]

    public var busyCount: Int { sessions.filter { $0.state == .busy }.count }
    public var waitingCount: Int { sessions.filter { $0.state == .waiting }.count }
    public var liveCount: Int { sessions.filter { $0.state.isLive }.count }
}

public enum LiveMessage: Equatable, Sendable {
    case snapshot(LiveSnapshot)
    case profile(id: String, profile: Profile)
    case profileError(id: String, message: String)
    case error(String)

    private struct Envelope: Decodable {
        let v: Int
        let type: String
        let id: String?
        let message: String?
    }

    private struct ProfileEnvelope: Decodable {
        let id: String
        let profile: Profile
    }

    /// Nil for anything that is not a message this app understands — a
    /// login shell's banner on stdout, a newer protocol version.
    public static func decode(_ line: Data) -> LiveMessage? {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: line),
              envelope.v == supportedProtocolVersion
        else { return nil }

        switch envelope.type {
        case "snapshot":
            return (try? decoder.decode(LiveSnapshot.self, from: line)).map(LiveMessage.snapshot)
        case "profile":
            guard let decoded = try? decoder.decode(ProfileEnvelope.self, from: line) else {
                // A profile this version cannot decode is reported, not dropped:
                // an empty detail window with no reason is worse than a message.
                return envelope.id.map { .profileError(id: $0, message: "This profile could not be decoded") }
            }
            return .profile(id: decoded.id, profile: decoded.profile)
        case "profile-error":
            guard let id = envelope.id else { return nil }
            return .profileError(id: id, message: envelope.message ?? "unknown error")
        case "error":
            return .error(envelope.message ?? "unknown error")
        default:
            return nil
        }
    }
}
