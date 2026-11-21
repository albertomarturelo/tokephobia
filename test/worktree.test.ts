import assert from "node:assert/strict";
import { test } from "node:test";
import { pickActiveWorktree } from "../src/worktree.ts";

const wts = ["/p/repo", "/p/repo-12", "/p/repo-agent"];

test("most recent path inside a worktree wins", () => {
  assert.equal(pickActiveWorktree(["/p/repo-12/a.ts", "/p/repo-agent/b.ts", "/tmp/x"], wts), "/p/repo-agent");
});

test("main checkout does not swallow sibling worktrees with a shared prefix", () => {
  assert.equal(pickActiveWorktree(["/p/repo-12/src/x.ts"], wts), "/p/repo-12");
});

test("going back to the main checkout is detected", () => {
  assert.equal(pickActiveWorktree(["/p/repo-12/x", "/p/repo/README.md"], wts), "/p/repo");
});

test("no path inside any worktree: undefined", () => {
  assert.equal(pickActiveWorktree(["/tmp/a", "/Users/me/.claude/x"], wts), undefined);
});
