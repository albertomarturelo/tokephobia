import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: plain .mjs script without type declarations
import { compareVersions, nextVersion, parseArgs } from "../scripts/release.mjs";

test("nextVersion bumps each part and resets the lower ones", () => {
  assert.equal(nextVersion("0.2.3", "patch"), "0.2.4");
  assert.equal(nextVersion("0.2.3", "minor"), "0.3.0");
  assert.equal(nextVersion("0.2.3", "major"), "1.0.0");
  assert.equal(nextVersion("0.2.3", "0.10.0"), "0.10.0");
});

test("nextVersion refuses versions that are not newer or not X.Y.Z", () => {
  assert.throws(() => nextVersion("0.2.0", "0.2.0"), /not newer/);
  assert.throws(() => nextVersion("0.2.0", "0.1.9"), /not newer/);
  assert.throws(() => nextVersion("0.2.0", "v0.3.0"), /is not patch/);
  assert.throws(() => nextVersion("0.2.0-beta", "patch"), /not X.Y.Z/);
});

test("compareVersions compares numerically, not as strings", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("parseArgs reads bump and publish", () => {
  assert.equal(parseArgs(["bump", "minor"]).spec, "minor");
  const p = parseArgs(["publish", "-m", "short summary", "--notes-file", "notes.md", "--draft", "--dry-run"]);
  assert.deepEqual(
    { message: p.message, notesFile: p.notesFile, draft: p.draft, dryRun: p.dryRun },
    { message: "short summary", notesFile: "notes.md", draft: true, dryRun: true },
  );
});

test("parseArgs rejects bad input", () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["bump"]), /needs/);
  assert.throws(() => parseArgs(["publish", "0.3.0"]), /package.json/);
  assert.throws(() => parseArgs(["publish", "--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["publish", "-m"]), /needs a value/);
});
