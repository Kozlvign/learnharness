"use client";
/**
 * A write-only secret field (fork feature, docs/anki.md): CommitInput's
 * look and commit pace (blur or Enter), but it never holds the stored
 * value. A non-empty entry is handed over once and the field empties;
 * Escape drops the entry.
 */
import { useRef, useState } from "react";

export function SecretInput({
	placeholder,
	onCommit,
	ariaLabel,
	testid,
}: {
	placeholder?: string;
	onCommit: (value: string) => void;
	ariaLabel: string;
	testid?: string;
}) {
	const [draft, setDraft] = useState("");
	// Escape blurs too: the blur must not commit what was just dropped.
	const dropped = useRef(false);
	return (
		<input
			type="password"
			value={draft}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			autoComplete="off"
			spellCheck={false}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => {
				const next = draft.trim();
				setDraft("");
				if (dropped.current) {
					dropped.current = false;
					return;
				}
				if (next) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					dropped.current = true;
					e.currentTarget.blur();
				}
			}}
			className="h-7 w-40 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
		/>
	);
}
