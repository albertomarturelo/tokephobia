// `tokephobia install` / `tokephobia uninstall`: registers or removes the status
// line in Claude Code's user settings. Every other key in the file is preserved,
// and any previous status line is backed up before being replaced.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 24;

interface StatusLineSetting {
  type: "command";
  command: string;
  padding?: number;
}

export function defaultSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

/**
 * Uses `node` from PATH rather than process.execPath: package managers put the
 * version in the real path (e.g. Homebrew's Cellar/node/26.13.0_2), which would
 * break on the next upgrade.
 */
export function statusLineCommand(binPath = fileURLToPath(new URL("../bin/tokephobia.mjs", import.meta.url))): string {
  return `node ${shellQuote(resolve(binPath))}`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  const data: unknown = JSON.parse(raw); // throws on invalid JSON: never overwrite a file we can't parse
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return data as Record<string, unknown>;
}

function writeSettings(file: string, data: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export const PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

/**
 * Where tokephobia used to ship its GitHub plugin (now claude-gh). Older
 * installs added it to CLAUDE_CODE_PLUGIN_DIRS; install and uninstall take it out.
 */
export function legacyPluginDir(): string {
  return fileURLToPath(new URL("../plugin", import.meta.url));
}

export interface Target {
  command: string;
  /** An entry to take out of CLAUDE_CODE_PLUGIN_DIRS: the old plugin folder. */
  legacyPluginDir?: string;
}

export interface InstallResult {
  changed: boolean;
  statusLineChanged: boolean;
  /** The old plugin folder was taken out of CLAUDE_CODE_PLUGIN_DIRS. */
  pluginRemoved: boolean;
  backup?: string;
}

function pluginDirs(settings: Record<string, unknown>): string[] {
  const env = settings.env as Record<string, unknown> | undefined;
  const raw = env?.[PLUGIN_DIRS_ENV];
  return typeof raw === "string" ? raw.split(delimiter).filter(Boolean) : [];
}

function setPluginDirs(settings: Record<string, unknown>, dirs: string[]): void {
  const env = { ...((settings.env as Record<string, unknown> | undefined) ?? {}) };
  if (dirs.length) env[PLUGIN_DIRS_ENV] = dirs.join(delimiter);
  else delete env[PLUGIN_DIRS_ENV];
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
}

/** Takes `dir` out of CLAUDE_CODE_PLUGIN_DIRS, leaving other entries; says whether it was there. */
function dropPluginDir(settings: Record<string, unknown>, dir: string | undefined): boolean {
  if (!dir) return false;
  const dirs = pluginDirs(settings);
  const kept = dirs.filter((d) => d !== dir);
  if (kept.length === dirs.length) return false;
  setPluginDirs(settings, kept);
  return true;
}

const isOurs = (command: unknown) => String(command ?? "").includes("tokephobia");

export function install(file: string, target: Target, now = new Date()): InstallResult {
  const settings = readSettings(file);
  const previous = settings.statusLine as StatusLineSetting | undefined;
  const statusLineChanged = !(previous?.type === "command" && previous.command === target.command);
  const pluginRemoved = dropPluginDir(settings, target.legacyPluginDir);
  if (!statusLineChanged && !pluginRemoved) return { changed: false, statusLineChanged, pluginRemoved };

  // Back up only when replacing someone else's status line, not a previous tokephobia install.
  let backup: string | undefined;
  if (statusLineChanged && previous && !isOurs(previous.command) && existsSync(file)) {
    backup = `${file}.bak-tokephobia-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  if (statusLineChanged) settings.statusLine = { type: "command", command: target.command, padding: 0 } satisfies StatusLineSetting;
  writeSettings(file, settings);
  return { changed: true, statusLineChanged, pluginRemoved, backup };
}

export function uninstall(file: string, legacyPlugin?: string): { removed: boolean; pluginRemoved: boolean; reason?: string } {
  const settings = readSettings(file);
  const current = settings.statusLine as StatusLineSetting | undefined;
  const removesStatusLine = Boolean(current && isOurs(current.command));
  const pluginRemoved = dropPluginDir(settings, legacyPlugin);

  if (!removesStatusLine && !pluginRemoved) {
    return {
      removed: false,
      pluginRemoved,
      reason: current ? `the current statusLine is not tokephobia (${current.command}); leaving it alone` : "tokephobia is not installed",
    };
  }
  if (removesStatusLine) delete settings.statusLine;
  writeSettings(file, settings);
  return { removed: true, pluginRemoved };
}

export function main(args: string[]): number {
  const [cmd, ...rest] = args;
  const i = rest.indexOf("--settings");
  const file = i >= 0 && rest[i + 1] ? resolve(rest[i + 1]!) : defaultSettingsPath();

  try {
    if (cmd === "install") {
      const major = Number(process.versions.node.split(".")[0]);
      if (major < MIN_NODE_MAJOR) {
        console.error(`tokephobia needs Node ${MIN_NODE_MAJOR}+ (you have ${process.versions.node}).`);
        return 1;
      }
      const command = statusLineCommand();
      const r = install(file, { command, legacyPluginDir: legacyPluginDir() });
      if (!r.changed) console.log(`tokephobia was already installed in ${file}`);
      if (r.statusLineChanged) console.log(`✓ statusLine → ${command}`);
      if (r.backup) console.log(`  previous statusLine backed up to ${r.backup}`);
      if (r.pluginRemoved) console.log(`✓ removed the old GitHub plugin from ${PLUGIN_DIRS_ENV} (it is now claude-gh)`);
      if (r.changed) {
        console.log(`  in ${file}`);
        if (r.statusLineChanged) console.log("  Open sessions pick up the status line on their next refresh.");
      }
      return 0;
    }
    if (cmd === "uninstall") {
      const r = uninstall(file, legacyPluginDir());
      console.log(r.removed ? `✓ tokephobia removed from ${file}` : `Nothing to do: ${r.reason}`);
      if (r.pluginRemoved) console.log(`  also removed the old GitHub plugin from ${PLUGIN_DIRS_ENV}`);
      return r.removed ? 0 : 1;
    }
  } catch (err) {
    console.error(`tokephobia ${cmd}: ${(err as Error).message}`);
    return 1;
  }
  const usage = "usage: tokephobia [install | uninstall] [--settings <path>]";
  if (cmd === "help" || cmd === "--help") {
    console.log(usage);
    return 0;
  }
  console.error(usage);
  return 1;
}
