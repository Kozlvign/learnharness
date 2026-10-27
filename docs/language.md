# Language (fork)

This fork can show LearnHarness in **Brazilian Portuguese** and have the tutor teach in it. English stays the default.

Open **Settings → General**:

- **Language** sets the interface: menus, buttons, settings, status lines and error messages. The change applies at once, without a restart.
- **Tutor language** sets what the tutor writes in: lessons, questions and answer options, hints, feedback, plans, research and PDF briefs, figures and demos, and the names of concepts in the knowledge graph. **Same as the app** (the default) follows the interface. Pick a language to teach in something else, for example a Portuguese interface with an English tutor. The tutor switches on its next reply.

Dictation has its own language setting, in **Settings → Providers → Dictation**.

Your own messages, the tutor's prose, code, math and diagrams are never translated by the interface. Names you or the tutor gave, such as session titles and graph nodes, are only translated when they exactly match an interface phrase. When the subject you study is itself a language, the tutor keeps the material in that language and explains it in yours.

## How it works

LearnHarness's components are written in English, and upstream changes them several times a day. Translating them in place would make every upstream merge conflict, and the fork merges upstream automatically. So the translation lives beside the components:

- **Catalog.** `src/core/i18n/catalog/pt-BR.json` maps each English text, exactly as the interface shows it, to its Portuguese text. Keys with placeholders are patterns. For example, `"{0} steps": "{0} passos"` covers "12 steps", and a value that is itself an entry is translated too. `null` marks text left as is.
- **Runtime translator.** `components/i18n/dom-translator.ts` swaps displayed text and labelling attributes (`title`, `placeholder`, `aria-label`, …) for their entries as React renders them. It does this before the browser paints, because mutation callbacks run as microtasks. Text split around a value (`Used <n> times`) is matched as one phrase, so word order can change. Markdown prose (`.lh-prose`), inputs, code, math and SVG are content and are skipped. `data-lh-i18n="off"` opts any subtree out, and `data-lh-i18n="on"` opts interface inside content back in. Switching back to English restores the original text.
- **No English flash.** The server mirrors the choice in an `lh-locale` cookie. On the next start, a small script at the top of the page (`components/i18n/boot-script.tsx`) hides the page until the first translation pass. The cookie matters because the desktop app serves each launch on a new port, which empties browser storage.
- **Tutor.** `src/agent/models.ts` passes every model call through `withTutorLanguage` (`src/agent/language.ts`). It adds a short `<learner_language>` note (`src/core/i18n/tutor.ts`) to the end of the system prompt, for the teacher, prober, helper agents and compaction alike, and with every provider, including the Claude connection. The prompts stay in English, the language they were tuned in. In English nothing is added, so requests are identical to upstream's.
- **Storage.** The choice is kept in `<data>/language.json`, beside upstream's settings record, so upstream's settings schema is untouched. `GET/PUT /api/language` reads and changes it.

Upstream files touched: `app/layout.tsx` (boot script and runtime), `components/settings/settings-dialog.tsx` (the settings rows), `src/agent/models.ts` (the model calls) and `src/server/index.ts` (an export).

## Keeping Portuguese complete

New upstream text appears in English until the catalog has it. The fork tools keep it complete:

- `node scripts/fork/i18n/check.mjs` lists interface text without an entry. `scripts/fork/i18n/extract.mjs` finds the text: JSX text, user-facing attributes, sentence-like strings, and templates as patterns, including one pattern per plural form.
- `npx tsx scripts/fork/i18n/sync.ts` sends the missing text, its location and the surrounding code to your own Claude Code with the translation guide (`scripts/fork/i18n/GUIDE.md`, which holds the rules and a glossary). It writes back only answers that keep every placeholder. `LH_I18N_MODEL` picks the model (default `sonnet`), and `--dry-run` only lists what is missing.
- `scripts/fork/release-windows.ps1` runs the sync after merging upstream and commits the catalog before building. If Claude Code is unavailable, the release continues and the new text stays in English until the next run. `-NoTranslate` skips the step.

To fix a translation, edit its entry in `src/core/i18n/catalog/pt-BR.json`; the sync never overwrites existing entries. `tests/i18n.test.ts` checks the translator, the catalog's placeholders, the page translation and the tutor note.

## Adding another language

1. Add the code to `LOCALES` and its name to `LOCALE_NAMES` in `src/core/i18n/locales.ts`, and its name for the model to `NAMES` in `src/core/i18n/tutor.ts`.
2. Create `src/core/i18n/catalog/<code>.json` and register it in `src/core/i18n/catalog.ts`.
3. Adapt `GUIDE.md` and the catalog path in `scripts/fork/i18n/check.mjs` for that language, then run the sync.
