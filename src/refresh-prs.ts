#!/usr/bin/env node
// Detached background job: `node refresh-prs.ts owner/repo#12 owner/repo#34 ...`
// Fetches each PR's state and CI with `gh` and writes the status cache.
// Spawned by prs.ts; never runs on the rendering path.

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { readJson, writeJson } from "./cache.ts";
import { lockFile, type PrStatus, statusFile, summarizeChecks } from "./prs.ts";

const run = promisify(execFile);

async function refresh(ref: string): Promise<void> {
  const m = ref.match(/^(.+)#(\d+)$/);
  if (!m) return;
  const pr = { repo: m[1]!, number: Number(m[2]) };
  const file = statusFile(pr);
  let status: PrStatus;
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "state,isDraft,statusCheckRollup"],
      { timeout: 15_000 },
    );
    const data = JSON.parse(stdout);
    status = {
      state: data.state,
      draft: Boolean(data.isDraft),
      checks: summarizeChecks(data.statusCheckRollup),
      fetchedAt: Date.now(),
    };
  } catch {
    // Keep the last good values and back off for one TTL.
    status = { ...readJson<PrStatus>(file), error: true, fetchedAt: Date.now() };
  }
  writeJson(file, status);
  rmSync(lockFile(pr), { force: true });
}

await Promise.all(process.argv.slice(2).map(refresh));
