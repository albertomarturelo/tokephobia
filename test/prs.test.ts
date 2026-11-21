import assert from "node:assert/strict";
import { test } from "node:test";
import { isStale, summarizeChecks } from "../src/prs.ts";

test("CI summary: failure beats pending beats pass", () => {
  assert.equal(summarizeChecks([]), "none");
  assert.equal(summarizeChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]), "pass");
  assert.equal(
    summarizeChecks([
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
    ]),
    "pending",
  );
  assert.equal(
    summarizeChecks([
      { __typename: "CheckRun", status: "IN_PROGRESS" },
      { __typename: "StatusContext", state: "FAILURE" },
    ]),
    "fail",
  );
  assert.equal(summarizeChecks([{ __typename: "StatusContext", state: "PENDING" }]), "pending");
  assert.equal(summarizeChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), "pass");
});

test("open PRs refresh every minute, finished ones every 15", () => {
  const now = 10_000_000;
  assert.equal(isStale(undefined, now), true);
  assert.equal(isStale({ state: "OPEN", fetchedAt: now - 30_000 }, now), false);
  assert.equal(isStale({ state: "OPEN", fetchedAt: now - 61_000 }, now), true);
  assert.equal(isStale({ state: "MERGED", fetchedAt: now - 61_000 }, now), false);
});
