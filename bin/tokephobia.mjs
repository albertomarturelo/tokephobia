#!/usr/bin/env node
// Entry point.
//   tokephobia                     status line mode (Claude Code pipes JSON on stdin)
//   tokephobia install|uninstall   register/remove it in Claude Code settings
//
// Enables Node's on-disk compile cache before loading the TypeScript sources so
// repeated status line renders skip re-parsing them.
import module from "node:module";

module.enableCompileCache?.();

const cmd = process.argv[2];
if (cmd === "install" || cmd === "uninstall" || cmd === "help" || cmd === "--help") {
  const { main } = await import("../src/install.ts");
  process.exitCode = main(process.argv.slice(2));
} else {
  await import("../src/index.ts");
}
