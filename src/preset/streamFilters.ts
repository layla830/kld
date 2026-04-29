/**
 * Stream content filters with a small state machine for <thinking> tag stripping
 * and dash collapsing.
 *
 * Handles:
 * - <thinking>...</thinking> stripped across chunk boundaries
 * - dash_to_comma: ——|—|– → "，" with consecutive dash collapsing
 *   (——, ———, ——– all produce a single "，", even across chunks)
 * - strip_solid_square: ■ → "" (single-char, immediate)
 *
 * Design:
 * - IDLE state: buffer characters that might be part of <thinking>.
 *   If buffer matches <thinking> prefix, keep buffering.
 *   If buffer is a full <thinking> tag, switch to INSIDE_THINKING.
 *   Otherwise flush via applySingleCharRules.
 * - INSIDE_THINKING state: consume everything until </thinking> is found.
 * - Dash collapsing: consecutive dashes are held in a buffer and flushed
 *   as a single "，" when a non-dash arrives. A trailing dash at chunk
 *   boundary is held in `pendingDash` to support cross-chunk collapsing.
 *
 * IMPORTANT: reasoning_content is NOT processed here. This filter only
 * runs on visible content deltas. The caller is responsible for routing
 * reasoning_content around this filter.
 */

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

type StreamFilterState = "IDLE" | "INSIDE_THINKING";

export interface ThinkingFilterState {
  state: StreamFilterState;
  buffer: string;
  /** true if previous chunk ended with an unresolved dash (pending cross-chunk collapse) */
  pendingDash: boolean;
}

export function createThinkingFilterState(): ThinkingFilterState {
  return { state: "IDLE", buffer: "", pendingDash: false };
}

function isDash(ch: string): boolean {
  return ch === "—" || ch === "–";
}

/**
 * Apply non-dash single-character stream rules to a character.
 * Returns the replacement string ("" to delete, or the character itself).
 * Dash handling is done separately by the dash-collapsing logic.
 */
function applySingleCharRules(ch: string): string {
  if (ch === "■") return "";
  return ch;
}

/**
 * Flush a completed dash run: output a single "，" if there were any dashes.
 */
function flushDashRun(hasDash: boolean, output: string): string {
  if (hasDash) return output + "，";
  return output;
}

/**
 * Process a single visible content chunk through the stream filter.
 *
 * Handles <thinking> tag stripping across chunk boundaries,
 * dash collapsing (consecutive dashes → single "，"), and
 * ■ deletion.
 *
 * Returns the filtered text to send to the client, or null if
 * the entire chunk was consumed by thinking content.
 */
export function processStreamChunk(
  chunk: string,
  state: ThinkingFilterState
): string | null {
  if (!chunk) return null;

  let output = "";
  // Track whether we're in a consecutive dash run within this chunk.
  // If pendingDash is true from the last chunk, we start with an active run.
  let inDashRun = state.pendingDash;
  state.pendingDash = false;

  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];

    if (state.state === "IDLE") {
      // --- Dash collapsing ---
      if (isDash(ch)) {
        inDashRun = true;
        continue; // Don't output yet — wait for non-dash to collapse.
      }

      // Non-dash character. If we had a pending dash run, flush it as a single "，".
      if (inDashRun) {
        output += "，";
        inDashRun = false;
      }

      // --- <thinking> tag detection ---
      state.buffer += ch;

      if (THINKING_OPEN.startsWith(state.buffer)) {
        if (state.buffer === THINKING_OPEN) {
          state.state = "INSIDE_THINKING";
          state.buffer = "";
        }
        continue;
      }

      // Buffer is NOT a prefix of <thinking>. Flush characters.
      while (state.buffer.length > 0 && !THINKING_OPEN.startsWith(state.buffer)) {
        output += applySingleCharRules(state.buffer[0]);
        state.buffer = state.buffer.slice(1);
      }

      if (state.buffer === THINKING_OPEN) {
        state.state = "INSIDE_THINKING";
        state.buffer = "";
      }
      continue;
    }

    // INSIDE_THINKING state
    state.buffer += ch;

    if (THINKING_CLOSE.startsWith(state.buffer)) {
      if (state.buffer === THINKING_CLOSE) {
        state.state = "IDLE";
        state.buffer = "";
      }
      continue;
    }

    // Not a prefix of </thinking>. Discard (we're inside thinking content).
    state.buffer = "";
  }

  // After processing all characters in the chunk, hold any trailing dash run.
  // We cannot know whether the next chunk starts with another dash, so flushing
  // here would make streaming diverge from non-streaming:
  // "text—" + "—more" must behave like "text——more" → "text，more".
  if (state.state === "IDLE" && inDashRun) {
    state.pendingDash = true;
  }

  // Flush any remaining buffer that's not a <thinking> prefix.
  if (state.state === "IDLE" && state.buffer && !THINKING_OPEN.startsWith(state.buffer)) {
    for (const bufCh of state.buffer) {
      output += applySingleCharRules(bufCh);
    }
    state.buffer = "";
  }

  return output || null;
}

/**
 * Called at the end of a stream to flush any pending dash that was held
 * for cross-chunk collapsing. Returns the final output character(s),
 * or "" if nothing to flush.
 */
export function flushPendingDash(state: ThinkingFilterState): string {
  if (state.pendingDash) {
    state.pendingDash = false;
    return "，";
  }
  return "";
}
