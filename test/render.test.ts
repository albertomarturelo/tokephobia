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
