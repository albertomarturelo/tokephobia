// Shape of the JSON Claude Code pipes to the status line command on stdin.
// Confirmed against real captures from Claude Code 2.1.329–2.1.330
// (fixtures/captures/, gitignored). Fields stay optional: older/newer versions
// and session states differ.
//
// IMPORTANT: `cwd` / `workspace.current_dir` are where the session was LAUNCHED.
// They do not change when the session creates a worktree
// (`git worktree add ../repo-123`) and works inside it via `cd` and absolute
// paths. The active worktree has to be inferred from the transcript instead.

export interface StatusLineInput {
  session_id?: string;
  session_name?: string;
  transcript_path?: string;
  cwd?: string;
  version?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  /** Reasoning effort the session is running at (e.g. "low" | "medium" | "high" | "xhigh" | "max"). */
  effort?: {
    level?: string;
  };
  fast_mode?: boolean;
  thinking?: {
    enabled?: boolean;
  };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    /** Present when the launch dir is a git repo with a recognised remote. */
    repo?: {
      host?: string;
      owner?: string;
      name?: string;
    };
  };
  output_style?: {
    name?: string;
  };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  exceeds_200k_tokens?: boolean;
  /** Plan usage windows. Captures show `seven_day`; other windows (e.g. `five_hour`) are handled generically. */
  rate_limits?: Record<string, RateLimitWindow | undefined>;
}

export interface RateLimitWindow {
  used_percentage?: number;
  /** Unix seconds. */
  resets_at?: number;
}

export function parseInput(raw: string): StatusLineInput {
  try {
    const data: unknown = JSON.parse(raw);
    return data && typeof data === "object" ? (data as StatusLineInput) : {};
  } catch {
    return {};
  }
}

/** Directory the session was launched in (not necessarily where it is working). */
export function launchDir(input: StatusLineInput): string | undefined {
  return input.workspace?.current_dir ?? input.cwd;
}
