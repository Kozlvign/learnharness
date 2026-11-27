"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fuzzyScore } from "@/src/core";

/** The model picker's search, arrow-walk, row styling and scrolling machine.
 * Models and dictation languages supply only their catalog and row content.
 * The caller owns the shared MenuShell and dismissal behavior. */
export function SearchMenuList<T>({
	items, itemKey, searchTerms, compare, prioritize, isSelected, onPick, renderItem,
	searchTestid, listTestid, optionTestid, placeholder, ariaLabel, loading, empty,
	disabled = false, leading,
}: {
	items: readonly T[] | undefined;
	itemKey: (item: T) => string;
	searchTerms: (item: T) => string[];
	compare?: (a: T, b: T) => number;
	/** Optional grouping key: items it answers true for sort ahead of the
	 *  rest, fuzzy rank still deciding within each group (a stable partition,
	 *  never a filter — nothing is hidden). */
	prioritize?: (item: T) => boolean;
	isSelected: (item: T) => boolean;
	onPick: (item: T) => void;
	renderItem: (item: T) => ReactNode;
	searchTestid: string;
	listTestid: string;
	optionTestid: (item: T) => string;
	placeholder: string;
	ariaLabel?: string;
	loading?: string;
	empty: string;
	disabled?: boolean;
	/** One action row above the results (e.g. the Vision slot's "None"),
	 *  shown while the search is empty and walked like any other row. */
	leading?: { testid: string; selected: boolean; content: ReactNode; onPick: () => void };
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => { searchRef.current?.focus(); }, []);
	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = (items ?? [])
		.map((item) => ({ item, score: fuzzyScore(query, ...searchTerms(item)) }))
		.filter((result) => result.score !== null)
		.sort(
			(a, b) =>
				(prioritize ? Number(prioritize(b.item)) - Number(prioritize(a.item)) : 0) ||
				b.score! - a.score! ||
				(compare?.(a.item, b.item) ?? 0),
		)
		.map(({ item }) => item);
	const lead = leading && query.trim() === "" ? leading : undefined;
	/** The walkable rows: the leading action (index 0), then the results. */
	const count = results.length + (lead ? 1 : 0);
	const pickAt = (index: number): boolean => {
		if (lead && index === 0) { lead.onPick(); return true; }
		const chosen = results[index - (lead ? 1 : 0)];
		if (chosen === undefined) return false;
		onPick(chosen);
		return true;
	};
	const rowClass = (i: number, selected: boolean) => `flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted ${
		i === menuIdx ? "bg-accent/40 ring-1 ring-inset ring-border" : ""
	}${selected && i !== menuIdx ? " bg-muted/60" : ""}`;

	return <>
		<input
			type="text"
			ref={searchRef}
			data-testid={searchTestid}
			aria-label={ariaLabel}
			value={query}
			disabled={disabled}
			onChange={(event) => { setQuery(event.target.value); setMenuIdx(null); }}
			onKeyDown={(event) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					event.stopPropagation();
					if (disabled || count === 0) return;
					setMenuIdx((i) => event.key === "ArrowDown"
						? Math.min((i ?? -1) + 1, count - 1)
						: Math.max((i ?? count) - 1, 0));
				} else if (event.key === "Enter") {
					if (!disabled && pickAt(menuIdx ?? 0)) {
						event.preventDefault();
						event.stopPropagation();
					}
				}
			}}
			placeholder={placeholder}
			className="lh-input mb-1.5 w-full rounded-lg border bg-background px-2 py-1.5 text-foreground outline-none focus:ring-1 focus:ring-ring"
		/>
		{!items && loading && <div className="px-2 py-3 text-center text-muted-foreground">{loading}</div>}
		{items && results.length === 0 && <div className="px-2 py-3 text-center text-muted-foreground">{empty}</div>}
		<ul ref={listRef} data-testid={listTestid} className="flex max-h-72 flex-col overflow-y-auto px-1">
			{lead && <li key="__leading" className="mb-1 border-b pb-1">
				<button
					type="button"
					data-testid={lead.testid}
					data-idx={0}
					disabled={disabled}
					onClick={lead.onPick}
					className={rowClass(0, lead.selected)}
				>{lead.content}</button>
			</li>}
			{results.map((item, index) => {
				const i = index + (lead ? 1 : 0);
				return <li key={itemKey(item)}>
					<button
						type="button"
						data-testid={optionTestid(item)}
						data-idx={i}
						disabled={disabled}
						onClick={() => onPick(item)}
						className={rowClass(i, isSelected(item))}
					>{renderItem(item)}</button>
				</li>;
			})}
		</ul>
	</>;
}
