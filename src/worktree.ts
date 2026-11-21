// Resolves which worktree a session is actually working in.
//
// Claude Code reports the launch dir only. Sessions typically launch in the
// main checkout and then `git worktree add ../repo-123` + work there via `cd`
// and absolute paths, so the active worktree is the one owning the most
// recently touched path from the transcript.

import { execFileSync } from "node:child_process";
import { sep } from "node:path";

export function listWorktrees(dir: string): string[] {
  try {
    const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  } catch {
    return [];
  }
}

/** Most recent path that lives inside one of `worktrees`, mapped to that worktree's root. */
export function pickActiveWorktree(recentPaths: readonly string[], worktrees: readonly string[]): string | undefined {
  for (let i = recentPaths.length - 1; i >= 0; i--) {
    const owner = ownerOf(recentPaths[i]!, worktrees);
    if (owner) return owner;
  }
  return undefined;
}

function ownerOf(path: string, worktrees: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const wt of worktrees) {
    // Segment-aware: /x/repo must not own /x/repo-123.
    if ((path === wt || path.startsWith(wt + sep)) && (!best || wt.length > best.length)) best = wt;
  }
  return best;
}
