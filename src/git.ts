// Worktree-aware git info. Every command runs with `git -C <sessionDir>` so each
// parallel session reports its own worktree, regardless of where the status
// line process happens to be spawned.

import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export interface GitInfo {
  /** Name of the main repository (dir that owns the common .git). */
  repo: string;
  /** Set when the session is inside a linked worktree (not the main checkout). */
  worktree?: string;
  /** Branch name, or short SHA when HEAD is detached. */
  branch: string;
  detached: boolean;
  /** Tracked files with staged or unstaged changes (incl. renames). */
  modified: number;
  /** Files git doesn't track yet. */
  untracked: number;
  /** Files with unresolved merge conflicts. */
  conflicts: number;
  ahead: number;
  behind: number;
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
  } catch {
    return undefined;
  }
}

export function readGitInfo(dir: string): GitInfo | undefined {
  // One call resolves everything needed to tell a worktree from the main checkout.
  const out = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  if (!out) return undefined;
  const [gitDir, commonDir, toplevel] = out.split("\n");
  if (!gitDir || !commonDir || !toplevel) return undefined;

  const isLinkedWorktree = resolve(gitDir) !== resolve(commonDir);
  const repo = basename(dirname(resolve(commonDir)));

  let branch = git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const detached = !branch;
  if (!branch) branch = git(dir, ["rev-parse", "--short", "HEAD"]) ?? "(no commits)";

  const status = git(dir, ["status", "--porcelain=v2", "--branch"]) ?? "";
  let ahead = 0;
  let behind = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  // porcelain v2 entry prefixes: "1" changed, "2" renamed/copied, "u" unmerged, "?" untracked.
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) modified++;
    else if (line.startsWith("u ")) conflicts++;
    else if (line.startsWith("? ")) untracked++;
  }

  return {
    repo,
    worktree: isLinkedWorktree ? basename(toplevel) : undefined,
    branch,
    detached,
    modified,
    untracked,
    conflicts,
    ahead,
    behind,
  };
}
