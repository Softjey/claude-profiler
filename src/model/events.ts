import type { Usage } from "../parse/types.js";

/**
 * The kind of content an assistant record carried. CC writes one record per
 * content block as that block finishes streaming, so this is the label on
 * the wall-clock slice the record closes — the one thing that turns the
 * Model bucket from an estimate into a measurement (model-breakdown.ts).
 * A record with several blocks is labelled by the first of thinking / text
 * / tool_use present, since that is what the slice was mostly spent on.
 */
export type BlockKind = "thinking" | "text" | "tool_use" | "other";

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
  /** What this record's content blocks were, in order. */
  blockKinds: BlockKind[];
  /** `blockKinds`, collapsed to the one label this record's time slice gets. */
  kind: BlockKind;
  /** True for the first record of its request: its slice also covers queue + prefill. */
  isFirstOfRequest: boolean;
  /** Thinking effort the request ran at, when the transcript records it. */
  effort: string | undefined;
  /** True when CC synthesised this record after the API call failed. */
  isApiError: boolean;
  /** The failure's name ("server_error", ...) when `isApiError`. */
  errorKind: string | undefined;
  /** First line of the record's own thinking/text, for the request drill-down. */
  preview: string;
  /** The record's own thinking/text, capped much higher than `preview`, for the request detail screen. */
  full: string;
}

export interface UserPromptEvent {
  type: "user_prompt";
  uuid: string | undefined;
  at: string | null;
  turnIndex: number;
  /** The prompt's own text as a truncated single-line preview, never the full (possibly huge) prompt. */
  preview: string;
  /** The prompt's own text, capped much higher than `preview`, for the prompt detail screen. */
  full: string;
}

export interface SystemEvent {
  type: "system";
  uuid: string | undefined;
  at: string | null;
  turnIndex: number;
  content: string | undefined;
  level: string | undefined;
}

/**
 * CC's own "[Request interrupted by user(...)]" marker: a `user` record that
 * looks like a prompt (not `isMeta`, not a tool_result carrier) but is
 * actually the harness closing the turn the person just cut off, not
 * something they typed. It is never a genuine prompt (never bumps
 * `turnIndex`, never appears in the "You" drill-down's prompt list), but it
 * is the true end of the interrupted turn — the boundary time-split.ts needs
 * to close the "You" gap instead of leaving it unaccounted (D-follow-up).
 */
export interface InterruptionEvent {
  type: "interruption";
  uuid: string | undefined;
  at: string | null;
  turnIndex: number;
}

export type ModelEvent = ToolUseEvent | AssistantEvent | UserPromptEvent | SystemEvent | InterruptionEvent;

export interface EventModel {
  events: ModelEvent[];
  toolUses: ToolUseEvent[];
}
