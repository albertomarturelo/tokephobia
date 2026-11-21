// Small JSON cache under ~/.cache/tokephobia (or $TOKEPHOBIA_CACHE_DIR).
// Several sessions render in parallel, so writes are atomic (tmp + rename).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cacheDir(): string {
  if (process.env.TOKEPHOBIA_CACHE_DIR) return process.env.TOKEPHOBIA_CACHE_DIR;
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tokephobia");
}

export function cachePath(...parts: string[]): string {
  return join(cacheDir(), ...parts);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

/** Filesystem-safe key for ids that may contain slashes or odd characters. */
export function safeKey(s: string): string {
  return s.replace(/[^\w.-]/g, "_");
}
