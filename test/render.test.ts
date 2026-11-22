import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NO_COLOR = "1";
const { render } = await import("../src/render.ts");

test("model segment shows name, effort gauge and fast mode", () => {
  const out = render({ model: { name: "Opus 5.5", effort: "high", fast: true, thinking: true } });
  assert.match(out, /🤖 Opus 5\.5 · high ●●●○○ ⚡fast/);
  assert.doesNotMatch(out, /no thinking/);
});

test("unknown effort level shows the name without a gauge", () => {
  const out = render({ model: { name: "Fable 5.2", effort: "turbo" } });
  assert.match(out, /🤖 Fable 5\.2 · turbo\n/);
});

test("model without effort info shows just the name", () => {
  const out = render({ model: { name: "Opus 5.5", thinking: false } });
  assert.match(out, /🤖 Opus 5\.5 \(no thinking\)/);
});

test("plan usage: one calendar, 5h first, a model's week drops the reset it shares", () => {
  const now = Date.now();
  const week = now + 3 * 86_400_000;
  const out = render({
    limits: [
      { label: "5h", usedPct: 38, resetsAt: now + 2 * 3600_000 + 10_000 },
      { label: "week", usedPct: 56, resetsAt: week },
      { label: "Fable", usedPct: 91, resetsAt: week + 200 },
    ],
  });
  assert.match(out, /^\n?📅 5h 38% · reset in 2h   week 56% · reset \S+ \d\d:\d\d   Fable 91%\n$/u);
  assert.equal(out.match(/📅/g)?.length, 1);
});
