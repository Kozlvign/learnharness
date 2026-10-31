"use client";

/**
 * The node card's Practice section (fork feature, docs/evidence.md): what
 * happened when this proposition was exercised in practice — evidence, not a
 * grade. Neutral text only: no colours, counts, percentages or averages.
 *
 * The whole index is fetched once when this module loads in the browser (the
 * home imports it through graph-view.tsx), so a node card opens already at its
 * final height: the card measures itself once to choose above or below the
 * node. Every mount revalidates in the background.
 */

import Link from "next/link";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useLanguage } from "@/components/i18n/language-provider";
import {
	DEFAULT_LOCALE,
	practiceEvidenceHref,
	type EvidenceStage,
	type MissClass,
	type PracticeOutcome,
	type PropositionEvidence,
} from "@/src/core";

type EvidenceIndex = Record<string, PropositionEvidence>;

let index: EvidenceIndex | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
	inflight ??= fetch("/api/evidence", { cache: "no-store" })
		.then((response) => (response.ok ? (response.json() as Promise<{ propositions?: unknown }>) : null))
		.then((body) => {
			const next = body?.propositions;
			if (!next || typeof next !== "object" || Array.isArray(next)) return;
			index = next as EvidenceIndex;
			for (const listener of listeners) listener();
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

if (typeof window !== "undefined") void load();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The cached index (null until the first load lands). */
function useEvidenceIndex(revalidateKey: string | boolean | null): EvidenceIndex | null {
	const value = useSyncExternalStore(subscribe, () => index, () => null);
	useEffect(() => {
		void load();
	}, [revalidateKey]);
	return value;
}

/** Ids of the sessions that contributed practice evidence. Revalidates
 *  whenever `revalidateKey` changes (a dialog passes its open state). */
export function usePracticeEvidenceChatIds(revalidateKey: string | boolean | null = null): ReadonlySet<string> {
	const value = useEvidenceIndex(revalidateKey);
	return useMemo(() => {
		const ids = new Set<string>();
		for (const view of Object.values(value ?? {})) {
			for (const { evidence } of view.items) ids.add(evidence.chatId);
		}
		return ids;
	}, [value]);
}

export function PropositionEvidence({ nodeId }: { nodeId: string }) {
	const value = useEvidenceIndex(nodeId);
	const { settings } = useLanguage();
	const view = value?.[nodeId];
	if (!view || view.items.length === 0) return null;
	return <PracticeEvidenceList view={view} locale={settings?.ui ?? DEFAULT_LOCALE} />;
}

const OUTCOME_LABEL: Record<PracticeOutcome, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	dismissed: "Dismissed",
};

const MISS_LABEL: Record<MissClass, string> = {
	cue: "Nothing came to mind",
	discrimination: "Picked a similar idea",
	execution: "Right idea, misapplied",
	careless: "Careless slip",
	structural: "Misconception",
};

const STAGE_LABEL: Partial<Record<EvidenceStage, string>> = {
	solvedWithoutHelp: "Solved without help",
	solvedWithHelp: "Solved with help",
	practicedNotSolved: "Practiced, not solved yet",
};

function formatDate(at: number, locale: string): string {
	return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

const Dot = () => <span aria-hidden="true">·</span>;

/** The pure body (exported for render tests). */
export function PracticeEvidenceList({ view, locale }: { view: PropositionEvidence; locale: string }) {
	if (view.items.length === 0) return null;
	const stageLabel = STAGE_LABEL[view.stage.kind];
	return (
		<div data-testid="practice-evidence" className="mt-3 flex flex-col gap-1">
			<div className="text-xs text-muted-foreground">Practice</div>
			{stageLabel && view.stage.at !== null && (
				<div data-testid="practice-evidence-stage" className="flex flex-wrap gap-x-1.5 px-2 text-xs text-foreground">
					<span>{stageLabel}</span>
					<Dot />
					<span>{formatDate(view.stage.at, locale)}</span>
				</div>
			)}
			<ul className="flex max-h-48 flex-col overflow-y-auto">
				{view.items.map(({ evidence }) => (
					<li key={`${evidence.chatId}:${evidence.problemCallId}`}>
						<Link
							href={practiceEvidenceHref(evidence)}
							scroll={false}
							data-testid="practice-evidence-item"
							className="flex flex-wrap gap-x-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<span>{formatDate(evidence.concludedAt, locale)}</span>
							<Dot />
							<span className="text-foreground">{OUTCOME_LABEL[evidence.outcome]}</span>
							{evidence.rung !== null && (
								<>
									<Dot />
									<span>Hint {evidence.rung}</span>
								</>
							)}
							{evidence.missClass !== null && (
								<>
									<Dot />
									<span>{MISS_LABEL[evidence.missClass]}</span>
								</>
							)}
							{evidence.retest === true && (
								<>
									<Dot />
									<span>Retest</span>
								</>
							)}
							{evidence.targetContext === "only-pick" && (
								<>
									<Dot />
									<span>Target in context</span>
								</>
							)}
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
