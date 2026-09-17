// Field shapes are best-effort: the transcript schema drifts across 14 CC versions,
// so every field beyond `type` must be treated as possibly absent.

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  output_tokens_details?: {
    thinking_tokens?: number;
  };
  service_tier?: string;
}

export interface TextBlock {
  type: "text";
  text?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source?: unknown;
}

export interface UnknownContentBlock {
  type: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | UnknownContentBlock;

export interface AssistantMessage {
  id?: string;
  role?: "assistant";
  model?: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: Usage;
}

export interface UserMessage {
  role?: "user";
  content?: string | ContentBlock[];
}

export interface TranscriptRecordBase {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  isSidechain?: boolean;
}

export interface AssistantRecord extends TranscriptRecordBase {
  type: "assistant";
  message?: AssistantMessage;
  requestId?: string;
}

export interface UserRecord extends TranscriptRecordBase {
  type: "user";
  message?: UserMessage;
  isMeta?: boolean;
  toolUseResult?: unknown;
}

export interface AttachmentRecord extends TranscriptRecordBase {
  type: "attachment";
}

export interface SystemRecord extends TranscriptRecordBase {
  type: "system";
  content?: string;
  level?: string;
}

export interface ModeRecord extends TranscriptRecordBase {
  type: "mode";
  mode?: string;
}

export interface LastPromptRecord extends TranscriptRecordBase {
  type: "last-prompt";
  prompt?: string;
}

export interface AiTitleRecord extends TranscriptRecordBase {
  type: "ai-title";
  aiTitle?: string;
}

export interface CustomTitleRecord extends TranscriptRecordBase {
  type: "custom-title";
  customTitle?: string;
}

export interface FileHistorySnapshotRecord extends TranscriptRecordBase {
  type: "file-history-snapshot";
}

export interface FileHistoryDeltaRecord extends TranscriptRecordBase {
  type: "file-history-delta";
}

export interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
}

export interface CostStateRecord extends TranscriptRecordBase {
  type: "cost-state";
  totalCostUSD?: number;
  totalAPIDuration?: number;
  totalAPIDurationWithoutRetries?: number;
  totalToolDuration?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  totalDuration?: number;
  startTime?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
  hasUnknownModelCost?: boolean;
}

export interface QueueOperationRecord extends TranscriptRecordBase {
  type: "queue-operation";
}

export interface BridgeSessionRecord extends TranscriptRecordBase {
  type: "bridge-session";
}

export interface ForkContextRefRecord extends TranscriptRecordBase {
  type: "fork-context-ref";
}

export const KNOWN_RECORD_TYPES = [
  "assistant",
  "user",
  "attachment",
  "system",
  "mode",
  "last-prompt",
  "ai-title",
  "custom-title",
  "file-history-snapshot",
  "file-history-delta",
  "cost-state",
  "queue-operation",
  "bridge-session",
  "fork-context-ref",
] as const;

export type KnownRecordType = (typeof KNOWN_RECORD_TYPES)[number];

export type TranscriptRecord =
  | AssistantRecord
  | UserRecord
  | AttachmentRecord
  | SystemRecord
  | ModeRecord
  | LastPromptRecord
  | AiTitleRecord
  | CustomTitleRecord
  | FileHistorySnapshotRecord
  | FileHistoryDeltaRecord
  | CostStateRecord
  | QueueOperationRecord
  | BridgeSessionRecord
  | ForkContextRefRecord;

export interface ParseDiagnostics {
  skippedLines: number;
  unknownRecordTypes: Record<string, number>;
}

export interface ParseResult {
  records: TranscriptRecord[];
  diagnostics: ParseDiagnostics;
}
