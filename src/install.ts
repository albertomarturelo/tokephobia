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

/** The plugin folder shipped next to this file (GitHub line and pane). */
export function defaultPluginDir(): string {
  return fileURLToPath(new URL("../plugin", import.meta.url));
}

export interface Target {
  command: string;
  /** Added to CLAUDE_CODE_PLUGIN_DIRS in the settings' env block; omit to skip the plugin. */
  pluginDir?: string;
}

export interface InstallResult {
  changed: boolean;
  statusLineChanged: boolean;
  pluginChanged: boolean;
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

const isOurs = (command: unknown) => String(command ?? "").includes("tokephobia");

export function install(file: string, target: Target, now = new Date()): InstallResult {
  const settings = readSettings(file);
  const previous = settings.statusLine as StatusLineSetting | undefined;
  const statusLineChanged = !(previous?.type === "command" && previous.command === target.command);

  const dirs = pluginDirs(settings);
  const pluginChanged = Boolean(target.pluginDir && !dirs.includes(target.pluginDir));
  if (!statusLineChanged && !pluginChanged) return { changed: false, statusLineChanged, pluginChanged };

  // Back up only when replacing someone else's status line, not a previous tokephobia install.
  let backup: string | undefined;
  if (statusLineChanged && previous && !isOurs(previous.command) && existsSync(file)) {
    backup = `${file}.bak-tokephobia-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  if (statusLineChanged) settings.statusLine = { type: "command", command: target.command, padding: 0 } satisfies StatusLineSetting;
  if (pluginChanged) setPluginDirs(settings, [...dirs, target.pluginDir!]);
  writeSettings(file, settings);
  return { changed: true, statusLineChanged, pluginChanged, backup };
}

export function uninstall(file: string, pluginDir?: string): { removed: boolean; reason?: string } {
  const settings = readSettings(file);
  const current = settings.statusLine as StatusLineSetting | undefined;
  const dirs = pluginDirs(settings);
  const keptDirs = pluginDir ? dirs.filter((d) => d !== pluginDir) : dirs;
  const removesStatusLine = Boolean(current && isOurs(current.command));
  const removesPlugin = keptDirs.length !== dirs.length;

  if (!removesStatusLine && !removesPlugin) {
    return {
      removed: false,
      reason: current ? `the current statusLine is not tokephobia (${current.command}); leaving it alone` : "tokephobia is not installed",
    };
  }
  if (removesStatusLine) delete settings.statusLine;
  if (removesPlugin) setPluginDirs(settings, keptDirs);
  writeSettings(file, settings);
  return { removed: true };
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
      const pluginDir = rest.includes("--no-plugin") ? undefined : defaultPluginDir();
      const r = install(file, { command, pluginDir });
      if (!r.changed) console.log(`tokephobia was already installed in ${file}`);
      if (r.statusLineChanged) console.log(`✓ statusLine → ${command}`);
      if (r.backup) console.log(`  previous statusLine backed up to ${r.backup}`);
      if (r.pluginChanged) console.log(`✓ plugin → ${PLUGIN_DIRS_ENV} += ${pluginDir}`);
      if (r.changed) {
        console.log(`  in ${file}`);
        if (r.statusLineChanged) console.log("  Open sessions pick up the status line on their next refresh.");
        if (r.pluginChanged) console.log("  The GitHub line and /gh load in sessions started from now on.");
      }
      return 0;
    }
    if (cmd === "uninstall") {
      const r = uninstall(file, defaultPluginDir());
      console.log(r.removed ? `✓ tokephobia removed from ${file}` : `Nothing to do: ${r.reason}`);
      return r.removed ? 0 : 1;
    }
  } catch (err) {
    console.error(`tokephobia ${cmd}: ${(err as Error).message}`);
    return 1;
  }
  const usage = "usage: tokephobia [install [--no-plugin] | uninstall] [--settings <path>]";
  if (cmd === "help" || cmd === "--help") {
    console.log(usage);
    return 0;
  }
  console.error(usage);
  return 1;
}
