#!/usr/bin/env node
// Entry point: Claude Code runs this on every status line refresh, piping the
// session JSON on stdin. Must stay fast and must never throw — any failure
// degrades to fewer segments, never to an empty or broken line.

import { cachePath, readJson, safeKey, writeJson } from "./cache.ts";
import { readContext } from "./context.ts";
import { readGitInfo } from "./git.ts";
import { launchDir, parseInput, type StatusLineInput } from "./input.ts";
import { readLimits } from "./limits.ts";
import { render } from "./render.ts";
import { scanTranscript, type TranscriptState } from "./transcript.ts";
import { cachedUsageLimits, mergeLimits } from "./usage.ts";
import { listWorktrees, pickActiveWorktree } from "./worktree.ts";

function readSession(input: StatusLineInput): TranscriptState | undefined {
  if (!input.session_id || !input.transcript_path) return undefined;
  const file = cachePath("sessions", `${safeKey(input.session_id)}.json`);
  const prev = readJson<TranscriptState>(file);
  const state = scanTranscript(prev, input.transcript_path);
  if (state.offset !== prev?.offset) writeJson(file, state);
  return state;
}

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const input = parseInput(Buffer.concat(chunks).toString("utf8"));
    const launch = launchDir(input);
    const session = readSession(input);

    // The session may be working in a sibling worktree it created; launch dir is only the fallback.
    const workDir = (launch && session && pickActiveWorktree(session.recentPaths, listWorktrees(launch))) || launch;
    // rate_limits only comes on a claude.ai subscription: only then is there a usage report to read.
    const limits = input.rate_limits ? mergeLimits(readLimits(input), cachedUsageLimits()) : readLimits(input);

    process.stdout.write(
      render({
        dir: workDir,
        model: input.model?.display_name
          ? {
              name: input.model.display_name,
              effort: input.effort?.level,
              fast: input.fast_mode,
              thinking: input.thinking?.enabled,
            }
          : undefined,
        git: workDir ? readGitInfo(workDir) : undefined,
        context: readContext(input),
        limits,
      }),
    );
  } catch (err) {
    process.stdout.write(`tokephobia: ${(err as Error).message}\n`);
  }
});
