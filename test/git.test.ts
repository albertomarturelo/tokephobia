import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readGitInfo } from "../src/git.ts";

let root: string;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokephobia-git-")));
  const main = join(root, "myrepo");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  sh(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(main, "worktree", "add", "-q", "-b", "feat/login", join(root, "wt-login"));
});

after(() => rmSync(root, { recursive: true, force: true }));

test("main checkout: repo + branch, no worktree", () => {
  const info = readGitInfo(join(root, "myrepo"));
  assert.equal(info?.repo, "myrepo");
  assert.equal(info?.branch, "main");
  assert.equal(info?.worktree, undefined);
});

test("linked worktree: reports main repo, worktree name and its own branch", () => {
  const wt = join(root, "wt-login");
  writeFileSync(join(wt, "a.txt"), "x");
  writeFileSync(join(wt, "b.txt"), "y");
  const info = readGitInfo(wt);
  assert.equal(info?.repo, "myrepo");
  assert.equal(info?.worktree, "wt-login");
  assert.equal(info?.branch, "feat/login");
  assert.equal(info?.untracked, 2);
  assert.equal(info?.modified, 0);
});

test("modified tracked files are counted apart from untracked ones", () => {
  const wt = join(root, "wt-login");
  sh(wt, "add", "a.txt");
  sh(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a");
  writeFileSync(join(wt, "a.txt"), "changed");
  const info = readGitInfo(wt);
  assert.equal(info?.modified, 1);
  assert.equal(info?.untracked, 1);
  assert.equal(info?.conflicts, 0);
});

test("not a repo: undefined", () => {
  assert.equal(readGitInfo(root), undefined);
});
