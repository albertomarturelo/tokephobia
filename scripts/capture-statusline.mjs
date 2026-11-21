#!/usr/bin/env node
// Temporary status line: records the raw JSON that Claude Code sends on stdin
// so tokephobia is built against real payloads instead of guessed fields.
//
// Per session it keeps:
//   <session>.first.json   – first payload seen (start-of-session state)
//   <session>.latest.json  – most recent payload
// and appends each distinct session/cwd/worktree combination to variants.jsonl.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "captures");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  try {
    mkdirSync(outDir, { recursive: true });

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      writeFileSync(join(outDir, `invalid-${Date.now()}.txt`), raw);
      process.stdout.write("📸 tokephobia capture: payload is not valid JSON\n");
      return;
    }

    const sid = String(data.session_id ?? "unknown").replace(/[^\w-]/g, "_");
    const pretty = JSON.stringify(data, null, 2) + "\n";
    const firstFile = join(outDir, `${sid}.first.json`);
    if (!existsSync(firstFile)) writeFileSync(firstFile, pretty);
    writeFileSync(join(outDir, `${sid}.latest.json`), pretty);

    const variantKey = JSON.stringify([sid, data.cwd, data.workspace?.current_dir, data.worktree ?? null]);
    const seenFile = join(outDir, ".seen-variants");
    const seen = existsSync(seenFile) ? readFileSync(seenFile, "utf8").split("\n") : [];
    if (!seen.includes(variantKey)) {
      appendFileSync(seenFile, variantKey + "\n");
      appendFileSync(join(outDir, "variants.jsonl"), JSON.stringify({ captured_at: new Date().toISOString(), ...data }) + "\n");
    }

    const sessions = readdirSync(outDir).filter((f) => f.endsWith(".first.json")).length;
    const dir = data.workspace?.current_dir ?? data.cwd ?? "?";
    process.stdout.write(`📸 tokephobia capture · ${sessions} session(s) · ${dir}\n`);
  } catch (err) {
    process.stdout.write(`📸 tokephobia capture error: ${err.message}\n`);
  }
});
