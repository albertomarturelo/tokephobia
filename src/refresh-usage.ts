#!/usr/bin/env node
// Detached background job: fetches claude.ai's usage report with Claude Code's
// OAuth token and writes the usage cache. Spawned by usage.ts; never runs on
// the rendering path. The token is read here, sent only to api.anthropic.com,
// and never written anywhere.

import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readJson, writeJson } from "./cache.ts";
import { pickReport, type UsageCache, usageFile, usageLock } from "./usage.ts";

const run = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?skip_spend=1";

interface OAuthCredentials {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}

/** Claude Code keeps its claude.ai login in the macOS Keychain, elsewhere in `~/.claude/.credentials.json`. */
async function readToken(): Promise<string | undefined> {
  let raw: string | undefined;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        timeout: 5_000,
      });
      raw = stdout;
    } catch {
      // Not in the Keychain: fall through to the file.
    }
  }
  if (!raw) {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    try {
      raw = readFileSync(join(dir, ".credentials.json"), "utf8");
    } catch {
      return undefined;
    }
  }
  try {
    const oauth = (JSON.parse(raw) as OAuthCredentials).claudeAiOauth;
    if (!oauth?.accessToken) return undefined;
    // Expired: Claude Code refreshes it on its next request; try again then.
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) return undefined;
    return oauth.accessToken;
  } catch {
    return undefined;
  }
}

async function refresh(): Promise<void> {
  const file = usageFile();
  let cache: UsageCache;
  try {
    const token = await readToken();
    if (!token) throw new Error("no token");
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "tokephobia",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const report = pickReport(await res.json());
    if (!report) throw new Error("unexpected answer");
    cache = { checkedAt: Date.now(), reportAt: Date.now(), report };
  } catch {
    // Keep the last good report (it ages out on its own) and back off for one TTL.
    const prev = readJson<UsageCache>(file);
    cache = { report: prev?.report, reportAt: prev?.reportAt, checkedAt: Date.now(), error: true };
  }
  writeJson(file, cache);
  rmSync(usageLock(), { force: true });
}

await refresh();
