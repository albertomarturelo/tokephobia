import type { ContextInfo } from "./context.ts";
import type { GitInfo } from "./git.ts";
import { formatReset, type LimitInfo } from "./limits.ts";

export interface ModelInfo {
  name: string;
  effort?: string;
  fast?: boolean;
  thinking?: boolean;
}

export interface RenderModel {
  dir?: string;
  model?: ModelInfo;
  git?: GitInfo;
  context?: ContextInfo;
  limits?: LimitInfo[];
}

const color = (code: string) => (s: string) => (process.env.NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const dim = color("2");
const green = color("38;5;114");
const yellow = color("38;5;221");
const red = color("38;5;203");
const blue = color("38;5;117");
const purple = color("38;5;147");

export function render(m: RenderModel): string {
  const lines: string[] = [];

  // Line 1: where am I — repo, worktree, branch.
  const where: string[] = [];
  if (m.git) {
    const g = m.git;
    where.push(blue(g.worktree ? `🌳 ${g.repo} ⟶ wt:${g.worktree}` : `📁 ${g.repo}`));
    let branch = `⎇ ${g.detached ? dim(g.branch + " (detached)") : green(g.branch)}`;
    if (g.conflicts) branch += red(` ✖${g.conflicts}`);
    if (g.modified) branch += yellow(` ✎${g.modified}`);
    if (g.untracked) branch += dim(` ?${g.untracked}`);
    if (g.ahead) branch += ` ↑${g.ahead}`;
    if (g.behind) branch += ` ↓${g.behind}`;
    where.push(branch);
  } else if (m.dir) {
    where.push(blue(`📁 ${m.dir.replace(process.env.HOME ?? "", "~")}`));
  }
  if (m.model) where.push(renderModel(m.model));
  lines.push(where.join("  "));

  // Line 2: context remaining, then plan usage limits.
  const budget: string[] = [];
  if (m.context) {
    const c = m.context;
    const pct = Math.round(c.remainingPct);
    const paint = pct <= 20 ? red : pct <= 40 ? yellow : green;
    budget.push(`🧠 ${paint(`${bar(pct)} ${pct}% left`)}${c.fresh ? dim(" · new session") : ""}`);
  }
  const limits = m.limits ?? [];
  if (limits.length) {
    const week = limits.find((l) => l.label === "week")?.resetsAt;
    const parts = limits.map((l) =>
      // A model's week usually resets with the overall week: say it once.
      renderLimit(l, l.label !== "week" && l.label !== "5h" && sameMinute(l.resetsAt, week)),
    );
    budget.push(`📅 ${parts.join("   ")}`);
  }
  if (budget.length) lines.push(budget.join("   "));

  return lines.join("\n") + "\n";
}

function renderLimit(l: LimitInfo, hideReset = false): string {
  const used = Math.round(l.usedPct);
  const paint = used >= 90 ? red : used >= 75 ? yellow : (s: string) => s;
  const reset = l.resetsAt && !hideReset ? dim(` · reset ${formatReset(l.resetsAt)}`) : "";
  return `${l.label} ${paint(`${used}%`)}${reset}`;
}

function sameMinute(a?: number, b?: number): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) < 60_000;
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function renderModel(model: ModelInfo): string {
  let out = purple(`🤖 ${model.name}`);
  if (model.effort) {
    const idx = EFFORT_LEVELS.indexOf(model.effort);
    // Unknown levels still show their name, just without the gauge.
    const gauge = idx >= 0 ? " " + "●".repeat(idx + 1) + dim("○".repeat(EFFORT_LEVELS.length - idx - 1)) : "";
    out += ` ${dim("·")} ${model.effort}${gauge}`;
  }
  if (model.fast) out += yellow(" ⚡fast");
  if (model.thinking === false) out += dim(" (no thinking)");
  return out;
}

function bar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
