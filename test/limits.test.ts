import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReset, readLimits } from "../src/limits.ts";

test("reads windows shortest-first and converts reset to ms", () => {
  const limits = readLimits({
    rate_limits: {
      seven_day: { used_percentage: 48, resets_at: 1795759200 },
      five_hour: { used_percentage: 91.4 },
      other_window: {},
    },
  });
  assert.deepEqual(limits, [
    { label: "5h", usedPct: 91.4, resetsAt: undefined },
    { label: "week", usedPct: 48, resetsAt: 1795759200_000 },
  ]);
});

test("no rate_limits: nothing to show", () => {
  assert.deepEqual(readLimits({}), []);
});

test("reset within a day is relative, later ones show weekday and time", () => {
  const now = Date.UTC(2026, 10, 21, 12, 0);
  assert.equal(formatReset(now + 40 * 60_000, now), "in 40m");
  assert.equal(formatReset(now + 3 * 3600_000, now), "in 3h");
  assert.equal(formatReset(now + (5 * 60 + 20) * 60_000, now), "in 5h 20m");
  assert.equal(formatReset(now - 1, now), "now");
  assert.match(formatReset(now + 3 * 86_400_000, now), /^\p{L}{2,4} \d{2}:\d{2}$/u);
});
