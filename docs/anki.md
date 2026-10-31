# Anki cards from mistakes (fork)

LearnHarness can turn your mistakes into flashcards in your own [Anki](https://apps.ankiweb.net). Anki then schedules the reviews (with FSRS, if you turned it on there), and LearnHarness stays the place where you understand things. It is off by default, and it starts from the moment you turn it on: mistakes made before that never become cards.

A card is not a copy of the question. **The tutor writes it right after explaining the right idea**, in the same reply, and the card shows in the chat: a recall question on the front (never multiple choice), a short answer, why it is so, and the trap behind your answer. You can also ask the tutor for a card of anything ("make a card of this").

If the tutor leaves a mistake without a card, a small background model writes it instead, as a reserve, once the tutor has had two replies to do it. Mistakes made before the explanation (probe questions and predictions) wait until the lesson covers them; if it never does, they get no card.

## Set up

1. In Anki, install the **AnkiConnect** add-on: **Tools → Add-ons → Get Add-ons…**, code `2055492159`, then restart Anki.
2. In LearnHarness, open **Settings → Anki** and turn on **Create Anki cards from mistakes**. The status line should say **Connected to Anki**.

Anki must be open for cards to arrive. While it is closed, new cards wait in LearnHarness and go the next time it can reach Anki (after a lesson turn, when you open **Settings → Anki**, or with **Send now**).

## What becomes a card

| Mistake | Setting |
|---|---|
| A multiple-choice answer graded wrong (graded again on the server) | Wrong answers |
| A free-text answer the tutor's reply shows was wrong or partial (the writer judges it; right or unclear answers get no card) | Wrong answers |
| "I don't know" | "I don't know" |
| A right answer given with confidence at or below 30% | Lucky guesses |
| A practice problem the learner moved on from or gave up | Practice problems not solved |
| A practice problem solved only with a hint at rung R3 or above (the practice doctrine reads R3+ as "over the edge") | Practice problems solved only with strong hints |
| When you ask the tutor for a card of something | Always (not counted in **Cards per session**) |

Never: careless slips, skipped questions, and preference questions (`ask_user_question`).

The card's shape follows the practice miss type: a confusion between two similar ideas gets a contrast card, a misconception gets a card on the correct idea it contradicts, a misapplied step gets a card on that step, and "nothing came to mind" gets plain recall. A wrong answer given with confidence of 70% or more is tagged as a confident error: those are the errors that stick best once corrected.

If you get an idea wrong again and a card for it already exists, no new card is made: the existing card is brought forward for review today (only if it is already in review; a card still new or in its learning steps comes up anyway). Duplicates are found among the cards of the same session and, in practice, among cards that exercise the same proposition.

## Settings → Anki

- **Create Anki cards from mistakes**, and the connection status with **Check again**.
- **Deck**: default `LearnHarness::{folder}`. `{folder}` is the session's folder in your sources list (nested folders become subdecks); `{session}` is the session name; `::` separates subdecks. An empty placeholder drops its part, so sessions outside folders go to `LearnHarness`. The session itself is a tag, not a deck: Anki's manual advises against many small decks.
- **Which mistakes**: the five settings in the table above, all on by default.
- **Cards per session**: 5, 10 (default), 20 or no limit. Cards you ask for don't count.
- **AnkiConnect API key**: only if you set one in AnkiConnect's config. It is stored on the server and never shown again; **Clear** removes it.
- **Recent cards**: what happened to each mistake (waiting for the explanation, waiting for Anki, in Anki, skipped and why) and who wrote the card (the tutor or the reserve writer), with **Open in Anki** and **Remove**, and **Try again** on a card Anki refused. Removing a card that is in Anki deletes its note there, after a confirmation, and the mistake is never turned into a card again.

## In Anki

- Note type **LearnHarness**, created on the first card, with the fields `LH ID` (the card's id in LearnHarness; leave it as is), `Front`, `Back`, `Why`, `Pitfall` and `Source` (session name and date). Math uses Anki's MathJax delimiters, `\(…\)` and `\[…\]`.
- Tags: `LearnHarness`, plus `LearnHarness::phase::probe|teach|practice`, `LearnHarness::miss::wrong|dont-know|guess|not-solved|heavy-hint|requested`, `LearnHarness::type::<miss type>` for practice misses, `LearnHarness::confident-error`, and `LearnHarness::session::<session-name>_<id>`. Search `tag:LearnHarness` in Anki's browser to see them all.
- Cards are yours once they are in Anki: deleting a session in LearnHarness leaves them there.

## How it works

- **Finding mistakes.** `src/core/anki/misses.ts` is a pure fold over a session record, like the practice evidence (`docs/evidence.md`): nothing new is stored in the session. Multiple-choice answers are graded again from the question's own answer key; practice outcomes come from `practiceEvidenceOf`.
- **The ledger.** `<data>/anki-cards.json` keeps one record per mistake (`src/server/anki/store.ts`): waiting, queued, sent, skipped, failed or removed, and who wrote the card (`writtenBy`: tutor or writer). A mistake already in the ledger, under its own key or covered by a tutor card, is never processed twice.
- **The tutor's card tool.** `anki_card` (`src/agent/tools/anki-card.ts`) is in the teacher's and the practice agent's tools while the feature is on, never the prober's: nothing is explained during the probe. Its description says when (right after explaining a mistake of a kind you turned on, one card per idea, or when you ask) and how (the same card rules as the reserve writer, `ANKI_CARD_RULES`). The server side (`src/server/anki/tutor.ts`) ties the card to its mistake by the question the tutor names (`ankiMatchMiss`: case, spacing and Markdown don't matter, a prefix or part of the question is enough) and saves it as queued; it is sent at the end of the reply. It refuses a mistake that already has a card, was skipped or removed, or would pass the session limit. When the session record does not show the mistake yet (a practice problem concluded in that same reply), the card is kept with the tutor's question and the pipeline links it after the turn. The tool's answer to the tutor lists up to five mistakes still without a card, as a reminder that costs no prompt cache. The chat shows the card through `GET /api/anki/cards/<id>`. The settings live in `<data>/anki.json`, beside upstream's settings record.
- **The trigger.** `instrumentation.ts` registers a light listener at server start (`src/server/anki/trigger.ts`) on the event bus (`turn-settled`, `record-changed`). It loads the pipeline only on the first event while the feature is on, so the server starts as fast as before.
- **The pipeline.** `src/server/anki/pipeline.ts`: after a turn it folds the session, links the tutor's cards to the mistakes they name (taking the mistake's kind and tags before the card is sent), records the other new mistakes and asks the card writer about the waiting ones, at most 6 per call. The writer is the reserve: a mistake reaches it only after the tutor has finished 2 replies after it without a card (`ankiTutorRepliesAfter`). A mistake is not judged before the tutor has reacted to it; one that needs teaching is not sent to the writer until the probe is done, and is asked about again only after 4 more messages (the writer then sees the start of what followed the mistake and the newest part of the lesson); after 8 "wait" answers or 3 days it is dropped. A failed writer call backs off the same way. Then every queued card is sent.
- **The card writer.** `src/agent/subagents/anki-writer.ts`, the reserve: one call on the **cheap** model slot (the extractor's), with the same background-use and key checks as the other background workers, in the tutor's language. It answers card, wait or skip for each mistake the tutor left without a card, and sees the tutor's cards among the existing ones, so it does not repeat them. With no background model available, mistakes wait. Its usage is logged but not yet counted in the app's spending view.
- **AnkiConnect.** `src/server/anki/client.ts` speaks AnkiConnect's version-6 protocol from the LearnHarness server, never from the page, so AnkiConnect needs no CORS setting. Only loopback addresses are accepted. When Anki is closed, busy, refuses the key, or something else answers at the address, the cards stay queued and nothing counts against them. A note Anki itself refuses is retried 3 times, then marked failed; **Try again** queues it again.
- **The API.** `GET/PUT /api/anki`, `POST /api/anki/sync`, `GET/POST/DELETE /api/anki/cards/<id>` (`src/server/anki/http.ts`). `GET /api/anki/cards/<id>` reads one ledger record (`{ card }`, null for an unknown id) and never calls Anki. Writes need the same-origin rule and the `x-learnharness-anki` header, like the other fork controls.
- **The interface.** `components/anki/anki-settings.tsx`; its texts are in the pt-BR catalog (`docs/language.md`).

Upstream files touched (small, marked "Fork"):

- `src/core/index.ts` and `src/server/index.ts`: exports.
- `src/agent/teacher-agent.ts`: the `extraTools` build option, added to the teacher's and the practice agent's tools (never the prober's).
- `src/server/chat-handler.ts`: passes `anki_card` to the teacher and the practice agent while the feature is on.
- `components/artifacts/index.ts`: the card in the chat.
- `components/settings/settings-dialog.tsx`: the Anki section.
- `tests/chatgpt-connection-ui.test.tsx`: the settings sections' expected order.

New at the repository root: `instrumentation.ts` (Next.js's server-start hook), which only registers the pipeline.
