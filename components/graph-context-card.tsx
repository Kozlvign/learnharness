"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Scaffolding, not a turn: minimal, muted, collapsed by default;
 * expand reveals the picked propositions (name — statement) and the
 * reasoning chains among them (premises → conclusion lines). The model
 * reads the same content through the marker's own text (toLlmMessages);
 * this card is the learner's face of it.
 */

/** The graph-context marker's details (native-messages.ts). */
export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
}

/** One picked proposition, "name — statement", as a pure seam for render
 *  pins. Statements carry LaTeX math (the extractor's statement field,
 *  extraction.ts), so the statement renders through the graph node
 *  card's static Markdown + KaTeX path, inline after the name. `.lh-prose`
 *  sets the prose font and size in unlayered CSS that beats Tailwind's
 *  type utilities — the variable overrides keep the card's own type. */
const STATEMENT_TYPE = "inline [&>p]:inline text-muted-foreground [--font-prose:var(--font-ui)] " +
	"[--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625] " +
	"[&_[data-streamdown=inline-code]]:[font-size:inherit] [&_[data-streamdown=inline-code]]:[color:inherit]";
export function GraphContextProposition({ proposition: p }: { proposition: GraphContextData["propositions"][number] }) {
	return (
		<div data-testid={`graph-context-prop-${p.id}`} className="leading-relaxed">
			<span className="font-medium text-foreground/80">{p.name}</span>
			<span className="text-muted-foreground"> — </span>
			<ToolContentResponse mode="static" className={STATEMENT_TYPE}>
				{p.statement}
			</ToolContentResponse>
		</div>
	);
}

export function GraphContextCard({ data }: { data: GraphContextData }) {
	const [open, setOpen] = useState(false);
	const { propositions = [], chains = [] } = data ?? {};
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	return (
		<div data-testid="graph-context-card" className="my-1">
			<button
				type="button"
				data-testid="graph-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Graph context</span>
				<span className="min-w-0 flex-1 truncate">
					{noun(propositions.length, "proposition", "propositions")}
					{chains.length > 0 ? ` · ${noun(chains.length, "chain", "chains")}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="graph-context-body" className="mt-1 space-y-1 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{propositions.map((p) => (
						<GraphContextProposition key={p.id} proposition={p} />
					))}
					{chains.length > 0 && (
						<div className="pt-1">
							{chains.map((c, i) => (
								<div key={i} className="font-mono text-[11px] text-muted-foreground">
									{c}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
