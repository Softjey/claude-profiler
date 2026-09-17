/**
 * Pure formatting helpers shared by every TUI tab. Kept free of Ink/React so
 * they can be unit-tested without rendering.
 */

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - totalMinutes * 60);
  if (totalMinutes < 60) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  return `${hours}h${minutes.toString().padStart(2, "0")}m`;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatCostUSD(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function stringifyInputValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Flattens a call's minified-JSON inputPreview into a single readable line
 * for list rows (CallList's Input column), stripping the `{"key":"value"}`
 * punctuation that made every row look identical noise. A single-field input
 * (the common case — Bash's `command`, Read's `file_path`, …) collapses to
 * just its value; multiple fields join as `key=value key2=value2`. Falls
 * back to the raw preview whenever it isn't a JSON object (already-truncated
 * JSON, or a tool with a bare string/array input).
 */
export function summarizeInput(inputPreview: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputPreview);
  } catch {
    return inputPreview;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return inputPreview;

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  if (entries.length === 1) return stringifyInputValue(entries[0]![1]);
  return entries.map(([key, value]) => `${key}=${stringifyInputValue(value)}`).join(" ");
}

export function formatCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
