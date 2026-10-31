/**
 * Practice evidence, server side (fork feature, docs/evidence.md): a read
 * over the practice session records and the graph. Nothing is stored;
 * every call recomputes from the records.
 */

import {
	practiceEvidenceOf,
	propositionEvidenceOf,
	type PracticeEvidence,
	type PropositionEvidence,
} from "../core/evidence.ts";
import { getGraph } from "../core/graph.ts";
import { stores } from "./stores.ts";

/** Every proposition's view, including the ones never practiced (their
 *  stage says whether they were taught or imported). */
export function propositionEvidenceView(): Record<string, PropositionEvidence> {
	const { nodes } = getGraph(stores.graphStore);
	const items: PracticeEvidence[] = stores.chatStore
		.listChats()
		.filter((summary) => summary.kind === "practice")
		.flatMap((summary) => {
			const record = stores.chatStore.getChat(summary.id);
			return record ? practiceEvidenceOf(record, nodes) : [];
		});
	const imported = new Set(stores.graphStore.readSources().map((source) => source.id));
	return propositionEvidenceOf(items, nodes, imported);
}

/** Only the propositions with practice items: what the node card needs. */
export function practicedPropositionEvidence(): Record<string, PropositionEvidence> {
	return Object.fromEntries(Object.entries(propositionEvidenceView()).filter(([, view]) => view.items.length > 0));
}
