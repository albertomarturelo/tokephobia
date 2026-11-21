// Context window remaining for the current session.
// TODO(capture): confirm which of used_percentage / current_usage the installed
// Claude Code version sends, and how far before the window limit auto-compact fires.

import type { StatusLineInput } from "./input.ts";

export interface ContextInfo {
  windowSize: number;
  usedTokens: number;
  remainingPct: number;
  /** True before the first API response, when no usage has been reported yet. */
  fresh: boolean;
}

export function readContext(input: StatusLineInput): ContextInfo | undefined {
  const cw = input.context_window;
  if (!cw?.context_window_size) return undefined;
  const windowSize = cw.context_window_size;

  if (typeof cw.used_percentage === "number") {
    const usedPct = clamp(cw.used_percentage);
    return { windowSize, usedTokens: Math.round((usedPct / 100) * windowSize), remainingPct: 100 - usedPct, fresh: false };
  }

  const u = cw.current_usage;
  if (!u) return { windowSize, usedTokens: 0, remainingPct: 100, fresh: true };

  const usedTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { windowSize, usedTokens, remainingPct: 100 - clamp((usedTokens / windowSize) * 100), fresh: false };
}

function clamp(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}
