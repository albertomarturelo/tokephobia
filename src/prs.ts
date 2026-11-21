// PR status (state, draft, CI) for the session's PRs.
//
// Rendering never touches the network: it reads cached status files and, when
// one is missing or stale, spawns a detached `refresh-prs.ts` that calls `gh`
// and writes the cache for the next render. Per-PR lock files keep parallel
// sessions and fast re-renders from piling up duplicate `gh` calls.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cachePath, readJson, safeKey } from "./cache.ts";
import type { TranscriptPR } from "./transcript.ts";

export type Checks = "pass" | "fail" | "pending" | "none";

export interface PrStatus {
  state?: "OPEN" | "MERGED" | "CLOSED";
  draft?: boolean;
  checks?: Checks;
  /** Last refresh failed (gh missing, unauthenticated, offline); fields keep the last good values. */
  error?: boolean;
  fetchedAt: number;
}

export interface SessionPR extends TranscriptPR {
  status?: PrStatus;
}

const OPEN_TTL_MS = 60_000;
const DONE_TTL_MS = 15 * 60_000;
const LOCK_TTL_MS = 30_000;

export function statusFile(pr: Pick<TranscriptPR, "repo" | "number">): string {
  return cachePath("prs", `${safeKey(pr.repo)}__${pr.number}.json`);
}

export function lockFile(pr: Pick<TranscriptPR, "repo" | "number">): string {
  return statusFile(pr).replace(/\.json$/, ".lock");
}

export function withStatus(prs: readonly TranscriptPR[], now = Date.now()): SessionPR[] {
  const stale: TranscriptPR[] = [];
  const out = prs.map((pr) => {
    const status = readJson<PrStatus>(statusFile(pr));
    if (isStale(status, now)) stale.push(pr);
    return { ...pr, status };
  });
  if (stale.length) triggerRefresh(stale, now);
  return out;
}

export function isStale(status: PrStatus | undefined, now: number): boolean {
  if (!status) return true;
  const done = status.state === "MERGED" || status.state === "CLOSED";
  return now - status.fetchedAt > (done ? DONE_TTL_MS : OPEN_TTL_MS);
}

function triggerRefresh(prs: TranscriptPR[], now: number): void {
  const todo = prs.filter((pr) => {
    const lock = lockFile(pr);
    try {
      if (existsSync(lock) && now - statSync(lock).mtimeMs < LOCK_TTL_MS) return false;
      mkdirSync(cachePath("prs"), { recursive: true });
      writeFileSync(lock, String(process.pid));
      return true;
    } catch {
      return false;
    }
  });
  if (!todo.length) return;
  try {
    const script = fileURLToPath(new URL("./refresh-prs.ts", import.meta.url));
    const refs = todo.map((pr) => `${pr.repo}#${pr.number}`);
    spawn(process.execPath, [script, ...refs], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // No refresh this time; the locks expire on their own.
  }
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** Collapses gh's statusCheckRollup (CheckRun + StatusContext items) into one CI verdict. */
export function summarizeChecks(rollup: unknown): Checks {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup as Array<Record<string, unknown>>) {
    const conclusion = String(c.conclusion ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    if (FAILED_CONCLUSIONS.has(conclusion) || state === "FAILURE" || state === "ERROR") return "fail";
    if (status ? status !== "COMPLETED" : state === "PENDING" || state === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}
