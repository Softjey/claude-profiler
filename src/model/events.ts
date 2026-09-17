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
