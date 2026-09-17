import type { Usage } from "../parse/types.js";

export interface ToolUseEvent {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  turnIndex: number;
  startedAt: string | null;
  durationMs: number | null;
  unfinished: boolean;
  assistantUuid: string | undefined;
}

export interface AssistantEvent {
  type: "assistant";
  uuid: string | undefined;
  at: string | null;
  turnIndex: number;
  model: string | undefined;
  stopReason: string | null;
  usage: Usage | undefined;
  /** The API request this record came from; several records share one. */
  requestId: string | undefined;
  /**
   * True when an earlier event already carried this request's `usage`. CC
   * writes one record per content block (thinking / text / tool_use) and
   * repeats the same `usage` object on each, so anything that sums or plots
   * usage must skip these or it double-counts the request.
   */
  isUsageDuplicate: boolean;
}

export interface UserPromptEvent {
  type: "user_prompt";
  uuid: string | undefined;
  at: string | null;
  turnIndex: number;
  /** The prompt's own text as a truncated single-line preview, never the full (possibly huge) prompt. */
  preview: string;
}

export interface SystemEvent {
  type: "system";
  uuid: string | undefined;
  at: string | null;
  turnIndex: number;
  content: string | undefined;
  level: string | undefined;
}

export type ModelEvent = ToolUseEvent | AssistantEvent | UserPromptEvent | SystemEvent;

export interface EventModel {
  events: ModelEvent[];
  toolUses: ToolUseEvent[];
}
