#!/usr/bin/env node
// Release helper. main is protected, so a release takes two steps:
//
//   npm run release -- bump <patch|minor|major|X.Y.Z>
//     On a branch: sets the version in package.json and package-lock.json.
//     Commit it and merge it through a PR like any other change.
//
//   npm run release -- publish [-m "summary"] [--notes-file FILE] [--draft] [--dry-run]
//     On main, after that merge: checks the tree is clean and level with
//     origin/main, runs typecheck and tests, then creates the annotated tag
//     vX.Y.Z on HEAD, pushes it and creates the GitHub release. Notes come
//     from FILE, or GitHub generates them from the merged PRs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current, spec) {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`current version "${current}" is not X.Y.Z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  let next;
  if (spec === "patch") next = `${major}.${minor}.${patch + 1}`;
  else if (spec === "minor") next = `${major}.${minor + 1}.0`;
  else if (spec === "major") next = `${major + 1}.0.0`;
  else if (SEMVER.test(spec)) next = spec;
  else throw new Error(`"${spec}" is not patch, minor, major or X.Y.Z`);
  if (compareVersions(next, current) <= 0) throw new Error(`${next} is not newer than ${current}`);
  return next;
}

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, spec: undefined, message: undefined, notesFile: undefined, draft: false, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "-m" || arg === "--message") opts.message = value();
    else if (arg === "--notes-file") opts.notesFile = value();
    else if (arg === "--draft") opts.draft = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (opts.spec === undefined) opts.spec = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (command === "bump" && !opts.spec) throw new Error("bump needs patch, minor, major or X.Y.Z");
  if (command === "publish" && opts.spec) throw new Error("publish takes the version from package.json");
  if (command !== "bump" && command !== "publish") throw new Error("usage: release bump <patch|minor|major|X.Y.Z> | release publish [-m summary] [--notes-file FILE] [--draft] [--dry-run]");
  return opts;
}

const run = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts }) ?? "").trim();
const git = (...args) => run("git", args);
const readVersion = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function bump(spec) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "main") throw new Error("main is protected: bump on a branch and merge it through a PR");
  const current = readVersion();
  const next = nextVersion(current, spec);
  run("npm", ["version", next, "--no-git-tag-version"], { stdio: "ignore" });
  console.log(`${current} → ${next} in package.json and package-lock.json.`);
  console.log(`Commit it, merge the PR, then on main: npm run release -- publish`);
}

function publish({ message, notesFile, draft, dryRun }) {
  const version = readVersion();
  const tag = `v${version}`;

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new Error(`publish runs on main (now on ${branch})`);
  if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("working tree has uncommitted changes");
  git("fetch", "--quiet", "--tags", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) throw new Error("main is not level with origin/main: pull first");
  if (git("tag", "--list", tag)) throw new Error(`${tag} already exists: bump the version first`);

  const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
  const previous = tags[0];
  if (previous && compareVersions(version, previous.slice(1)) <= 0) throw new Error(`${tag} is not newer than ${previous}`);
  if (previous && !git("log", "--oneline", `${previous}..HEAD`)) throw new Error(`nothing new since ${previous}`);
  if (notesFile) readFileSync(notesFile, "utf8"); // fail early if it is missing

  console.log("Typecheck and tests…");
  run("npm", ["run", "--silent", "typecheck"], { stdio: "inherit" });
  run("npm", ["test", "--silent"], { stdio: "inherit" });

  const tagMessage = message ? `${tag}: ${message}` : tag;
  const releaseArgs = ["release", "create", tag, "--verify-tag", "--title", tag];
  if (notesFile) releaseArgs.push("--notes-file", notesFile);
  else releaseArgs.push("--generate-notes", ...(previous ? ["--notes-start-tag", previous] : []));
  if (draft) releaseArgs.push("--draft");

  const steps = [
    ["git", ["tag", "--annotate", tag, "--message", tagMessage]],
    ["git", ["push", "origin", tag]],
    ["gh", releaseArgs],
  ];
  if (dryRun) {
    console.log(`Dry run, ${previous ?? "no previous tag"} → ${tag}. Would run:`);
    for (const [cmd, args] of steps) console.log(`  ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    return;
  }
  for (const [cmd, args] of steps) run(cmd, args, { stdio: "inherit" });
  console.log(`Released ${tag}.`);
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.command === "bump") bump(opts.spec);
    else publish(opts);
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exit(1);
  }
}
