import type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscriptRecord,
  UserRecord,
} from "../parse/types.js";
import type { BlockKind, EventModel, ModelEvent, ToolUseEvent } from "./events.js";

const PROMPT_PREVIEW_MAX_CHARS = 200;
/** Shorter than a prompt preview: this only has to label a row in the request list. */
const REPLY_PREVIEW_MAX_CHARS = 120;

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === "thinking";
}

function blockKindOf(block: ContentBlock): BlockKind {
  if (block.type === "thinking" || block.type === "text" || block.type === "tool_use") return block.type;
  return "other";
}

/**
 * The one label a record's time slice gets when it carried several blocks.
 * Ordered by what dominates the wall clock: a record with thinking in it
 * spent that slice thinking, and emitting a tool_use is the cheapest of the
 * three, so it only wins when nothing else is there.
 */
function collapseBlockKinds(kinds: BlockKind[]): BlockKind {
  if (kinds.includes("thinking")) return "thinking";
  if (kinds.includes("text")) return "text";
  if (kinds.includes("tool_use")) return "tool_use";
  return "other";
}

/** What the model itself wrote in this record, whitespace-collapsed to one line but never truncated. */
function extractReplyFull(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(block.text ?? "");
    else if (isThinkingBlock(block)) parts.push(block.thinking ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** A one-line preview of what the model itself wrote in this record. */
function extractReplyPreview(full: string): string {
  return full.length > REPLY_PREVIEW_MAX_CHARS ? `${full.slice(0, REPLY_PREVIEW_MAX_CHARS - 1)}\u2026` : full;
}

/**
 * A single-line, length-capped preview of what the user typed (D-follow-up:
 * the You drill-down needs the prompt text itself, not just its timing).
 * `content` is either a plain string or a content-block array across the CC
 * versions in the wild (same leniency as everywhere else in this file); only
 * text blocks contribute, since tool_result/image blocks carry nothing a
 * person wrote themselves.
 */
function extractPromptFull(content: string | ContentBlock[] | undefined): string {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(isTextBlock)
            .map((block) => block.text ?? "")
            .join(" ")
        : "";

  return raw.replace(/\s+/g, " ").trim();
}

function extractPromptPreview(full: string): string {
  if (full.length === 0) return "(empty prompt)";
  return full.length > PROMPT_PREVIEW_MAX_CHARS ? `${full.slice(0, PROMPT_PREVIEW_MAX_CHARS - 1)}…` : full;
}

function timestampMs(timestamp: string | undefined | null): number | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Records without a timestamp are excluded from timing but kept in the model.
 * A stable sort with a "no opinion" comparator for any pair involving a
 * missing timestamp leaves such records at their original (file) position
 * relative to their neighbors, instead of shuffling them.
 */
function compareByTimestamp(a: TranscriptRecord, b: TranscriptRecord): number {
  const ta = timestampMs(a.timestamp);
  const tb = timestampMs(b.timestamp);
  if (ta === null || tb === null) return 0;
  return ta - tb;
}

function isToolResultCarrier(record: UserRecord): boolean {
  const content = record.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === "tool_result");
}

/**
 * CC writes exactly these two strings (nothing else) when the person cuts a
 * turn off mid-flight, as a plain-text `user` record. Matched verbatim,
 * never as a substring, so a person's own message that happens to quote one
 * is never misread as the harness talking.
 */
const INTERRUPTION_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

function interruptionMarkerText(record: UserRecord): string | undefined {
  const content = record.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && isTextBlock(content[0] as ContentBlock)
        ? ((content[0] as TextBlock).text ?? "")
        : undefined;
  return text !== undefined && INTERRUPTION_MARKERS.has(text) ? text : undefined;
}

function isGenuinePrompt(record: UserRecord): boolean {
  if (record.isMeta) return false;
  if (isToolResultCarrier(record)) return false;
  return interruptionMarkerText(record) === undefined;
}

/**
 * Turns a flat record stream into a timeline of typed events, matching each
 * tool_use to its tool_result by id and computing durationMs. A tool_use with
 * no matching result (an interrupted session) is left with durationMs: null
 * and unfinished: true, never a crash.
 */
export function buildEventModel(records: TranscriptRecord[]): EventModel {
  const sorted = [...records].sort(compareByTimestamp);
  const events: ModelEvent[] = [];
  const toolUses: ToolUseEvent[] = [];
  const pendingToolUses = new Map<string, ToolUseEvent>();
  const requestIdsWithCountedUsage = new Set<string>();
  const requestIdsSeen = new Set<string>();

  let turnIndex = -1;

  for (const record of sorted) {
    if (record.type === "user") {
      if (isGenuinePrompt(record)) {
        turnIndex++;
        const full = extractPromptFull(record.message?.content);
        events.push({
          type: "user_prompt",
          uuid: record.uuid,
          at: record.timestamp ?? null,
          turnIndex,
          preview: extractPromptPreview(full),
          full,
        });
      } else if (interruptionMarkerText(record) !== undefined) {
        events.push({
          type: "interruption",
          uuid: record.uuid,
          at: record.timestamp ?? null,
          turnIndex: turnIndex < 0 ? 0 : turnIndex,
        });
      } else if (isToolResultCarrier(record)) {
        const content = record.message?.content as ContentBlock[];
        for (const block of content) {
          if (!isToolResultBlock(block)) continue;
          const toolUseId = block.tool_use_id;
          if (!toolUseId) continue;
          const pendingCall = pendingToolUses.get(toolUseId);
          if (!pendingCall) continue;
          pendingToolUses.delete(toolUseId);

          const startMs = timestampMs(pendingCall.startedAt);
          const endMs = timestampMs(record.timestamp);
          if (startMs !== null && endMs !== null) {
            pendingCall.durationMs = endMs - startMs;
            pendingCall.unfinished = false;
          }
        }
      }
      continue;
    }

    if (record.type === "assistant") {
      const resolvedTurnIndex = turnIndex < 0 ? 0 : turnIndex;
      const message = record.message;
      const usage = message?.usage;

      // One API request is written as several records — one per content
      // block — and every one of them repeats the same `usage`. The first
      // record that actually carries usage owns it; the rest are flagged so
      // token/context sums count each request once (D-follow-up). A record
      // with no requestId (older CC versions) is always its own request.
      // Normalised: CC writes `requestId: null` on the records it synthesises
      // for a failed API call, and a null key would group every one of them
      // together as one phantom request.
      const requestId = record.requestId ?? undefined;
      const isUsageDuplicate =
        usage !== undefined && requestId !== undefined && requestIdsWithCountedUsage.has(requestId);
      if (usage !== undefined && requestId !== undefined && !isUsageDuplicate) {
        requestIdsWithCountedUsage.add(requestId);
      }

      // Tracked separately from `isUsageDuplicate`: usage can be absent on a
      // record that is still not the request's first (and an API-error record
      // has no requestId at all, so it is always its own first).
      const isFirstOfRequest = requestId === undefined || !requestIdsSeen.has(requestId);
      if (requestId !== undefined) requestIdsSeen.add(requestId);

      const blockKinds = Array.isArray(message?.content) ? message.content.map(blockKindOf) : [];
      const full = extractReplyFull(message?.content);

      events.push({
        type: "assistant",
        uuid: record.uuid,
        at: record.timestamp ?? null,
        turnIndex: resolvedTurnIndex,
        model: message?.model,
        stopReason: message?.stop_reason ?? null,
        usage,
        requestId,
        isUsageDuplicate,
        blockKinds,
        kind: collapseBlockKinds(blockKinds),
        isFirstOfRequest,
        effort: record.effort,
        isApiError: record.isApiErrorMessage === true,
        errorKind: record.error,
        preview: extractReplyPreview(full),
        full,
      });

      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isToolUseBlock(block) || !block.id || !block.name) continue;

          const toolUseEvent: ToolUseEvent = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
            turnIndex: resolvedTurnIndex,
            startedAt: record.timestamp ?? null,
            durationMs: null,
            unfinished: true,
            assistantUuid: record.uuid,
          };

          events.push(toolUseEvent);
          toolUses.push(toolUseEvent);
          pendingToolUses.set(block.id, toolUseEvent);
        }
      }
      continue;
    }

    if (record.type === "system") {
      events.push({
        type: "system",
        uuid: record.uuid,
        at: record.timestamp ?? null,
        turnIndex: turnIndex < 0 ? 0 : turnIndex,
        content: record.content,
        level: record.level,
      });
    }
  }

  return { events, toolUses };
}
