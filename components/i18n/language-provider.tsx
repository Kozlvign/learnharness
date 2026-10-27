"use client";
/**
 * The interface language at runtime (fork feature, docs/language.md):
 * loads the stored choice, runs the runtime translator for non-English
 * interfaces, and saves changes made in Settings → General.
 *
 * The server file is the truth, because the tutor reads it too. Browser
 * storage mirrors it so the next start translates before first paint
 * (see boot-script.tsx) and other windows follow a change.
 *
 * `LanguageRuntime` mounts once in the root layout, beside the app rather
 * than around it, so upstream's layout keeps its shape.
 */
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import {
	CATALOGS,
	createTranslator,
	DEFAULT_LOCALE,
	isLocale,
	LOCALE_COOKIE,
	LOCALE_STORAGE_KEY,
	parseLanguageSettings,
	type LanguageSettings,
	type Locale,
	type Translator,
} from "@/src/core";
import { startDomTranslation } from "./dom-translator";

type Snapshot = {
	/** null until the stored choice has loaded. */
	settings: LanguageSettings | null;
	error: string | null;
};

let snapshot: Snapshot = { settings: null, error: null };
const listeners = new Set<() => void>();
function publish(next: Partial<Snapshot>) {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
const SERVER_SNAPSHOT: Snapshot = { settings: null, error: null };

const translators = new Map<Locale, Translator>();
function translatorFor(locale: Locale): Translator {
	let translator = translators.get(locale);
	if (!translator) translators.set(locale, (translator = createTranslator(CATALOGS[locale])));
	return translator;
}

/** What the page currently shows. */
let applied: { locale: Locale; stop: (() => void) | null } = { locale: DEFAULT_LOCALE, stop: null };

function apply(locale: Locale) {
	if (applied.locale !== locale) {
		applied.stop?.();
		applied = { locale, stop: locale === DEFAULT_LOCALE ? null : startDomTranslation(translatorFor(locale), document.body) };
	}
	document.documentElement.lang = locale;
	document.documentElement.removeAttribute("data-lh-i18n");
}

/** The mirrored choice: the server's cookie first (it survives the desktop
 * app's per-launch port), then this origin's storage. */
function storedLocale(): Locale {
	const cookie = new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]+)`).exec(document.cookie)?.[1];
	if (cookie && isLocale(decodeURIComponent(cookie))) return decodeURIComponent(cookie) as Locale;
	try {
		const value = localStorage.getItem(LOCALE_STORAGE_KEY);
		return isLocale(value) ? value : DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

function storeLocale(locale: Locale) {
	try {
		if (locale === DEFAULT_LOCALE) localStorage.removeItem(LOCALE_STORAGE_KEY);
		else localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	} catch { /* storage unavailable: only the first paint is affected */ }
}

function accept(settings: LanguageSettings) {
	storeLocale(settings.ui);
	apply(settings.ui);
	publish({ settings, error: null });
}

async function readSettings(response: Response): Promise<LanguageSettings> {
	if (!response.ok) throw new Error(`status ${response.status}`);
	return parseLanguageSettings(((await response.json()) as { settings?: unknown }).settings);
}

export function LanguageRuntime() {
	// Before first paint: translate with the mirrored choice right away.
	useLayoutEffect(() => {
		const locale = storedLocale();
		if (locale !== DEFAULT_LOCALE) apply(locale);
		return () => {
			applied.stop?.();
			applied = { locale: DEFAULT_LOCALE, stop: null };
		};
	}, []);

	// Then the stored truth, and changes made in other windows.
	useEffect(() => {
		let live = true;
		const load = () => fetch("/api/language", { cache: "no-store" }).then(readSettings).then(
			(settings) => { if (live) accept(settings); },
			() => { if (live) apply(applied.locale); },
		);
		void load();
		const onStorage = (event: StorageEvent) => { if (event.key === LOCALE_STORAGE_KEY) void load(); };
		window.addEventListener("storage", onStorage);
		return () => {
			live = false;
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	return null;
}

export function useLanguage() {
	const state = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);
	const update = useCallback(async (change: Partial<LanguageSettings>) => {
		publish({ error: null });
		try {
			accept(await readSettings(await fetch("/api/language", {
				method: "PUT",
				headers: { "content-type": "application/json", "x-learnharness-language": "1" },
				body: JSON.stringify(change),
			})));
		} catch {
			publish({ error: "The language could not be saved. Try again." });
		}
	}, []);
	return { ...state, update };
}
