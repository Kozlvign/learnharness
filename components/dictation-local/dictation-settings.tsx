"use client";
/**
 * Settings → Providers → Dictation (fork feature, docs/dictation.md): the
 * engine choice and, for the local engine, the model's download, progress
 * and removal. The Deepgram key row (upstream's) shows only with Deepgram.
 */
import { useEffect } from "react";
import { downloadPercent, isDictationEngine, LOCAL_DICTATION_MODEL, modelSizeLabel, type DictationStatus } from "@/src/core";
import { ThinSelect } from "@/components/settings/controls";
import {
	deleteDictationModel,
	downloadDictationModel,
	loadDictationStatus,
	setDictationEngine,
	useLocalDictation,
} from "./store";

const ROW = "flex items-center justify-between gap-3 px-1 py-1.5";
const ACTION = "shrink-0 text-xs text-foreground underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";
const STATUS = "font-mono text-[11px] text-muted-foreground";

/** Whether upstream's Deepgram key row belongs in the Dictation group. */
export function deepgramKeyRowVisible(status: DictationStatus | null): boolean {
	return status?.settings.engine === "deepgram";
}

export function DictationSettingsView({
	status,
	error,
	sessions,
	onEngine,
	onDownload,
	onDelete,
}: {
	status: DictationStatus | null;
	error: string | null;
	/** Local dictation runs open in this window: the model can't be removed. */
	sessions: number;
	onEngine: (engine: "local" | "deepgram") => void;
	onDownload: () => void;
	/** Cancel the download, or remove the model. */
	onDelete: () => void;
}) {
	const engine = status?.settings.engine ?? "local";
	const model = status?.model ?? null;
	return (
		<>
			<div className={ROW} data-testid="dictation-engine">
				<span className="font-ui text-xs text-foreground">Engine</span>
				<ThinSelect
					value={engine}
					ariaLabel="Dictation engine"
					testid="select-dictation-engine"
					disabled={!status}
					onChange={(value) => { if (isDictationEngine(value)) onEngine(value); }}
				>
					<option value="local">Local (Parakeet)</option>
					<option value="deepgram">Deepgram</option>
				</ThinSelect>
			</div>
			{engine === "local" && (
				<div className={ROW} data-testid="dictation-model">
					<span className="min-w-0">
						<span className="block font-ui text-xs text-foreground">{LOCAL_DICTATION_MODEL.label}</span>
						<span className="block text-[10px] text-muted-foreground/60">{LOCAL_DICTATION_MODEL.attribution} · runs on this computer</span>
					</span>
					<span className="flex shrink-0 items-center gap-2">
						{!model && <span className={STATUS}>Loading…</span>}
						{(model?.state === "missing" || model?.state === "error") && (
							<button type="button" onClick={onDownload} className={ACTION} data-testid="dictation-model-download">
								{model.state === "error" ? "Retry" : `Download (${modelSizeLabel()})`}
							</button>
						)}
						{model?.state === "downloading" && (
							<>
								<span className={STATUS} data-testid="dictation-model-status">Downloading… {downloadPercent(model)}%</span>
								<button type="button" onClick={onDelete} className={ACTION} data-testid="dictation-model-cancel">Cancel</button>
							</>
						)}
						{model?.state === "ready" && (
							<>
								<span className={STATUS} data-testid="dictation-model-status">Downloaded</span>
								<button
									type="button"
									onClick={onDelete}
									disabled={sessions > 0}
									title={sessions > 0 ? "Stop dictation first" : undefined}
									className={ACTION}
									data-testid="dictation-model-remove"
								>
									Remove
								</button>
							</>
						)}
					</span>
				</div>
			)}
			{engine === "local" && model?.state === "error" && (
				<p role="alert" className="px-1 text-xs text-red-500" data-testid="dictation-model-error">Download failed: {model.error}</p>
			)}
			{error && <p role="alert" className="px-1 text-xs text-red-500" data-testid="dictation-error">{error}</p>}
		</>
	);
}

export function DictationSettings() {
	const { status, error, sessions } = useLocalDictation();
	useEffect(() => {
		void loadDictationStatus().catch(() => {});
	}, []);
	return (
		<DictationSettingsView
			status={status}
			error={error}
			sessions={sessions}
			onEngine={(engine) => void setDictationEngine(engine)}
			onDownload={() => void downloadDictationModel()}
			onDelete={() => void deleteDictationModel()}
		/>
	);
}
