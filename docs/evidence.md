# Practice evidence (fork)

Click a proposition in the knowledge graph and its card shows a **Practice** section: what happened each time a practice problem exercised that idea. It is a record of events, not a grade. There are no scores, percentages, averages or colours, and the graph itself is unchanged.

```
Practice
Solved without help · Oct 20, 2026
Oct 20, 2026 · Solved
Oct 12, 2026 · Solved with hints · Hint R2 · Picked a similar idea · Retest
Oct 5, 2026 · Dismissed
```

- **The first line** describes the most recent practice session that worked on the idea: *Solved without help*, *Solved with help* or *Practiced, not solved yet*, with that session's date. An older success does not hide a later struggle; the full history is the list below it.
- **Each row** is one problem, newest first: the date, the outcome, the hint level it needed (R0–R5, the practice hint ladder), the type of miss, and *Retest* when the tutor marked it for one. *Target in context* means the session was started from this proposition alone, so which idea to use was given away. Clicking a row opens the session at that problem's conclusion.
- **Dismissed** problems are listed, but they count as no practice.
- The section is hidden for propositions never practiced.

Only practice sessions produce evidence. Teaching checks and probe questions are not linked to graph propositions: they belong to a session's plan, and in teaching the material is on screen by design.

To remove evidence, delete the practice session. Both deletion dialogs (one session, or sources and folders) say when the selection has practice results. Evidence cannot be edited.

## Asking before grading

Two prompt rules came with this feature. When the tutor cannot tell whether an answer is right, because it could be read two ways, a negation may flip it, or a term is used loosely, it asks what you meant before grading:

- free-recall answers in teaching and probing (`src/agent/prompts/shared/20-question-tools.md`);
- claimed answers in practice (`src/agent/prompts/practice/10-doctrine.md`, "On an unclear answer"). A clarification is not a hint and moves no rung.

## How it works

Nothing is stored. The practice `problem` and `conclude` calls are already in the chat records, so the evidence is a fold over them, recomputed on every read (`src/core/evidence.ts`). Old practice sessions are included. It reaches the card through `GET /api/evidence` (`src/server/evidence.ts`), which returns the propositions with practice items.

- **One item per concluded problem.** Calls count only when their result went through: errored calls, and the failed attempts that a retry leaves on disk, are skipped. A conclude closes the newest open problem. A dismissal is dated by its marker, and the synthetic conclude that follows only adds its id. Problems posed but never concluded give nothing.
- **Arguments are healed on read.** The record keeps the model's raw arguments, so string-encoded values are healed again (`src/core/argument-heal.ts`). Targets given as names resolve to ids, and targets no longer in the graph are dropped (`resolveTargetId`). Problems without targets give items attached to no proposition.
- **Independence.** An item is `independent` when it was solved (`solved` or `solvedWithHints`) at rung null or R0, and its target was not the session's only picked proposition. R0 only redirects attention. R1 already names a pattern, and R3 names the proposition. `movedOn`, `surrendered` and `dismissed` are never independent.
- **Target context.** `targetContext` compares the targets with the propositions picked when the session started (the context card, whose statements the learner can open at any time): `only-pick` gives the target away, `among-picks` leaves the choice open.
- **First contact and spacing.** The idea first reached the learner where it was born: `firstContact` is the proposition's first provenance source, a teaching session or imported notes, dated by the proposition's creation. Each practice item is a `review` (the first worked item of that proposition in its session) or `same-session` (a later one, such as a retest, which is not a new spaced review). Dismissals have no spacing.
- **Stages.** The card shows `solvedWithoutHelp`, `solvedWithHelp` and `practicedNotSolved`, computed over the most recent session with a worked item. `taughtNotPracticed`, `importedNotPracticed` and `noEvidence` exist in the data only.
- **Confidence fields.** `learnerConfidence` is reserved for the learner's own confidence and is always absent for now: practice has no confidence control. A grader's confidence is not recorded. If it ever is, it goes in a separate field named `graderConfidence`.

The format is meant to feed later work, such as spaced review, retrieval questions at the start of sessions and practice chosen from the evidence. None of the agents read it yet.

The card loads the whole index when the home page loads, so a node card opens at its final height (the card measures itself once to choose where it opens). Each opening refreshes the index in the background.

## Prior art

Several rules adapt ideas from [DeepTutor](https://github.com/HKUDS/DeepTutor) (Apache-2.0): attempts with help are kept apart from independent ones; the first contact opens the record, and repeats within one session do not count as new reviews; evidence is described by stage labels instead of scores; and when a free-text answer cannot be judged confidently, the learner is asked to clarify. The design and wording here are LearnHarness's own. No DeepTutor code or prompt text was copied.

Upstream files touched (small, marked "Fork"):

- `src/core/index.ts` and `src/server/index.ts`: exports.
- `components/graph-view.tsx`: the Practice section in the node card.
- `components/practice-cards.tsx`: link anchors on the problem and conclusion cards.
- `components/delete-session-dialog.tsx` and `components/delete-source-dialog.tsx`: the deletion notices.
- `src/agent/prompts/shared/20-question-tools.md` and `src/agent/prompts/practice/10-doctrine.md`: the two clarification rules (one new paragraph each).
