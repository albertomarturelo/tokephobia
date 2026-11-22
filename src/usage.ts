// Plan usage from claude.ai's usage endpoint (`/api/oauth/usage`, what `/usage`
// shows). The status line input only carries `five_hour` and `seven_day`, and
// only once a response reported them; the per-model weekly windows (e.g.
// "Fable") are only in this report.
//
// Rendering never waits on the network: it reads the cached report and, when
// that is stale, spawns a detached `refresh-usage.ts` that fetches it with the
// session's OAuth token and writes the cache for the next render.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cachePath, readJson } from "./cache.ts";
import type { LimitInfo } from "./limits.ts";

export interface UsageWindow {
  utilization?: number | null;
  /** ISO 8601. */
  resets_at?: string | null;
}

export interface UsageLimitRow {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string } | null } | null;
}

/** The parts of the endpoint's answer tokephobia reads. */
export interface UsageReport {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  limits?: UsageLimitRow[] | null;
}

export interface UsageCache {
  /** Last attempt, successful or not: drives the refresh. */
  checkedAt: number;
  /** When `report` was fetched: drives whether it is still shown. */
  reportAt?: number;
  report?: UsageReport;
  error?: boolean;
}

export const USAGE_TTL_MS = 3 * 60_000;
const LOCK_TTL_MS = 30_000;
/** Older than this, the cached figures are no longer shown. */
const MAX_AGE_MS = 60 * 60_000;

export const usageFile = (): string => cachePath("usage.json");
export const usageLock = (): string => cachePath("usage.lock");

/** Keeps only the fields tokephobia reads, so the cache never holds anything else. */
export function pickReport(data: unknown): UsageReport | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const win = (v: unknown): UsageWindow | null => {
    if (!v || typeof v !== "object") return null;
    const w = v as Record<string, unknown>;
    return {
      utilization: typeof w.utilization === "number" ? w.utilization : null,
      resets_at: typeof w.resets_at === "string" ? w.resets_at : null,
    };
  };
  const limits = Array.isArray(d.limits)
    ? d.limits.flatMap((r): UsageLimitRow[] => {
        if (!r || typeof r !== "object") return [];
        const row = r as Record<string, any>;
        const name = row.scope?.model?.display_name;
        return [
          {
            kind: typeof row.kind === "string" ? row.kind : undefined,
            percent: typeof row.percent === "number" ? row.percent : undefined,
            resets_at: typeof row.resets_at === "string" ? row.resets_at : null,
            scope: typeof name === "string" ? { model: { display_name: name } } : null,
          },
        ];
      })
    : null;
  return {
    five_hour: win(d.five_hour),
    seven_day: win(d.seven_day),
    seven_day_opus: win(d.seven_day_opus),
    seven_day_sonnet: win(d.seven_day_sonnet),
    limits,
  };
}

/** The report's windows in display order: 5h, week, then each model's week. */
export function reportLimits(report: UsageReport, now = Date.now()): LimitInfo[] {
  const out: LimitInfo[] = [];
  const add = (label: string, pct: number | null | undefined, resets: string | null | undefined) => {
    if (typeof pct !== "number") return;
    const resetsAt = resets ? Date.parse(resets) : NaN;
    // A window whose reset has passed has started over; its figure is stale.
    if (Number.isFinite(resetsAt) && resetsAt <= now) return;
    out.push({
      label,
      usedPct: Math.min(100, Math.max(0, pct)),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
    });
  };
  add("5h", report.five_hour?.utilization, report.five_hour?.resets_at);
  add("week", report.seven_day?.utilization, report.seven_day?.resets_at);
  const scoped = (report.limits ?? []).filter((r) => r.kind === "weekly_scoped" && r.scope?.model?.display_name);
  if (scoped.length) {
    for (const r of scoped) add(r.scope!.model!.display_name!, r.percent, r.resets_at);
  } else {
    // Older answers had fixed per-model fields instead of `limits`.
    add("Opus", report.seven_day_opus?.utilization, report.seven_day_opus?.resets_at);
    add("Sonnet", report.seven_day_sonnet?.utilization, report.seven_day_sonnet?.resets_at);
  }
  return out;
}

/**
 * Merges the input's windows (fresh, from the last response's headers) with
 * the cached report: the input wins for the windows it has, the report adds
 * the rest (the 5h window when the input lacks it, and the per-model weeks).
 */
export function mergeLimits(fromInput: LimitInfo[], fromReport: LimitInfo[]): LimitInfo[] {
  const byLabel = new Map(fromInput.map((l) => [l.label, l]));
  const out = fromReport.map((l) => byLabel.get(l.label) ?? l);
  for (const l of fromInput) if (!out.includes(l)) out.push(l);
  const rank = (l: LimitInfo) => (l.label === "5h" ? 0 : l.label === "week" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function isUsageStale(cache: UsageCache | undefined, now: number): boolean {
  return !cache || typeof cache.checkedAt !== "number" || now - cache.checkedAt > USAGE_TTL_MS;
}

/** Cached report's windows (empty when missing or too old), refreshing it in the background when stale. */
export function cachedUsageLimits(now = Date.now()): LimitInfo[] {
  if (process.env.TOKEPHOBIA_NO_USAGE) return [];
  const cache = readJson<UsageCache>(usageFile());
  if (isUsageStale(cache, now)) triggerRefresh(now);
  if (!cache?.report || !cache.reportAt || now - cache.reportAt > MAX_AGE_MS) return [];
  return reportLimits(cache.report, now);
}

function triggerRefresh(now: number): void {
  const lock = usageLock();
  try {
    if (existsSync(lock) && now - statSync(lock).mtimeMs < LOCK_TTL_MS) return;
    mkdirSync(cachePath(), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const script = fileURLToPath(new URL("./refresh-usage.ts", import.meta.url));
    spawn(process.execPath, [script], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // No refresh this time; the lock expires on its own.
  }
}
