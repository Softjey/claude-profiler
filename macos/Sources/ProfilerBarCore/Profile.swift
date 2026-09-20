import Foundation

/// The profile artifact, as `src/artifact/profile.ts` writes it — the same
/// object the terminal UI renders, so no metric is computed twice.
///
/// Everything the TypeScript side types as `| null` or `| undefined` is
/// optional here, and sections added later decode as nil rather than failing
/// the whole profile.
public struct Profile: Decodable, Equatable, Sendable {
    public let schemaVersion: String
    public let generatedAt: String
    public let generator: Generator
    public let session: ProfileSession
    public let timeline: TimeSplit
    public let modelBreakdown: ModelBreakdown
    public let tools: [ToolStat]
    public let subagents: [SubagentStat]
    public let tokens: TokenStats
    public let cost: CostStats?
    public let context: ContextSeries
    public let prompts: [PromptPoint]
    public let hooks: HookInsights?
    public let phases: PhaseSplit?

    public struct Generator: Decodable, Equatable, Sendable {
        public let name: String
        public let version: String
    }
}

public struct ProfileSession: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let transcriptPath: String
    public let projectPath: String?
    public let gitBranch: String?
    public let title: String?
    public let startedAt: String?
    public let endedAt: String?
    public let spanMs: Double
    public let ccVersions: [String]
    public let models: [String]
    public let turnCount: Int
    public let messageCount: Int
    public let isSidechain: Bool
}

// MARK: - Time split

public struct UserGap: Decodable, Equatable, Sendable {
    public let preview: String
    public let full: String
    public let gapMs: Double
}

public struct UnaccountedCause: Decodable, Equatable, Sendable {
    public let label: String
    public let ms: Double
    public let count: Int
}

public struct TimeSplit: Decodable, Equatable, Sendable {
    public let modelMs: Double
    public let toolsMs: Double
    public let userMs: Double
    public let unaccountedMs: Double
    public let spanMs: Double
    public let toolsIncludeApprovals: Bool
    /// "derived" from the transcript alone, "exact" once hooks contributed.
    public let precision: String
    public let userGaps: [UserGap]
    public let unaccountedCauses: [UnaccountedCause]
}

/// The four buckets in the order the terminal UI shows them.
public extension TimeSplit {
    var buckets: [(label: String, ms: Double)] {
        [("Model", modelMs), ("Tools", toolsMs), ("You", userMs), ("Unaccounted", unaccountedMs)]
    }
}

public struct PhaseSplit: Decodable, Equatable, Sendable {
    public let modelMs: Double
    public let toolsMs: Double
    public let userMs: Double
    public let idleMs: Double
    public let unaccountedMs: Double
    public let spanMs: Double
    public let phases: [Resume]
    public let reclaimedFromUserMs: Double
    public let reclaimedFromUnaccountedMs: Double

    public struct Resume: Decodable, Equatable, Sendable {
        public let resumedAt: String
        public let source: String
        public let idleMs: Double
        public let fromUserMs: Double
        public let cacheWriteUsd: Double?
        public let cacheLikelyExpired: Bool?
    }
}

// MARK: - Model

public struct ModelBreakdown: Decodable, Equatable, Sendable {
    public let totalMs: Double
    public let phases: [ModelPhase]
    public let requests: [ModelRequest]
    public let suspect: [ModelSuspect]
    public let suspectMs: Double
    public let stallThresholdTokensPerSec: Double?
    public let contextLatency: ContextLatency?
    public let byCause: [ModelRollup]
    public let byModel: [ModelRollup]
    public let byEffort: [ModelRollup]
    public let coverage: Coverage?
    public let precision: String?

    public struct ContextLatency: Decodable, Equatable, Sendable {
        public let correlation: Double?
        public let requests: Int
    }

    public struct Coverage: Decodable, Equatable, Sendable {
        public let requestsWithBlockSplit: Int
        public let totalRequests: Int
    }
}

public struct ModelPhase: Decodable, Equatable, Sendable {
    public let kind: String
    public let position: String
    public let ms: Double
    public let pctOfModel: Double
    public let slices: Int
    public let suspectMs: Double
}

public struct ModelSuspect: Decodable, Equatable, Sendable {
    public let reason: String
    public let ms: Double
    public let requests: Int
    public let pctOfModel: Double
    public let kinds: [String]
}

public struct ModelRollup: Decodable, Equatable, Sendable, Identifiable {
    public let key: String
    public let ms: Double
    public let requests: Int
    public let pctOfModel: Double

    public var id: String { key }
}

public struct ModelRequest: Decodable, Equatable, Sendable, Identifiable {
    public let key: String
    public let requestId: String?
    public let index: Int
    public let turnIndex: Int
    public let at: String?
    public let model: String?
    public let effort: String?
    public let stopReason: String?
    public let totalMs: Double
    public let firstBlockMs: Double
    public let continuationMs: Double
    public let outputTokens: Int
    public let thinkingTokens: Int
    public let contextTokens: Int
    public let tokensPerSec: Double?
    public let blocks: [String]
    public let cause: Cause?
    /// "api_error" / "stalled", or nil for a healthy request.
    public let suspect: String?
    public let preview: String

    public var id: String { key }

    public struct Cause: Decodable, Equatable, Sendable {
        public let kind: String
        public let name: String?

        public var label: String {
            switch kind {
            case "prompt": "after your prompt"
            case "tool": "after \(name ?? "a tool")"
            default: name ?? "other"
            }
        }
    }
}

// MARK: - Tools

public struct ToolCall: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let turnIndex: Int
    public let startedAt: String?
    public let durationMs: Double?
    public let inputPreview: String
}

public struct BashGroupStat: Decodable, Equatable, Sendable, Identifiable {
    public let group: String
    public let calls: Int
    public let totalMs: Double
    public let medianMs: Double
    public let maxMs: Double
    public let unfinishedCount: Int
    public let pctOfBash: Double
    public let callIds: [String]

    public var id: String { group }
}

/// `ExactToolStat`: the transcript's tool stats, plus what hooks can add.
public struct ToolStat: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let kind: String
    public let mcpServer: String?
    public let calls: Int
    public let totalMs: Double
    public let typicalMs: Double
    public let medianMs: Double
    public let p90Ms: Double
    public let maxMs: Double
    public let unfinishedCount: Int
    public let pctOfSession: Double
    public let callRefs: [ToolCall]
    public let bashGroups: [BashGroupStat]?
    public let bashCommands: [BashGroupStat]?
    public let exactMs: Double?
    public let approvalMs: Double?
    public let overheadMs: Double?
    public let promptedCalls: Int?
    public let failedCalls: Int?
    public let interruptedCalls: Int?
    public let deniedCalls: Int?
    public let responseBytes: Double?

    public var id: String { name }
}

public struct SubagentStat: Decodable, Equatable, Sendable, Identifiable {
    public let agentId: String
    public let transcriptPath: String
    public let parentToolCallId: String
    public let spanMs: Double
    public let timeline: TimeSplit
    public let tools: [ToolStat]
    public let tokens: TokenStats

    public var id: String { agentId }
}

// MARK: - Tokens, cost, context, prompts

public struct TokenBucket: Decodable, Equatable, Sendable {
    public let input: Int
    public let output: Int
    public let thinking: Int
    public let cacheRead: Int
    public let cacheCreate1h: Int
    public let cacheCreate5m: Int

    public var cacheCreate: Int { cacheCreate1h + cacheCreate5m }
    public var total: Int { input + output + cacheRead + cacheCreate }
}

public struct TokenStats: Decodable, Equatable, Sendable {
    public let byModel: [String: TokenBucket]
    public let totals: TokenBucket
}

public struct CostStats: Decodable, Equatable, Sendable {
    public let source: String
    public let totalCostUSD: Double
    public let byModel: [String: Double]
    public let totalApiDurationMs: Double
    public let totalToolDurationMs: Double
    public let linesAdded: Int
    public let linesRemoved: Int
}

public struct ContextPoint: Decodable, Equatable, Sendable {
    public let turnIndex: Int
    public let at: String?
    public let cacheReadTokens: Int
    public let cacheCreateTokens: Int
    public let outputTokens: Int
    public let thinkingTokens: Int

    /// What the request had to pay for again: the whole prompt.
    public var contextTokens: Int { cacheReadTokens + cacheCreateTokens }
}

public struct ContextSeries: Decodable, Equatable, Sendable {
    public let turns: [ContextPoint]
}

public struct PromptPoint: Decodable, Equatable, Sendable {
    public let turnIndex: Int
    public let at: String?
    public let preview: String
}

// MARK: - Hooks

public struct HookInsights: Decodable, Equatable, Sendable {
    public let sidecarVersion: Int?
    public let callsWithTiming: Int
    public let approval: Approval
    public let reliability: Reliability
    public let parallelism: Parallelism
    public let contextPollution: ContextPollution
    public let lifecycle: Lifecycle
    public let cacheWaste: CacheWaste?
    public let turns: [Turn]?

    public struct Approval: Decodable, Equatable, Sendable {
        public let precision: String
        public let decisionMs: Double?
        public let overheadMs: Double?
        public let totalWaitMs: Double
        public let promptedCalls: Int
        public let autoApprovedCalls: Int
        public let deniedCalls: Int
        public let slowestDecisionMs: Double?
        public let medianDecisionMs: Double?
    }

    public struct ToolFailure: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let failedCalls: Int
        public let interruptedCalls: Int
        public let wastedMs: Double
        public let errorPreview: String?

        public var id: String { name }
    }

    public struct Reliability: Decodable, Equatable, Sendable {
        public let failedCalls: Int
        public let interruptedCalls: Int
        public let deniedCalls: Int
        public let wastedMs: Double
        public let byTool: [ToolFailure]
    }

    public struct Parallelism: Decodable, Equatable, Sendable {
        public let batches: Int
        public let multiCallBatches: Int
        public let largestBatch: Int
        public let serialMs: Double?
        public let wallMs: Double?
        public let savedMs: Double?
    }

    public struct ToolResponseSize: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let calls: Int
        public let totalBytes: Double
        public let maxBytes: Double
        public let medianBytes: Double

        public var id: String { name }
    }

    public struct ContextPollution: Decodable, Equatable, Sendable {
        public let totalBytes: Double
        public let maxBytes: Double
        public let byTool: [ToolResponseSize]
    }

    public struct Lifecycle: Decodable, Equatable, Sendable {
        public let starts: [Start]
        public let endReason: String?
        public let idleMs: Double
        public let turnsWaitingOnBackground: Int?

        public struct Start: Decodable, Equatable, Sendable {
            public let at: String
            public let source: String
            public let model: String?
            public let idleMs: Double?
            public let contextTokens: Int?
            public let cacheLikelyExpired: Bool?
            public let cacheWriteUsd: Double?
        }
    }

    public struct CacheWaste: Decodable, Equatable, Sendable {
        public let resumeUsd: Double?
        public let modelSwitchUsd: Double?
        public let totalUsd: Double?
        public let resumes: Int
        public let modelSwitches: Int
        public let switchesForfeitingWarmCache: Int
    }

    public struct Turn: Decodable, Equatable, Sendable {
        public let promptId: String
        public let toolCalls: Int
        public let toolExecMs: Double
        public let decisionMs: Double?
        public let failedCalls: Int
        public let responseBytes: Double?
        public let effort: String?
    }
}
