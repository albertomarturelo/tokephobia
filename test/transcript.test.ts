import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanTranscript, workingPathsFromCommand, workingPathsFromToolCall } from "../src/transcript.ts";

const dir = mkdtempSync(join(tmpdir(), "tokephobia-tx-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: unknown) => JSON.stringify(o) + "\n";
const toolUse = (input: Record<string, unknown>, cwd = "/p/repo") =>
  line({ type: "assistant", cwd, message: { content: [{ type: "tool_use", name: "Bash", input }] } });

test("cd chains resolve relative to the previous cd, not the launch dir", () => {
  assert.deepEqual(
    workingPathsFromCommand("cd /p/repo && git worktree add -b x ../repo-12 origin/main && cd ../repo-12 && ls", "/elsewhere"),
    ["/p/repo", "/p/repo-12", "/p/repo-12"],
  );
});

test("git -C and worktree add options are understood", () => {
  assert.deepEqual(workingPathsFromCommand("git -C ../repo-9 status", "/p/repo"), ["/p/repo-9"]);
  assert.deepEqual(workingPathsFromCommand("git worktree add -q -B feat/x --reason why ../repo-3 main", "/p/repo"), ["/p/repo-3"]);
});

test("reading or listing files elsewhere is not a working-location signal", () => {
  // The live regression: cd into the worktree, then read a file from the main checkout.
  assert.deepEqual(
    workingPathsFromCommand("cd /p/repo-12 && node bin/x.mjs < /p/repo/fixtures/a.json && cat /p/repo/README.md && ls ../other", "/p/repo"),
    ["/p/repo-12"],
  );
  assert.deepEqual(workingPathsFromToolCall("Read", { file_path: "/p/repo/a.ts" }, "/p/repo"), []);
  assert.deepEqual(workingPathsFromToolCall("Grep", { path: "/p/repo" }, "/p/repo"), []);
});

test("edits and writes count, relative paths from other tools don't", () => {
  assert.deepEqual(workingPathsFromToolCall("Edit", { file_path: "/p/repo-12/a.ts" }, "/p/repo"), ["/p/repo-12/a.ts"]);
  assert.deepEqual(workingPathsFromToolCall("Write", { file_path: "/p/repo-12/b.ts" }, "/p/repo"), ["/p/repo-12/b.ts"]);
  assert.deepEqual(workingPathsFromToolCall("DesignSync", { path: "project/canvas.json" }, "/p/repo"), []);
});

test("cd targets with globs or variables are ignored", () => {
  assert.deepEqual(workingPathsFromCommand("cd $HOME/x && cd /p/*/y", "/p"), []);
});

test("collects tool paths and PRs, marks created ones, and resumes from the offset", () => {
  const file = join(dir, "s1.jsonl");
  writeFileSync(
    file,
    toolUse({ command: "git worktree add ../repo-7 && cd ../repo-7" }) +
      line({ type: "pr-link", prNumber: 41, prUrl: "https://github.com/acme/repo/pull/41", prRepository: "acme/repo" }) +
      line({ type: "user", toolUseResult: { gitOperation: { pr: { number: 42, url: "https://github.com/acme/repo/pull/42", action: "created" } } } }) +
      line({ type: "pr-link", prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42", prRepository: "acme/repo" }),
  );
  const s1 = scanTranscript(undefined, file);
  assert.equal(s1.recentPaths.at(-1), "/p/repo-7");
  assert.deepEqual(
    s1.prs.map((p) => [p.number, p.created]),
    [
      [41, false],
      [42, true],
    ],
  );

  // Append a partial line: must not be consumed until it is complete.
  const editLine = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/p/repo/src/a.ts" } }] } });
  appendFileSync(file, editLine.slice(0, 20));
  const s2 = scanTranscript(s1, file);
  assert.equal(s2.offset, s1.offset);

  appendFileSync(file, editLine.slice(20));
  const s3 = scanTranscript(s2, file);
  assert.equal(s3.recentPaths.at(-1), "/p/repo/src/a.ts");
  assert.equal(s3.prs.length, 2);
});

test("truncated transcript resets the state", () => {
  const file = join(dir, "s2.jsonl");
  writeFileSync(file, toolUse({ command: "cd /p/a" }) + toolUse({ command: "cd /p/b" }));
  const s1 = scanTranscript(undefined, file);
  writeFileSync(file, toolUse({ command: "cd /p/c" }));
  assert.deepEqual(scanTranscript(s1, file).recentPaths, ["/p/c"]);
});

test("cd inside heredocs, strings and test names is not a real cd", () => {
  const cmd = [
    "cd /p/repo-12 && python3 - <<'PY'",
    "s = 'cd /p/elsewhere && git -C /p/other status'",
    'test("cd chains resolve relative")',
    "PY",
    'git commit -m "fix: cd into /p/nope; then cd ../x"',
  ].join("\n");
  assert.deepEqual(workingPathsFromCommand(cmd, "/p/repo"), ["/p/repo-12"]);
});

test("quoted paths without spaces still work, and git global options are skipped", () => {
  assert.deepEqual(workingPathsFromCommand('cd "/p/repo-7" && git -c core.x=1 -C ../repo-8 worktree add -b f ../repo-9', "/p/repo"), [
    "/p/repo-7",
    "/p/repo-8",
    "/p/repo-9",
  ]);
});

test("env assignments before a command are ignored", () => {
  assert.deepEqual(workingPathsFromCommand("FOO=1 cd /p/repo-5", "/p"), ["/p/repo-5"]);
});
