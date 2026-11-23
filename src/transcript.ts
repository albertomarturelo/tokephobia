// Incremental scanner over a session's transcript (JSONL). The transcript belongs
// to exactly one session, so everything derived here is per session and never
// mixes parallel sessions.
//
// It extracts:
// - recentPaths: where the session has been *working*: files it edited/wrote and
//   `cd` / `git -C` / `git worktree add` targets in Bash commands. Reads and
//   other path mentions don't count. The active worktree is resolved from these
//   at render time.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface TranscriptState {
  version: 4;
  transcriptPath: string;
  /** Byte offset just past the last fully processed line. */
  offset: number;
  recentPaths: string[];
}

const MAX_RECENT_PATHS = 40;
// Cheap pre-filter so most lines never hit JSON.parse.
const INTERESTING = /"tool_use"/;

export function emptyState(transcriptPath: string): TranscriptState {
  return { version: 4, transcriptPath, offset: 0, recentPaths: [] };
}

/** Reads whatever was appended since `state.offset` and folds it into a new state. */
export function scanTranscript(prev: TranscriptState | undefined, transcriptPath: string): TranscriptState {
  let state = prev && prev.version === 4 && prev.transcriptPath === transcriptPath ? clone(prev) : emptyState(transcriptPath);

  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return state;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < state.offset) state = emptyState(transcriptPath); // rewritten/truncated
    if (size === state.offset) return state;

    const buf = Buffer.alloc(size - state.offset);
    readSync(fd, buf, 0, buf.length, state.offset);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return state; // only a partial line so far

    for (const line of buf.subarray(0, lastNewline).toString("utf8").split("\n")) {
      if (!INTERESTING.test(line)) continue;
      try {
        applyEntry(state, JSON.parse(line));
      } catch {
        // malformed line: skip
      }
    }
    state.offset += lastNewline + 1;
    return state;
  } finally {
    closeSync(fd);
  }
}

export function applyEntry(state: TranscriptState, entry: any): void {
  if (!entry || typeof entry !== "object") return;

  const content = entry.message?.content;
  if (!Array.isArray(content)) return;
  const cwd: string | undefined = typeof entry.cwd === "string" ? entry.cwd : undefined;
  for (const block of content) {
    if (block?.type === "tool_use" && block.input && typeof block.input === "object") {
      for (const p of workingPathsFromToolCall(String(block.name ?? ""), block.input, cwd)) pushRecent(state, p);
    }
  }
}

function pushRecent(state: TranscriptState, path: string): void {
  const i = state.recentPaths.indexOf(path);
  if (i >= 0) state.recentPaths.splice(i, 1);
  state.recentPaths.push(path);
  if (state.recentPaths.length > MAX_RECENT_PATHS) state.recentPaths.shift();
}

// Tools whose path argument means "the session is working here". Reads,
// searches and listings are deliberately excluded: looking at a file in another
// checkout must not move the session's active worktree.
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Paths a tool call signals the session is working in, in order. */
export function workingPathsFromToolCall(name: string, input: Record<string, unknown>, cwd: string | undefined): string[] {
  const out: string[] = [];
  if (WRITE_TOOLS.has(name)) {
    // Claude Code's file tools always take absolute paths; anything else is ignored.
    for (const key of ["file_path", "notebook_path"]) {
      const v = input[key];
      if (typeof v === "string" && isAbsolute(v)) out.push(resolve(v));
    }
  }
  if (name === "Bash" && typeof input.command === "string") out.push(...workingPathsFromCommand(input.command, cwd));
  return out;
}

const WORKTREE_ADD_OPTS_WITH_VALUE = new Set(["-b", "-B", "--reason"]);

/**
 * Working-location signals in a shell command: `cd <dir>`, `git -C <dir>` and
 * `git worktree add <dir>`. Other path arguments (cat, ls, cp…) are ignored.
 * `cd` is tracked so `cd /repo && git worktree add ../repo-12 && cd ../repo-12`
 * resolves to /repo-12 rather than relative to the session's launch dir.
 */
export function workingPathsFromCommand(command: string, cwd: string | undefined): string[] {
  const out: string[] = [];
  let base = cwd;
  for (const segment of commandSegments(command)) {
    const tokens = segment.filter((t) => !/^[A-Za-z_]\w*=/.test(t)); // drop leading VAR=value
    const [head, ...args] = tokens;

    if (head === "cd" && args[0]) {
      const target = toAbsolute(args[0], base);
      if (target) {
        base = target;
        out.push(target);
      }
    } else if (head === "git") {
      let i = 0;
      // Global options before the subcommand; `-C <dir>` is the one that matters.
      while (i < args.length && args[i]!.startsWith("-")) {
        if (args[i] === "-C" && args[i + 1]) {
          const target = toAbsolute(args[i + 1]!, base);
          if (target) out.push(target);
          i += 2;
        } else if (args[i] === "-c") i += 2;
        else i++;
      }
      if (args[i] === "worktree" && args[i + 1] === "add") {
        // First non-option argument after `worktree add` is the new worktree's path.
        for (let j = i + 2; j < args.length; j++) {
          const arg = args[j]!;
          if (WORKTREE_ADD_OPTS_WITH_VALUE.has(arg)) j++;
          else if (!arg.startsWith("-")) {
            const target = toAbsolute(arg, base);
            if (target) out.push(target);
            break;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Splits a shell command into simple commands (by `&&`, `||`, `;`, `|`, `&`,
 * newlines and parentheses), each as its words. Heredoc bodies are dropped and
 * quoted text with spaces or separators becomes one opaque word, so `cd` inside
 * a script, a commit message or a test name is never read as a real `cd`.
 */
export function commandSegments(command: string): string[][] {
  const text = stripHeredocs(command).replace(/(["'])((?:(?!\1).)*)\1/gs, (_m, _q, body: string) =>
    /[\s;&|()]/.test(body) ? " __quoted__ " : body,
  );
  return text
    .split(/&&|\|\||[;|&\n()]/)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

/** Removes heredoc bodies: everything after `<<DELIM` up to the line holding only DELIM. */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let closer: { delim: string; strip: boolean } | undefined;
  for (const line of lines) {
    if (closer) {
      if ((closer.strip ? line.trim() : line) === closer.delim) closer = undefined;
      continue;
    }
    kept.push(line);
    const m = line.match(/<<(-?)\s*(["']?)([A-Za-z_]\w*)\2/);
    if (m) closer = { delim: m[3]!, strip: m[1] === "-" };
  }
  return kept.join("\n");
}

function unquote(tok: string): string {
  return tok.replace(/^["']|["']$/g, "");
}

function toAbsolute(p: string, base: string | undefined): string | undefined {
  if (/[*?$`{}<>]/.test(p)) return undefined;
  if (p === "~" || p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return resolve(p);
  return base ? resolve(base, p) : undefined;
}

function clone(s: TranscriptState): TranscriptState {
  return { ...s, recentPaths: [...s.recentPaths] };
}
