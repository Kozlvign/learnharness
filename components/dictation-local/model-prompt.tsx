"use client";
/**
 * The dictation bar without the local model (fork feature,
 * docs/dictation.md). A click on Dictate asks before downloading; the
 * download's progress stays in the bar, and when it finishes the bar is
 * back to Dictate. Esc (or Cancel) dismisses the question; a running
 * download only stops through Cancel.
 */
import { useEffect } from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { downloadPercent, modelSizeLabel, type LocalModelStatus } from "@/src/core";
import { deleteDictationModel, downloadDictationModel, loadDictationStatus, useLocalDictation } from "./store";

const FRAME =
	"flex h-7 w-full min-w-0 items-center justify-center gap-2 rounded-md border border-border/50 bg-card/50 px-2 text-xs text-muted-foreground shadow-lg backdrop-blur";
const ACTION = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline";
const QUIET = "shrink-0 text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline";

export function ModelPromptView({
	model,
	error,
	onDownload,
	onCancelDownload,
	onDismiss,
}: {
	model: LocalModelStatus | null;
	/** A failed request to start or cancel the download. */
	error: string | null;
	onDownload: () => void;
	onCancelDownload: () => void;
	onDismiss: () => void;
}) {
	if (model?.state === "downloading") {
		const percent = downloadPercent(model);
		return (
			<div className={FRAME} data-testid="dictation-model-progress">
				<Loader2Icon className="size-3.5 shrink-0 animate-spin" />
				<span className="min-w-0 truncate">Downloading dictation model… {percent}%</span>
				<span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
					<span className="block h-full bg-foreground/40" style={{ width: `${percent}%` }} />
				</span>
				<button type="button" onClick={onCancelDownload} className={QUIET} data-testid="dictation-model-cancel">
					Cancel
				</button>
			</div>
		);
	}
	const failure = model?.state === "error" ? model.error : error;
	return (
		<div
			className={FRAME}
			data-testid="dictation-model-prompt"
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				onDismiss();
			}}
		>
			<DownloadIcon className="size-3.5 shrink-0" />
			{failure ? (
				<span className="min-w-0 truncate text-red-500/80" title={failure}>Download failed: {failure}</span>
			) : (
				<span className="min-w-0 truncate">Download the dictation model ({modelSizeLabel()})?</span>
			)}
			{/* Focused on arrival: Enter downloads, Esc dismisses. */}
			<button type="button" autoFocus onClick={onDownload} className={ACTION} data-testid="dictation-model-download">
				{failure ? "Retry" : "Download"}
			</button>
			<button type="button" onClick={onDismiss} className={QUIET} data-testid="dictation-model-dismiss">
				Cancel
			</button>
		</div>
	);
}

export function LocalModelPrompt({ onDismiss }: { onDismiss: () => void }) {
	const { status, error } = useLocalDictation();
	const model = status?.model ?? null;
	useEffect(() => {
		void loadDictationStatus().catch(() => {});
	}, []);
	// Downloaded: the bar is back to Dictate.
	useEffect(() => {
		if (model?.state === "ready") onDismiss();
	}, [model?.state, onDismiss]);
	return (
		<ModelPromptView
			model={model}
			error={error}
			onDownload={() => void downloadDictationModel()}
			onCancelDownload={() => void deleteDictationModel()}
			onDismiss={onDismiss}
		/>
	);
}
