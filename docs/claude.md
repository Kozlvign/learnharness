# Claude connection (fork)

This fork adds a **Claude** connection: LearnHarness can run Claude models (Opus, Sonnet, Haiku, Fable) on your Claude Pro or Max plan instead of an API key.

It works the way [T3 Code](https://github.com/pingdotgg/t3code) does. LearnHarness drives the **official, unmodified Claude Code** installed on your computer, through Anthropic's [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Claude Code signs in through Anthropic's own flow and keeps the credentials. LearnHarness never reads, stores or forwards Claude tokens. Anthropic's [usage policy for Claude Code](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) allows signing in to the unmodified Claude Code binary with your own subscription. It forbids apps that collect Claude.ai credentials or route requests through other people's plans, and this connection does neither. Use it for your own learning, with your own account.

## Set up

1. Install Claude Code: on Windows run `irm https://claude.ai/install.ps1 | iex` in PowerShell, on macOS or Linux run `curl -fsSL https://claude.ai/install.sh | bash`. See [the setup guide](https://code.claude.com/docs/en/setup).
2. In LearnHarness, open **Settings → Providers → Claude → Connect**. If Claude Code is not signed in, select **Sign in**. A terminal opens with `claude auth login`, and Claude Code finishes sign-in in your browser. The dialog updates on its own.
3. Choose Claude models for your model slots, for example Claude Opus for *Strong* and Claude Sonnet for *Cheap* and *Vision*.

The dialog shows the signed-in account and plan, and how much of your plan's 5-hour and weekly limits you have used so far. It also has the **Allow background use** switch: with it off, helper agents and automatic follow-ups never use your plan.

Usage appears as "Claude" in cost displays, without dollar amounts, because it counts toward your plan rather than an API bill. The connection never falls back to an API key. If Claude Code is signed in with an Anthropic Console account instead of a plan, the dialog says so, because that usage is billed to the Console account.

## Upstream's Claude Code option

Upstream LearnHarness 0.4.0 added its own way to use Claude Code: **Settings → Providers → External CLI → Claude Code**, off by default. It is a separate feature, and you don't need it for this connection.

| | This fork's connection | Upstream's option |
| --- | --- | --- |
| Where | Providers → Subscriptions → **Claude** | Providers → External CLI → **Claude Code** |
| Route id and models | `claude`: `claude:claude-opus`, `claude:claude-sonnet`, … | `claude-code`: `claude-code:opus`, `claude-code:sonnet`, `claude-code:haiku` |
| Code | `src/agent/claude/` | `src/agent/claude-code/`, unchanged by the fork |

Before fork 0.4.001, this connection used the id `claude-code`. Saved choices with the old id move to `claude` on their own, the first time the app reads them: the model slots and background-role choices in `settings.json`, each chat's model, its recorded responses and usage, and background jobs' usage. Only entries whose model id starts with `claude-` move, which the fork's ids always do and upstream's never do (`src/store/claude-migration.ts`).

## How it works

LearnHarness's agent loop (pi-agent-core) asks for one model response at a time and runs tools itself. Claude Code runs a whole conversation and calls tools over MCP. The bridge (`src/agent/claude/`) joins the two:

- **One Claude Code session per conversation.** Each session is a Claude Code process started with LearnHarness's system prompt (`systemPrompt` custom, `snapshot: false`). It has no built-in tools (`tools: []`) and none of your Claude Code settings, CLAUDE.md files, skills, hooks, plugins or MCP servers (`settingSources: []`, `skills: []`, `strictMcpConfig`). With `verbatimPrompts`, prompts go to Claude exactly as written, so `/commands` or `@paths` in what you type are never acted on.
- **LearnHarness tools over in-process MCP.** The session's only tools are the agent's own (quiz, research, visual, …), served by an in-process MCP server with their exact JSON schemas. When Claude calls one, the bridge ends the response there with a tool call. The agent loop runs the tool, and on its next request the bridge returns the result to the waiting call (matched by Claude Code's tool-use id).
- **Questions wait for the learner.** A posed question ends the agent's turn while the call stays open in Claude Code. The learner's graded answer then arrives as that call's result, exactly as LearnHarness models it.
- **Matching by transcript.** Each request carries the full transcript, and the bridge matches it to a live session that has seen a prefix of it. Messages are identified by role, timestamp and tool-call id, so the bridge only sends what is new.
  - **Prompt or effort changes** (for example the hand-off from prober to teacher) resume the same Claude session with the new options.
  - **Model switches** apply in place.
  - **Tool changes** are announced to Claude Code over MCP (`tools/list_changed`).
- **Resume after a restart.** Sessions are persisted by Claude Code. After an app restart, a session closed for being idle, or the computer sleeping, the bridge resumes the Claude session from disk. Results of calls that were open when it paused are delivered as text.
- **Replay when history changed.** When the transcript no longer matches any session (for example after compaction rewrote it), a fresh session starts and receives the conversation as text.
- **Clean shutdown.** When the desktop app quits, the server interrupts open Claude Code turns before stopping. Otherwise Claude Code would retry the open tool calls on its own.

At most six sessions are live at once. A session waiting for the learner closes after 3 idle hours, and any other session after 10 idle minutes. A closed session is resumed later when needed.

### What Claude Code gets

- **Environment:** LearnHarness removes its own provider API keys (including `ANTHROPIC_API_KEY`) and every `LH_*` variable, including the desktop API secret, so Claude Code uses its own sign-in. It also turns off claude.ai connectors and IDE auto-connect for these sessions, and raises the limit on MCP tool-output size so large research results arrive whole.
- **Working folder:** `<data>/claude-code/workspace`. Claude Code keeps its transcripts for that folder under `~/.claude/projects/`.
- **Executable:** found in this order:
  1. `LH_CLAUDE_CODE_PATH`, if set;
  2. the native installer's location (`~/.local/bin/claude.exe` on Windows; `~/.local/bin/claude`, `~/.claude/local/claude` or Homebrew paths elsewhere);
  3. `PATH`, resolving npm `.cmd` shims to the real binary.

  The Agent SDK's bundled copy of Claude Code is not shipped.

### Files

| Path | Contents |
| --- | --- |
| `<data>/claude-code/settings.json` | Background-use consent |
| `<data>/claude-code/sessions.json` | Which Claude session holds which conversation prefix, for resume. No credentials. |
| `<data>/claude-code/workspace/` | Claude Code's working folder for these sessions |

`<data>` is `%APPDATA%\LearnHarness\data` in the Windows app.

### Code map

| File | Role |
| --- | --- |
| `src/core/contracts/claude.ts` | Route id `claude`, status shape |
| `src/agent/claude/connection.ts` | Status probe (`claude --version`, `claude auth status`, SDK initialization without a model request), sign-in terminal, consent, plan usage, admission scope |
| `src/agent/claude/catalog.ts` | The account's models as pi models (`claude-opus`, `claude-sonnet`, …) |
| `src/agent/claude/session.ts` | Live sessions, MCP server, pool, resume records, clean shutdown |
| `src/agent/claude/stream.ts` | The stream function: delivery, Claude Code events → pi events, errors |
| `src/agent/claude/transcript.ts` | Fingerprints, content conversion, replay text |
| `src/server/claude-http.ts`, `app/api/claude/route.ts` | Status and controls endpoint |
| `components/settings/claude-connection.tsx` | Providers row, dialog, background-use button |
| `src/store/claude-migration.ts` | Moves saved models from the old id, called by the settings, chat and job stores |
| `tests/claude-bridge.test.ts` | Offline tests with a scripted Claude Code |
| `tests/claude-migration.test.ts` | The move from the old id |

## Troubleshooting

- **"Claude Code is not installed"**: install it (see above), then select **Check again**. If it lives somewhere unusual, set `LH_CLAUDE_CODE_PATH` to the executable.
- **"Not signed in" after signing in**: run `claude auth status` in a terminal. It should report `"loggedIn": true`. Then select **Check again**.
- **Plan limit reached**: the error message gives the reset time. Switch the slot to another provider or wait for the reset.
- **Anything else**: run `claude` in a terminal to confirm Claude Code itself works. The app's log is `%APPDATA%\LearnHarness\logs\main.log`.

## Maintaining the fork

`scripts/fork/release-windows.ps1` keeps the fork current:

1. It merges `upstream/main`, and stops without changing anything if the merge conflicts.
2. If nothing changed since the last fork release, it exits.
3. It translates new upstream interface text into Portuguese with your Claude Code and commits the catalog ([language.md](language.md)).
4. It builds and checks the app as upstream's release workflow does: type check, the bridge and language tests, `next build`, then the provider and server smoke tests.
5. It runs `electron-builder --win`, tags the commit, and publishes the installer, blockmap and `latest.yml` as a release of the fork. With `-Install` it also installs the build.

Installed copies update themselves from the fork's releases: `publish` in `electron-builder.yml` points at the fork. So an upstream release never replaces a fork build. Fork versions put the upstream version and a fork revision into the patch number: upstream `0.3.8`, revision 1 → `0.3.801`. The script applies them at build time with `-c.extraMetadata.version`, so `package.json` keeps upstream's version and merges stay clean.

Only one release runs at a time on the computer. Each run writes a log to `%LOCALAPPDATA%\LearnHarness-fork\logs`.

### Automatic updates

`scripts/fork/install-update-task.ps1` sets up this computer so the desktop icon always opens what is on the fork's `main`. Run it once from a checkout of `main`. It does three things:

1. **Build folder.** It clones the fork into `D:\Codes\Projects\learnharness-build`, a folder only the automation uses. Builds there never touch your own checkout: the branch you're on, uncommitted work and `node_modules` stay as they are.
2. **Scheduled task.** It registers a task that runs `scripts/fork/auto-update.ps1` from that folder every 5 minutes, with no window.
   - Each run fetches the fork and upstream. If neither has new commits, the run ends there.
   - Otherwise it runs the release script with `-Install`. A release is ready about 7 minutes after a change reaches `main`, and it is installed right away when the app is closed.
   - The outcome is saved in `%LOCALAPPDATA%\LearnHarness-fork\state.json`.
3. **Shortcuts.** It points the desktop's **LearnHarness** icon at the launcher, and **Atualizar LearnHarness (Claude)** in the Start menu at the build folder.
   - The launcher is a small program, `scripts/fork/launcher.cs`. `scripts/fork/build-launcher.ps1` compiles it with the C# compiler that ships with Windows, using the app's icon, into `%LOCALAPPDATA%\LearnHarness-fork\launcher\LearnHarness Launcher.exe`.
   - It is a program rather than a script because Kaspersky deletes shortcuts that start a hidden PowerShell.
   - After each update, the task recompiles it if `launcher.cs` changed.

The same commits are never built twice, even after a restart:

- `state.json` remembers the last commits handled, so the task only builds again when there are new commits.
- The release script also skips the build when the app hasn't changed since the last release.
- A failed update is not retried on its own. New commits retry it, and so does **Atualizar LearnHarness (Claude)**, which runs the task at once in a window.
- The only exception is a build cut short, for example when the computer turned off mid-build. That one runs again.

What the icon does when clicked:

- If the app is already open, the icon brings it forward.
- Otherwise it checks the fork's `main` on GitHub, which takes about a second. If `main` has moved since the last run, it starts the task at once.
- While a version builds, a small window shows the progress. **Open now** opens the installed version without waiting; closing the window cancels the click.
- If a version was built while the app was open, the icon installs it first, which takes a few seconds, and then opens the app.
- If the last update failed, the app opens and the window says why, with **View log**.

The launcher's window follows the app's interface language. If anything goes wrong in the launcher, it still opens the installed app. The installer keeps the desktop shortcut on updates (`KeepShortcuts`), so the icon stays on the launcher.

To undo the setup, run `install-update-task.ps1 -Remove`. It removes the task and the launcher and points the icon at the app again; the build folder stays.

Leave GitHub Actions off in the fork. Otherwise upstream's release workflow runs on every fork tag and fails, because fork tags don't match `package.json`. To check a branch, run CI by hand with `gh workflow run ci.yml --ref <branch>`.
