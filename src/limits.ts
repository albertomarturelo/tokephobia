// Plan usage limits (subscription windows) reported in `rate_limits`.

import type { StatusLineInput } from "./input.ts";

export interface LimitInfo {
  label: string;
  usedPct: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
}

const LABELS: Record<string, string> = { five_hour: "5h", seven_day: "week" };
// Shortest window first: it is the one most likely to stop you.
const ORDER = ["five_hour", "seven_day"];

export function readLimits(input: StatusLineInput): LimitInfo[] {
  const windows = input.rate_limits;
  if (!windows || typeof windows !== "object") return [];
  const keys = Object.keys(windows).sort((a, b) => rank(a) - rank(b));
  const out: LimitInfo[] = [];
  for (const key of keys) {
    const w = windows[key];
    if (typeof w?.used_percentage !== "number") continue;
    out.push({
      label: LABELS[key] ?? key.replace(/_/g, " "),
      usedPct: Math.min(100, Math.max(0, w.used_percentage)),
      resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : undefined,
    });
  }
  return out;
}

function rank(key: string): number {
  const i = ORDER.indexOf(key);
  return i < 0 ? ORDER.length : i;
}

/** "in 3h 20m" within a day, otherwise local weekday + time ("Fri 19:00"). */
export function formatReset(resetsAt: number, now = Date.now()): string {
  const diff = resetsAt - now;
  if (diff <= 0) return "now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const d = new Date(resetsAt);
  const weekday = new Intl.DateTimeFormat("en", { weekday: "short" }).format(d);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${weekday} ${time}`;
}
