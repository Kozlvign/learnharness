# Rigor: a demanding course, auditable (fork)

The tutor teaches like an olympiad coach or the best professor of a top university: demanding questions at the edge of what you hold, many connections, no gap left behind, and gentleness only while repairing. A teaching chat is a **course** that runs over many classes. Every rule has a code, the tutor records what it did in fields saved with each question, and `npm run audit:session` turns a chat into a report against the rules.

This came out of a review of a real session (Calculus, Stewart chapter 2): 92% of checks right, almost all at 100% confidence, one multiple-choice check per step, the same template over and over, no review after a night away, the textbook never used beyond its contents page. Two ideas that passed their check failed the next day.

## The rules

The doctrine lives in the teacher's prompt fragments (`src/agent/prompts/teacher/`), in English like the rest of the prompts, with the codes in parentheses. The tutor never shows the codes to the learner.

### C: the course (`06-course.md`)

| Code | Rule | Why |
|---|---|---|
| C1 | The chat is a course; the plan is its living syllabus, by units (the source's sections, or the subject's). | A subject is learned over weeks, not in one sitting. |
| C2 | The syllabus grows (accepted detours, discovered gaps) and shrinks (stretches the learner proves they hold), and the tutor says in one sentence what changed. | The plan is a hypothesis about the learner. |
| C3 | A class that starts after hours away opens with 2–4 retrieval questions, interleaved, weighted toward past misses and fragile ideas. | A check right after teaching measures what is active, not what is held. |
| C4 | A class ends with a balance: solid, fragile, next. | The learner leaves knowing where they stand. |
| C5 | A unit ends with exercises and a short cumulative exam (multi-step, free response); what the exam shows fragile goes back into the plan. | Integration is where gaps show. |
| C6 | Reaching the goal, the course can be extended in the same chat. | The course is the unit of study, not the session. |
| C7 | Every teaching turn ends with a question; never on an announcement. | The session stalled once, waiting for the learner to ask "are you preparing?". |

### E: demand (`22-demand.md`)

| Code | Rule | Why |
|---|---|---|
| E1 | Checks sit at the learner's edge: about 70–80% right on the first try. | 92% means the questions were below the edge. |
| E2 | Every question has a rung: 1 recognize, 2 same template, 3 transfer, 4 integrate, 5 justify or prove, 6 construct, break or solve with no method given. | A shared scale for difficulty, recorded on every check. |
| E3 | After a confident success the next question on that idea climbs a rung; never the same template twice in a row. | Six limits of the form (x²−a²)/(x−a) taught one shape, not limits. |
| E4 | Contrast cases and non-examples (the limit fails to exist, one-sided limits differ, f(a) differs from the limit). | An idea is held when its boundary is. |
| E5 | Compress what is already held: a rung-4 success skips the small steps it implies. | Seven easy distributivity questions in a row wasted time. |
| E6 | An idea counts as held only after a rung-3+ success with reasoning. | A confident multiple-choice pick at rung 1–2 is weak evidence. |
| E7 | A challenge (rung 4–6) before leaving each plan node. | The exam-level problem is the real check. |
| E8 | Gentle only in repair; then climb again at once with a new, harder variant. | Repair is the one place for small steps. |
| E9 | One meaning per symbol for the whole course. | "b" meant three things in one hour, and the learner's confusion came straight from it. |
| E10 | Multiple choice to discriminate, free response to produce; reasoning asked for on high-rung choices. | Producing an answer is stronger evidence than picking one. |

### L: gaps (`24-gaps.md`)

| Code | Rule | Why |
|---|---|---|
| L1 | No gap that could hinder progress passes, even under a right answer; it gets a permanent slug, a repair and a verification. | Gaps compound. |
| L2 | Strands the probe left untested are tested before the node that needs them. | An untested premise is neither a gap nor a proof. |
| L3 | A repeated miss changes the representation and looks one level down for the deeper gap. | Repeating the same explanation louder does not work. |
| L4 | Every repaired gap is re-checked later, with a new item: in the next class's review and in the unit's exam. | The verification right after a repair is the weakest one. |
| L5 | Visiting a node is not covering it: before leaving, check what the goal still needs from it. | "Algebra" was marked visited after monic trinomials only; section 2.3 needs conjugates, compound fractions and more. |

### R: connections, detours, new courses (`26-connections.md`)

| Code | Rule |
|---|---|
| R1 | Short connections (1–3 sentences) backward, forward and across fields, inside the teaching. |
| R2 | The learner is regularly asked to state a relation themselves. |
| R3 | A larger adjacent topic is offered, never imposed, at a natural pause: what it is, why now, what it strengthens, what it unlocks, its cost; explore, save or skip. One offer at a time; a skipped topic is not offered again. |
| R4 | A saved detour becomes an "Optional: …" node on the map, offered again at unit ends. |
| R5 | An explored detour is taught at full rigor and ends with the return to the course. |
| R6 | A gap is never offered as a detour. |
| R7 | A distant topic becomes the proposal of a separate course, with books verified by research; with the learner's yes and their PDFs, the tutor creates it. |

### S: sources (`46-sources.md`)

| Code | Rule |
|---|---|
| S1 | No source: everything in the app, problems written by the tutor; one mention that a book can be attached. |
| S2 | One source: the syllabus follows its sections, citations by section, page, example and figure; before each section, read first or go straight on (the learner's choice, and "always straight on" ends the offers). |
| S3 | The source's exercises, routine to hard, transcribed into the app with their reference. |
| S4 | Several sources: the goal's book is primary (order, notation); the others complement by topic, with the reason. |
| S5 | A book named without its file: ask once; never cite an unverified page or number. |
| S6 | Never assign reading the learner does not have; every citation comes from a file read or a PDF brief. |

### K: Anki (the `anki_card` tool's description)

| Code | Rule |
|---|---|
| K1 | A card for each central definition, theorem or relation, right after the learner answers a rung-3+ check on it correctly. **Settings → Anki → Cards for central concepts** (on by default); outside **Cards per session**; tag `LearnHarness::miss::concept`. |

The other fragments changed little: `10-planning.md` says the minimal tree is the course's spine, not its limit, and that teaching starts in the turn after the learner accepts the plan; `shared/20-question-tools.md` explains the mixed mechanic.

## What the app records

### Tags on every teach question

`quiz` and `explain` calls carry, besides `type` and `nodeId` (`src/core/question-core.ts`):

| Field | Values | Required |
|---|---|---|
| `intent` | `step`, `climb`, `challenge`, `repair`, `review`, `exam`, `exercise`, `detour` | always |
| `rung` | 1–6 | on checks |
| `gap` | a permanent lowercase slug | with `repair` |
| `source` | e.g. `Stewart 2.2 #31, p. 128` | on questions taken from the learner's material |

`intent` is required directly in the teacher's `quiz` and `explain` JSON Schemas (`teachQuizInputObject` / `teachExplainInputObject`), while display schemas and bare test registries keep it optional so old records stay valid. The teach tools' boundary (`teachTagProblems`) enforces the cross-field rules (`rung` on checks, `challenge` as `check` at rung 4–6, `repair` as `check` with a lowercase `gap` slug), and the model retries on any violation. The learner never sees these tags.

### Purposes on `ask_user_question`

`purpose` fixes the option values, so the decision can be read back (`askPurposeProblems`):

| Purpose | Values |
|---|---|
| `detour` | `explore`, `save`, `skip` |
| `reading` | `read-first`, `direct` |
| `course` | `create`, `skip` |

### Mixed quizzing (the default)

**Settings → Agent → Quizzing**: *Mixed* (new, the default), *Multiple choice*, *Free recall*. Stored as `agent.tools.explain`: absent = mixed, `false` = multiple choice, `true` = free recall, so an explicit earlier choice stays. In mixed mode the teacher carries `quiz` and `explain`, and the prober `probe` and `recall` (`quizMechanics` in `src/agent/tools.ts`).

### A new class

When the learner answers (a builtin or plugin question) or writes in a teaching chat 3 hours or more after the last activity, and probing has finished with at least one teacher reply after `probe_done`, `inputAppends` / `chat-handler` adds a `session-resume` marker (`sessionResumeFor` in `src/core/native-messages.ts`):

- after a text message's dismissal conclusion and before the message (skipping recent silent dismissals so dismissing a stale question before typing preserves the away gap); after an answer's result, and only for the last answer of a batch of sibling questions (results stay next to their calls);
- the model reads `[Session context] New class: the learner is back after 13 h away …`;
- the chat shows a quiet centered line, *New class · 13 h since the last activity*;
- the marker never changes what the record's tail means (`isSessionResumeMarker`, used by the continuation and dismissal checks).

Practice sessions get no marker.

### A new course

1. The tutor proposes it with `purpose: "course"`, books verified by `research`.
2. On `create`, it asks which books the learner has as files and checks the paths the learner gives.
3. It calls `create_course` (`src/agent/tools/create-course.ts`, teacher only, through the chat handler's extra tools).
4. The server (`src/server/courses.ts`):
   - refuses unless the learner's latest answer to a course proposal was `create` and no course was made from it yet (`courseConsentOf` in `src/core/course.ts`);
   - checks each file like the tutor's own reads (allowed folders, sensitive locations) and that it is readable, all or nothing;
   - creates the chat with the strong slot's model;
   - writes a `course-seed` marker as its first message (goal, origin, what the learner holds, books with their files);
   - files the chat in the root folder *Suggested courses* (in the interface language: *Cadeiras sugeridas*), reusing an existing localized folder if the interface language changed.
5. The new chat shows the note as a *Proposed course* card (expanded before the first turn, with a link back to the origin course and a *Start course* invitation; collapsed once turns begin). The proposing chat shows *New course created* with an **Open** link.

## The audit report

```text
npm run audit:session -- <chat id | path to the chat's .json> [--data <dir>] [--out <file>] [--no-transcript]
```

A chat id is looked up in `<data>/chats/<id>.json`, where `<data>` is `--data`, then `LH_DATA_DIR`, then the desktop app's data folder (`%APPDATA%\LearnHarness\data` on Windows), then the repository's `data/`. The report is Markdown in Portuguese. The fold is `src/core/teaching-audit.ts`; the command is `scripts/audit-session.ts`.

| Section | Rules | What it shows |
|---|---|---|
| Alertas por regra | all | every flag, with its message index |
| Aulas | C3 | each class's start, the gap before it, whether a marker recorded it, its questions, the intents it opened with |
| Acerto por degrau | E1 | first-try success on multiple-choice checks and predictions, by rung and by class |
| Formato e raciocínio | E10 | multiple choice vs free response, written reasoning, confident successes |
| Intenções | E2–E8 | count per intent |
| Lacunas | L1, L3, L4 | per gap slug: the class it appeared in, misses, repairs, questions, and whether it was re-checked in a later class |
| Partes do plano | E7, L5 | per node: questions, the highest rung answered right, challenge, exercises, exams |
| Fontes | S2, S3 | questions with a source reference; readings offered and chosen |
| Desvios e novas cadeiras | R3, R4, R7 | detours offered and answers, optional nodes on the map, course proposals and courses created |
| Anki | K1 | the tutor's cards by reason |
| Mudanças do plano | C2 | each `plan_init`, nodes added and removed |
| Transcrição | — | the tutor's prose, each question with its tags, options and committed answer, and the learner's answers and reasoning |

Flags raised automatically: C3 (a class that did not open with review), C7 (a teaching turn that ended without a question; pre-teaching plan presentation/revision is excluded, and a closing balance after "I'm stopping" is a legitimate exception), E3 (no climb after a confident success within the same class), E7 (a node left without a challenge), E8 (a missed check not followed by repair), L4 (a repaired gap never re-checked in a later class once a later class exists).

Flags are review leads, not verdicts on teaching quality. C7 needs transcript review to distinguish a stall from an authorized closing balance. E3 compares recorded rungs (except at the ceiling of 6); it cannot determine whether two problems use the same template. The tutor supplies the tags, so their semantic accuracy also needs review. Free-response grading lives in the tutor's prose: an answer alone never counts as a successful delayed gap verification. The transcript preserves the questions' details, committed answers and explanations for that review. Rejected question calls are shown in the transcript but excluded from question metrics.

Chats from before the tags still get everything that does not depend on them. Classes are inferred from 3-hour gaps, and the rest reads *sem dado*.

## Files

| File | Role |
|---|---|
| `src/agent/prompts/teacher/06-course.md`, `22-demand.md`, `24-gaps.md`, `26-connections.md`, `46-sources.md` | The doctrine |
| `src/core/question-core.ts` | Tags, purposes and their checks |
| `src/agent/tools.ts` | Mixed mechanic, tag checks at the teach tools' boundary |
| `components/settings/agent-section.tsx` | The three-way Quizzing control |
| `src/core/native-messages.ts`, `src/core/input-events.ts`, `src/core/view.ts`, `components/chat.tsx` | The new-class marker |
| `src/core/course.ts`, `src/agent/tools/create-course.ts`, `src/server/courses.ts`, `components/course-cards.tsx` | New courses |
| `src/core/anki/*`, `src/agent/tools/anki-card.ts`, `src/server/anki/tutor.ts`, `components/anki/*` | Concept cards |
| `src/core/teaching-audit.ts`, `scripts/audit-session.ts` | The audit |
| `tests/rigor.test.ts` | Tests for all of the above |
