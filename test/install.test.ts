import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { install, PLUGIN_DIRS_ENV, statusLineCommand, uninstall } from "../src/install.ts";

const dir = mkdtempSync(join(tmpdir(), "tokephobia-install-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const CMD = "node /x/bin/tokephobia.mjs";
const PLUGIN = "/x/plugin";

test("install keeps other settings and backs up a foreign status line", () => {
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ model: "opus", statusLine: { type: "command", command: "~/.claude/statusline.sh" } }));
  const r = install(file, { command: CMD }, new Date("2026-11-21T20:00:00Z"));

  assert.equal(r.changed, true);
  assert.ok(r.backup && existsSync(r.backup));
  assert.equal(read(r.backup!).statusLine.command, "~/.claude/statusline.sh");
  assert.deepEqual(read(file), { model: "opus", statusLine: { type: "command", command: CMD, padding: 0 } });

  // Idempotent: a second install changes nothing and makes no new backup.
  assert.equal(install(file, { command: CMD }).changed, false);
});

test("reinstalling over a tokephobia status line makes no backup", () => {
  const file = join(dir, "reinstall.json");
  writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: "node /old/tokephobia/bin/tokephobia.mjs" } }));
  const r = install(file, { command: CMD });
  assert.equal(r.statusLineChanged, true);
  assert.equal(r.backup, undefined);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith("reinstall.json.bak")).length, 0);
});

test("install takes the old plugin dir out of CLAUDE_CODE_PLUGIN_DIRS, keeping other dirs and env", () => {
  const file = join(dir, "plugin.json");
  writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: CMD }, env: { FOO: "1", [PLUGIN_DIRS_ENV]: ["/other/plugin", PLUGIN].join(delimiter) } }));
  const r = install(file, { command: CMD, legacyPluginDir: PLUGIN });
  assert.deepEqual([r.changed, r.statusLineChanged, r.pluginRemoved], [true, false, true]);
  assert.deepEqual(read(file).env, { FOO: "1", [PLUGIN_DIRS_ENV]: "/other/plugin" });

  const again = install(file, { command: CMD, legacyPluginDir: PLUGIN });
  assert.deepEqual([again.changed, again.pluginRemoved], [false, false]);
});

test("install never adds a plugin dir", () => {
  const file = join(dir, "fresh.json");
  const r = install(file, { command: CMD, legacyPluginDir: PLUGIN });
  assert.equal(r.backup, undefined);
  assert.equal(r.pluginRemoved, false);
  assert.deepEqual(read(file), { statusLine: { type: "command", command: CMD, padding: 0 } });
});

test("invalid JSON is never overwritten", () => {
  const file = join(dir, "broken.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => install(file, { command: "node x" }));
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("uninstall removes tokephobia's status line and the old plugin dir, nothing else", () => {
  const file = join(dir, "uninstall.json");
  writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: CMD }, env: { [PLUGIN_DIRS_ENV]: ["/other/plugin", PLUGIN].join(delimiter) } }));
  const r = uninstall(file, PLUGIN);
  assert.deepEqual([r.removed, r.pluginRemoved], [true, true]);
  assert.equal(read(file).statusLine, undefined);
  assert.deepEqual(read(file).env, { [PLUGIN_DIRS_ENV]: "/other/plugin" });
});

test("uninstall leaves a foreign status line alone", () => {
  const file = join(dir, "foreign.json");
  writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: "~/other.sh" } }));
  assert.equal(uninstall(file, PLUGIN).removed, false);
  assert.ok(read(file).statusLine);
});

test("an env block emptied by the migration is removed", () => {
  const file = join(dir, "empty-env.json");
  writeFileSync(file, JSON.stringify({ env: { [PLUGIN_DIRS_ENV]: PLUGIN } }));
  install(file, { command: CMD, legacyPluginDir: PLUGIN });
  assert.equal(read(file).env, undefined);
});

test("command quotes paths with spaces", () => {
  assert.equal(statusLineCommand("/a b/bin/tokephobia.mjs"), "node '/a b/bin/tokephobia.mjs'");
  assert.equal(statusLineCommand("/ab/bin/tokephobia.mjs"), "node /ab/bin/tokephobia.mjs");
});
