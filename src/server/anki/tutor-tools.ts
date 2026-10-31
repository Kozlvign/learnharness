/**
 * The tutor's card tool for one turn (fork feature, docs/anki.md): what the
 * chat handler adds to the teacher's and the practice agent's registry
 * (AgentBuildOptions.extraTools). Nothing while the feature is off. Read
 * fresh per turn, so turning the feature on or off, or changing which
 * mistakes get a card, lands on the next turn.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ankiCardTools } from "../../agent/tools/anki-card.ts";
import { ankiSettings } from "./store.ts";
import { createTutorCard, type AnkiTutorPhase } from "./tutor.ts";

export function ankiTutorTools(chatId: string, phase: AnkiTutorPhase): Record<string, AgentTool<any>> | undefined {
	const settings = ankiSettings();
	if (!settings.enabled) return undefined;
	return ankiCardTools({
		phase,
		triggers: settings.triggers,
		lowConfidenceMax: settings.lowConfidenceMax,
		create: (input, toolCallId) => createTutorCard(chatId, phase, input, toolCallId),
	});
}
