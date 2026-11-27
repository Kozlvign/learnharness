# Session titles chosen by the tutor (fork)

A new session is named after your first message, cut to fit the sidebar. Once the tutor knows what the session is about, it gives it a proper name: the subject, plus a short source when there is one, such as *Limites e Derivadas — Stewart Cap. 2* or *Árvores B e Índices*. It writes the name in your language, in 3–7 words and at most 72 characters.

- **When.** As soon as the subject is clear: after reading the files, PDFs or images you pointed to, or once your request is clear. It names the session before it concludes the probe, before the plan and before a practice session's first problem. It may refine the name when the plan is set or when the course grows (an extended goal, the next part of the book).
- **Where.** The new title shows at once in the header, the sidebar and the map, even while the tutor is still answering. The rename shows nothing in the conversation, and the tutor doesn't announce it.
- **Your title is yours.** Once you rename a session yourself (the header, the sidebar or the sources directory), the tutor no longer changes it. A course the tutor created with your agreement keeps the name you accepted. To have the tutor rename it again, ask in the chat ("call this session Cálculo I"); the name you ask for is then yours too.

Sessions from before this feature keep their title unless it is still the automatic one, the same text the first message gave it.

## How it works

- **Who set the title.** A chat record carries `titleSource`: `auto` (the first message, set by `POST /api/chats`), `agent` (the tutor) or `user` (a manual rename, a course from `create_course`, or a name the learner asked for). `effectiveTitleSource` (`src/core/session-title.ts`) reads records without the field: a course seed or a record with no learner message is `user`; otherwise the title is `auto` only when it equals what `titleFromPrompt` gives the first learner message (or "Image"/"Images" for an image-only start).
- **The tool.** `rename_session` (`src/agent/tools/session-title.ts`) is in every conversation agent's registry, outside the tool toggles. It refuses a `user` title unless `requestedByUser: true`, which also stamps the new name `user`; otherwise it stamps `agent`. Titles are one line of at most 72 characters (`validateSessionTitle`), so they are never cut with an ellipsis. The tool is sequential, so a batch that renames and then calls a milestone tool runs the rename first.
- **The gates.** While the title is `auto`, `probe_done`, `plan_init` and `problem` (native and plugin poses, through `admitPracticeProblem`) refuse and ask for `rename_session` first. The practice gate reads the record live, since a rename lands on it at once.
- **The prompt.** The shared fragment `src/agent/prompts/shared/38-session-title.md` holds the doctrine (it is also in practice's shared allowlist). Each agent's system prompt ends with a one-line `<session_title>` note: the current title and who set it. It changes only when the title does. The learner-language note lists session titles among what the learner reads.
- **The store and the events.** `renameChat(id, title, titleSource = "user")` keeps `updatedAt`, so the sidebar order never changes, and emits `chats-changed` and `chat-renamed` (`{ chatId, title }`). The header (`components/chat.tsx`), the sidebar row and the map's cluster labels listen to `chat-renamed`; the header also adopts the saved title on each record sync.
- **Silence.** `ToolPartRenderer` renders nothing for `rename_session` in any state, and the Markdown export skips its result. The teaching audit's transcript still lists the call.

Upstream files touched (small, marked "Fork"): `src/core/contracts/chat.ts`, `src/core/ports.ts`, `src/core/events.ts`, `src/store/chats.ts`, `app/api/chats/route.ts`, `src/server/courses.ts`, `src/agent/tools.ts`, `src/agent/tools/probe.ts`, `src/agent/tools/plan.ts`, `src/agent/tools/practice.ts`, `src/agent/teacher-agent.ts`, `src/agent/prompt-segments.ts`, `src/core/i18n/tutor.ts`, `src/core/session-markdown.ts`, `components/plugin-renderers.tsx`, `components/session-core.ts`, `components/chat.tsx`, `components/sidebar.tsx` and `components/graph-view.tsx`.

`tests/session-title.test.ts` covers the title source, the check and the note, the store's events, the tool, the gates (also in one batch with the rename) and the export.
