/**
 * Practice evidence on screen (fork feature, docs/evidence.md): the node
 * card's Practice section, the practice cards' link anchors, and the
 * deletion notices. SSR render pins of the pure bodies.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PracticeEvidenceList } from "../components/proposition-evidence.tsx";
import { ConcludeCard, ProblemCard } from "../components/practice-cards.tsx";
import { DeleteSessionBody } from "../components/delete-session-dialog.tsx";
import { DeleteSourceBody } from "../components/delete-source-dialog.tsx";
import type { ArtifactPartProps, PracticeEvidence, PropositionEvidence, SourceEntry } from "../src/core/index.ts";

const evidence = (over: Partial<PracticeEvidence>): PracticeEvidence => ({
	source: "practice",
	chatId: "chat_1",
	problemCallId: "call_p",
	concludeCallId: "call_c",
	targets: ["n_a"],
	mode: "recall",
	outcome: "solved",
	rung: null,
	missClass: null,
	retest: false,
	submissions: 1,
	posedAt: 0,
	concludedAt: Date.UTC(2026, 9, 12, 12),
	targetContext: "none",
	independent: true,
	...over,
});

const view = (items: PropositionEvidence["items"], stage: PropositionEvidence["stage"]): PropositionEvidence => ({
	propositionId: "n_a",
	firstContact: { kind: "taught", sourceId: "chat_t", at: "2026-09-01T00:00:00.000Z" },
	items,
	stage,
});

describe("PracticeEvidenceList", () => {
	const html = renderToStaticMarkup(
		<PracticeEvidenceList
			locale="en"
			view={view(
				[
					{
						evidence: evidence({
							problemCallId: "call_p2",
							concludeCallId: "call_c2",
							outcome: "solvedWithHints",
							rung: "R2",
							missClass: "discrimination",
							retest: true,
							independent: false,
							concludedAt: Date.UTC(2026, 9, 20, 12),
						}),
						spacing: "review",
					},
					{ evidence: evidence({ targetContext: "only-pick", independent: false }), spacing: "review" },
					{
						evidence: evidence({ problemCallId: "call_p0", concludeCallId: null, outcome: "dismissed", retest: null, independent: false }),
						spacing: null,
					},
				],
				{ kind: "solvedWithHelp", chatId: "chat_1", at: Date.UTC(2026, 9, 20, 12) },
			)}
		/>,
	);

	it("leads with the dated stage line, then one row per item, newest first", () => {
		assert.match(html, /data-testid="practice-evidence"/);
		assert.match(html, />Practice</);
		assert.match(html, /data-testid="practice-evidence-stage"[^>]*><span>Solved with help<\/span>.*?<span>Oct 20, 2026<\/span>/);
		const rows = html.match(/data-testid="practice-evidence-item"/g) ?? [];
		assert.equal(rows.length, 3);
		assert.ok(html.indexOf("Solved with hints") < html.indexOf(">Solved<"), "newest first");
	});

	it("rows carry the outcome, hint, error type, retest and the given-away target in words", () => {
		assert.match(html, /<span>Hint R2<\/span>/);
		assert.match(html, /Picked a similar idea/);
		assert.match(html, /<span>Retest<\/span>/);
		assert.match(html, /<span>Target in context<\/span>/);
		assert.match(html, />Dismissed</);
	});

	it("each row links to its card in the session", () => {
		assert.match(html, /href="\/chat\/chat_1#message-call_c2"/);
		assert.match(html, /href="\/chat\/chat_1#message-call_p0"/, "a dismissal without a conclude lands on the problem");
	});

	it("is evidence, not a grade: no verdict, percentages or colours", () => {
		assert.doesNotMatch(html, /%/);
		assert.doesNotMatch(html, /green|amber|red-|verdict/i);
	});

	it("no stage line for a proposition whose only items were dismissed", () => {
		const dismissedOnly = renderToStaticMarkup(
			<PracticeEvidenceList
				locale="en"
				view={view(
					[{ evidence: evidence({ outcome: "dismissed", concludeCallId: null, retest: null, independent: false }), spacing: null }],
					{ kind: "taughtNotPracticed", chatId: null, at: null },
				)}
			/>,
		);
		assert.match(dismissedOnly, /data-testid="practice-evidence-item"/);
		assert.doesNotMatch(dismissedOnly, /practice-evidence-stage/);
	});

	it("renders nothing without items", () => {
		assert.equal(
			renderToStaticMarkup(<PracticeEvidenceList locale="en" view={view([], { kind: "taughtNotPracticed", chatId: null, at: null })} />),
			"",
		);
	});
});

describe("practice card anchors", () => {
	const part = (over: Partial<ArtifactPartProps["part"]>): ArtifactPartProps["part"] => ({
		type: "tool-problem",
		state: "output-available",
		toolCallId: "call_p1",
		...over,
	});

	it("problem and conclusion cards (dismissals too) carry their call's anchor", () => {
		assert.match(renderToStaticMarkup(<ProblemCard part={part({ input: { statement: "S" } })} />), /id="message-call_p1"/);
		assert.match(
			renderToStaticMarkup(<ConcludeCard part={part({ type: "tool-conclude", toolCallId: "call_c1", input: { outcome: "solved", verdict: "V" } })} />),
			/id="message-call_c1"/,
		);
		assert.match(
			renderToStaticMarkup(<ConcludeCard part={part({ type: "tool-conclude", toolCallId: "call_conc_call_p1", input: { outcome: "dismissed" } })} />),
			/id="message-call_conc_call_p1"/,
		);
	});
});

describe("deletion notices", () => {
	const sessionBody = (kind?: "teach" | "practice") =>
		renderToStaticMarkup(
			<DeleteSessionBody
				chat={{ id: "c1", title: "Parity drills", kind }}
				traces={false}
				busy={false}
				failure={null}
				onTraces={() => {}}
				onClose={() => {}}
				onRun={() => {}}
			/>,
		);

	it("deleting a practice session says its results leave the Practice sections", () => {
		assert.match(sessionBody("practice"), /data-testid="delete-practice-evidence"/);
		assert.match(sessionBody("practice"), /Its practice results also leave the Practice section/);
		assert.doesNotMatch(sessionBody("teach"), /delete-practice-evidence/);
		assert.doesNotMatch(sessionBody(), /delete-practice-evidence/);
	});

	it("deleting sources says so only when a selected session has practice evidence", () => {
		const sources: SourceEntry[] = [{ id: "chat_1", kind: "chat", label: "Parity drills", createdAt: "2026-10-01" }];
		const sourceBody = (practiceChatIds?: ReadonlySet<string>) =>
			renderToStaticMarkup(
				<DeleteSourceBody
					sources={sources}
					folders={[]}
					deleteSessions={false}
					onDeleteSessions={() => {}}
					busy={false}
					failure=""
					onClose={() => {}}
					onRun={() => {}}
					practiceChatIds={practiceChatIds}
				/>,
			);
		assert.match(sourceBody(new Set(["chat_1"])), /data-testid="delete-source-practice-evidence"/);
		assert.doesNotMatch(sourceBody(new Set(["chat_other"])), /delete-source-practice-evidence/);
		assert.doesNotMatch(sourceBody(), /delete-source-practice-evidence/);
	});
});
