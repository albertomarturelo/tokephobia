import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsageStale, mergeLimits, pickReport, reportLimits } from "../src/usage.ts";

const NOW = Date.parse("2026-11-22T12:00:00Z");

// Shape of a real `/api/oauth/usage` answer (trimmed).
const ANSWER = {
  five_hour: { utilization: 38, resets_at: "2026-11-22T14:00:00.1+00:00" },
  seven_day: { utilization: 56, resets_at: "2026-11-27T06:00:00.393355+00:00", limit_dollars: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 56, resets_at: "2026-11-27T06:00:00.39+00:00", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 41,
      severity: "normal",
      resets_at: "2026-11-27T06:00:00.39+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
};

test("report gives 5h, week and each model's week, in that order", () => {
  const report = pickReport(ANSWER)!;
  assert.deepEqual(
    reportLimits(report, NOW).map((l) => [l.label, l.usedPct]),
    [
      ["5h", 38],
      ["week", 56],
      ["Fable", 41],
    ],
  );
  assert.equal(reportLimits(report, NOW)[2]!.resetsAt, Date.parse("2026-11-27T06:00:00.39Z"));
});

test("only the fields tokephobia reads are kept", () => {
  const report = pickReport(ANSWER)!;
  assert.equal("extra_usage" in report, false);
  assert.deepEqual(Object.keys(report.seven_day!), ["utilization", "resets_at"]);
  assert.equal(pickReport("nope"), undefined);
});

test("a null 5h window, or one whose reset has passed, is left out", () => {
  assert.deepEqual(
    reportLimits(pickReport({ ...ANSWER, five_hour: null })!, NOW).map((l) => l.label),
    ["week", "Fable"],
  );
  const later = Date.parse("2026-11-22T15:00:00Z");
  assert.deepEqual(
    reportLimits(pickReport(ANSWER)!, later).map((l) => l.label),
    ["week", "Fable"],
  );
});

test("without limits[], the old per-model fields are read", () => {
  const report = pickReport({ seven_day: { utilization: 10 }, seven_day_sonnet: { utilization: 4 } })!;
  assert.deepEqual(
    reportLimits(report, NOW).map((l) => l.label),
    ["week", "Sonnet"],
  );
});

test("input windows win over the report's; the report adds what the input lacks", () => {
  const input = [{ label: "week", usedPct: 57, resetsAt: 1 }];
  const report = reportLimits(pickReport(ANSWER)!, NOW);
  const merged = mergeLimits(input, report);
  assert.deepEqual(
    merged.map((l) => [l.label, l.usedPct]),
    [
      ["5h", 38],
      ["week", 57],
      ["Fable", 41],
    ],
  );
  assert.deepEqual(mergeLimits(input, []), input);
});

test("the report refreshes every 3 minutes", () => {
  assert.equal(isUsageStale(undefined, NOW), true);
  assert.equal(isUsageStale({ checkedAt: NOW - 60_000 }, NOW), false);
  assert.equal(isUsageStale({ checkedAt: NOW - 4 * 60_000 }, NOW), true);
});
