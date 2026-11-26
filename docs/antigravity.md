# Antigravity connection (fork)

This fork adds an **Antigravity** connection: LearnHarness can run the models of your Google Antigravity plan (Gemini, plus the Claude and GPT models your plan includes) with your Google account instead of an API key.

It works the way [T3 Code](https://github.com/pingdotgg/t3code) does. LearnHarness drives the **official, unmodified Antigravity CLI** (`agy`) through its Agent Client Protocol server, `agy acp`. agy signs in through Google's own flow and keeps the credentials, in a profile only LearnHarness uses. LearnHarness never reads, stores or forwards Google tokens. Use it for your own learning, with your own account.

## Set up

1. Open **Settings → Providers → Antigravity → Connect**.
2. If agy is not installed, select **Install Antigravity**. LearnHarness downloads Google's official runtime (about 250 MB) for this computer into its own folder, checks it against the SHA-512 Google publishes, and only then uses it. An agy you installed yourself is found too (see [Executable](#what-agy-gets)).
3. Select **Sign in with Google**, then **Open Google sign-in**. Sign in in your browser. Google's last page shows a code: paste it (or that page's whole address) into the dialog and select **Submit**. The dialog loads your plan and models on its own.
4. Choose Antigravity models for your model slots, for example Gemini 4 Neon for *Strong* and Gemini 3.8 Flash for *Cheap*.

The dialog shows the signed-in account and plan, the agy version and your models, and the **Allow background use** switch: with it off, helper agents and automatic follow-ups never use your plan. **Switch account** signs in again; **Sign out** runs agy's own sign-out for this profile.

Usage appears as "Antigravity" in cost displays, without dollar amounts, because it counts toward your Google plan rather than an API bill. The connection never falls back to an API key.

### Models

Every model your account offers appears, except **Orchestrator**: it pairs a planner with an executor for coding work, so it is left out. Thinking levels are agy's own (low, medium, high and, on some models, xhigh or max) and map one to one onto LearnHarness's. A model without levels thinks at its fixed budget. Context windows are the ones agy reports for each model.

## How it works

LearnHarness's agent loop (pi-agent-core) asks for one model response at a time and runs tools itself. agy runs a whole conversation and calls tools over MCP. The bridge (`src/agent/antigravity/`) joins the two, the same way the Claude connection does ([claude.md](claude.md)):

- **One agy process per conversation.** Each session is an `agy acp` process running LearnHarness's own agent: `--agent learnharness`, defined with no built-in tools (`tools: []`), so agy's file, terminal, web and subagent tools are not available. LearnHarness's system prompt is appended to it (`_meta.antigravity.systemPrompt.append`).
- **LearnHarness tools over MCP.** The session's tools are the agent's own (quiz, research, visual, …), served with their exact JSON schemas by an MCP server on `127.0.0.1`, one endpoint and bearer token per session. agy declares them to the model directly (`eager`) and calls them as `mcp_lh_<tool>`. When a call reaches the endpoint, the bridge ends the response there with a tool call; the agent loop runs the tool, and on its next request the bridge returns the result to the waiting call.
- **Only LearnHarness's tools run.** agy asks permission before each tool call. The bridge allows calls to LearnHarness's tools and refuses everything else.
- **Questions wait for the learner.** A posed question ends the agent's turn while the call stays open in agy (no tool timeout). The learner's graded answer then arrives as that call's result.
- **Matching by transcript.** As in the Claude bridge: each request carries the full transcript, matched to a live session that has seen a prefix of it, so only what is new is sent.
  - **Model and thinking-level changes** apply in place.
  - **Prompt or tool changes** (for example the hand-off from prober to teacher) resume the same agy session in a new process.
- **Resume after a restart.** agy keeps each conversation in the profile. After an app restart or a session closed for being idle, the bridge resumes it (`session/resume`). Results of calls that were open when it paused are delivered as text.
- **Replay when history changed.** When the transcript no longer matches any session (for example after compaction rewrote it), a fresh session starts and receives the conversation as text.
- **Clean shutdown.** When the desktop app quits, open agy turns are cancelled before the server stops, so agy records them as interrupted.
- **Images** go both ways natively: the learner's images in prompts, and images in tool results.
- **Usage.** agy reports the conversation's size after each model call and the turn's token totals when the turn ends. A response that ends at a tool call carries its calls' sizes; the turn's last response carries the rest of the totals.

At most six sessions are live at once. A session waiting for the learner closes after 3 idle hours, and any other session after 10 idle minutes. A closed session is resumed later when needed. One-shot plugin calls release their process right away.

Starting agy is never part of a fast path. The last check is cached (`state.json`), so the model list is ready when the app starts. agy runs to check again only on **Check again**, when the dialog opens, after sign-in and after an install.

### Why the MCP server is in the profile's config

agy only honors `timeoutSeconds` for servers in its config files. A server passed over ACP is cut off after 3 minutes, which would break a question the learner takes longer to answer. Workspace configs load only after the first prompt starts, too late for the first turn. So the bridge writes the session's server into the profile's own `config/mcp_config.json` (with `timeoutSeconds: -1`), which agy reads once when `authenticate` signs it in. Processes start one at a time: each waits until the previous one has signed in and connected to its endpoint before the file is rewritten.

### What agy gets

- **Environment:** LearnHarness removes its own provider API keys, every `LH_*` and `AGY_*` variable (including the desktop API secret), and Google keys or projects (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_*`, …), so agy uses its own sign-in. It sets:
  - `GEMINI_HOME` and `--gemini-dir` to the LearnHarness profile, and `--app-data-dir antigravity-acp`;
  - `AGY_ACP_FORCE_FILE_STORAGE=1` and `SSH_CONNECTION`, so agy 1.5 keeps this profile's sign-in in the profile rather than the system keyring entry it shares with your own agy, and signs in with a pasted code;
  - `AGY_CLI_DISABLE_AUTO_UPDATE=true` (LearnHarness updates the runtime it downloaded);
  - `TEMP`/`TMP` (`TMPDIR` elsewhere) to a folder per process, removed when it exits.
- **Executable:** found in this order:
  1. `LH_ANTIGRAVITY_PATH`, if set;
  2. the runtime LearnHarness downloaded;
  3. the official installer's location (`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows, `~/.local/bin/agy` elsewhere);
  4. `PATH`.

  agy 1.5.1 or newer is required.
- **Managed runtime:** Google's update manifest names the version, download and SHA-512 for each platform (Windows, macOS and Linux, x64 and ARM64, glibc and musl). The download must be Google's file in `storage.googleapis.com/antigravity-public/antigravity-cli/` for this platform and match the hash. It is activated whole; the previous version stays until the new one is complete. When Google publishes a newer version, the dialog offers **Update**. **Remove downloaded runtime** deletes it and keeps your sign-in.

### Files

| Path | Contents |
| --- | --- |
| `<data>/antigravity/profile/` | agy's profile (`GEMINI_HOME`): its sign-in, settings, logs and conversations |
| `<data>/antigravity/profile/config/agents/learnharness/agent.md` | The agent LearnHarness runs (no built-in tools) |
| `<data>/antigravity/profile/config/mcp_config.json` | The MCP server of the process that started last |
| `<data>/antigravity/runtime/` | The runtime LearnHarness downloaded (`current.json` names the active version) |
| `<data>/antigravity/workspace/` | agy's working folder for these sessions (empty) |
| `<data>/antigravity/settings.json` | Background-use consent |
| `<data>/antigravity/state.json` | The last check: version, plan, models. No credentials. |
| `<data>/antigravity/sessions.json` | Which agy session holds which conversation prefix, for resume. No credentials. |

`<data>` is `%APPDATA%\LearnHarness\data` in the Windows app.

### Code map

| File | Role |
| --- | --- |
| `src/core/contracts/antigravity.ts` | Route id `antigravity`, status and controls |
| `src/agent/antigravity/environment.ts` | Paths, agy's environment, the agent definition, the MCP config |
| `src/agent/antigravity/executable.ts` | Finding agy, version checks |
| `src/agent/antigravity/release.ts` | Google's manifest, download, checksum, extraction, activation |
| `src/agent/antigravity/acp-client.ts` | JSON-RPC over stdio, one-at-a-time process start, handshake |
| `src/agent/antigravity/tool-bridge.ts` | The MCP server and its per-session endpoints |
| `src/agent/antigravity/connection.ts` | Status, cache, install, sign-in and sign-out, consent, admission scope |
| `src/agent/antigravity/catalog.ts` | The account's models as pi models |
| `src/agent/antigravity/session.ts` | Live sessions, permissions, pool, resume records, clean shutdown |
| `src/agent/antigravity/stream.ts` | The stream function: delivery, agy events → pi events, errors |
| `src/agent/antigravity/transcript.ts` | Fingerprints, ACP content, replay text (shared with the Claude bridge) |
| `src/agent/graceful-shutdown.ts` | Clean shutdown shared with the Claude connection |
| `src/server/antigravity-http.ts`, `app/api/antigravity/route.ts` | Status and controls endpoint |
| `components/settings/antigravity-connection.tsx` | Providers row, dialog, background-use button |
| `tests/antigravity-bridge.test.ts` | Offline tests with a scripted agy (`tests/fixtures/antigravity/fake-agy.mjs`) |
| `tests/antigravity-connection-ui.test.tsx` | The dialog's states and controls |

## Troubleshooting

- **"Antigravity is not installed"**: select **Install Antigravity**, or install agy yourself ([Google's guide](https://antigravity.google/docs/getting-started)) and select **Check again**. If it lives somewhere unusual, set `LH_ANTIGRAVITY_PATH` to the executable.
- **Sign-in does not finish**: make sure you pasted the code from Google's last page (or its whole address), within 10 minutes of starting. Then select **Check again**.
- **Plan limit reached**: switch the slot to another model or provider, or wait for your plan's limits to reset.
- **Anything else**: agy writes its logs to `<data>/antigravity/profile/antigravity-acp/log/`. The app's log is `%APPDATA%\LearnHarness\logs\main.log`.
