# Installing tokephobia (for AI agents)

These are step-by-step instructions for a coding agent such as Claude Code. Follow them in order. Each step says what to run, what success looks like, and what to do if it fails. Don't edit `settings.json` by hand: `tokephobia install` does it safely.

## What gets installed

- **Status line:** `statusLine` in the Claude Code user settings runs `node <clone>/bin/tokephobia.mjs`.

It points into the clone, so the clone must stay where you put it. The default location is `~/.local/share/tokephobia`.

## 1. Check the requirements

```sh
node --version     # needs v24 or later
git --version
```

| If | Then |
|---|---|
| `node` is missing or older than v24 | Stop. Ask the user to install Node 24+ (for example `brew install node`). Don't install it yourself without asking. |

## 2. Get the code

```sh
DEST="$HOME/.local/share/tokephobia"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
else
  mkdir -p "$(dirname "$DEST")" && git clone https://github.com/albertomarturelo/tokephobia.git "$DEST"
fi
```

- **Success:** `$DEST/bin/tokephobia.mjs` exists.
- **Runtime dependencies:** there are none. Don't run `npm install`; it only adds dev tools.

## 3. Install

```sh
node "$HOME/.local/share/tokephobia/bin/tokephobia.mjs" install
```

On success it prints lines like these:

```
✓ statusLine → node /Users/you/.local/share/tokephobia/bin/tokephobia.mjs
  previous statusLine backed up to /Users/you/.claude/settings.json.bak-tokephobia-2026-11-21T20-00-00-000Z
  in /Users/you/.claude/settings.json
```

- **"tokephobia was already installed":** also success; running it again changes nothing.
- **"backed up":** the user had another status line. Tell them where the backup is.
- **"removed the old GitHub plugin":** an earlier install had added tokephobia's GitHub plugin; it moved to [claude-gh](https://github.com/albertomarturelo/claude-gh). Tell the user they can install that if they want the session's PRs above the prompt.
- **Other config locations:** it writes to `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, otherwise to `~/.claude/settings.json`. Use `--settings <path>` for another file, for example a project's `.claude/settings.json`.
- **Errors:** if it fails with a JSON error, the settings file is invalid. It is never overwritten in that case; show the error to the user.

## 4. Verify

Render the status line once, the way Claude Code does:

```sh
cd "$HOME/.local/share/tokephobia" && printf '{"cwd":"%s","model":{"display_name":"Opus 5.5"},"context_window":{"context_window_size":1000000,"used_percentage":20}}' "$PWD" | node bin/tokephobia.mjs
```

It should print two lines:

```
📁 tokephobia  ⎇ main  🤖 Opus 5.5
🧠 ▰▰▰▰▰▰▰▰▱▱ 80% left
```

Then check the settings:

```sh
node -e 'const s=require(process.argv[1]);console.log(s.statusLine?.command)' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
```

It should mention `tokephobia`.

## 5. Tell the user

- **Status line:** open sessions show it on their next refresh.
- **GitHub:** for this session's PRs above the prompt, they can install [claude-gh](https://github.com/albertomarturelo/claude-gh).

## Update

```sh
git -C "$HOME/.local/share/tokephobia" pull --ff-only
```

No reinstall is needed; the settings already point into the clone.

## Uninstall

```sh
node "$HOME/.local/share/tokephobia/bin/tokephobia.mjs" uninstall
```

It removes only tokephobia's status line (and the old plugin entry, if an earlier install left one). To bring back a previous status line, copy its `statusLine` block from the `settings.json.bak-tokephobia-*` backup. The clone can then be deleted.
