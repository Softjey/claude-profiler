import type {
  ContentBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscriptRecord,
  UserRecord,
} from "../parse/types.js";
import type { EventModel, ModelEvent, ToolUseEvent } from "./events.js";

const PROMPT_PREVIEW_MAX_CHARS = 200;

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

/**
 * A single-line, length-capped preview of what the user typed (D-follow-up:
 * the You drill-down needs the prompt text itself, not just its timing).
 * `content` is either a plain string or a content-block array across the CC
 * versions in the wild (same leniency as everywhere else in this file); only
 * text blocks contribute, since tool_result/image blocks carry nothing a
 * person wrote themselves.
 */
function extractPromptPreview(content: string | ContentBlock[] | undefined): string {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(isTextBlock)
            .map((block) => block.text ?? "")
            .join(" ")
        : "";

  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "(empty prompt)";
  return collapsed.length > PROMPT_PREVIEW_MAX_CHARS
    ? `${collapsed.slice(0, PROMPT_PREVIEW_MAX_CHARS - 1)}…`
    : collapsed;
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

function isGenuinePrompt(record: UserRecord): boolean {
  if (record.isMeta) return false;
  return !isToolResultCarrier(record);
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

  let turnIndex = -1;

  for (const record of sorted) {
    if (record.type === "user") {
      if (isGenuinePrompt(record)) {
        turnIndex++;
        events.push({
          type: "user_prompt",
          uuid: record.uuid,
          at: record.timestamp ?? null,
          turnIndex,
          preview: extractPromptPreview(record.message?.content),
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

      events.push({
        type: "assistant",
        uuid: record.uuid,
        at: record.timestamp ?? null,
        turnIndex: resolvedTurnIndex,
        model: message?.model,
        stopReason: message?.stop_reason ?? null,
        usage: message?.usage,
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
