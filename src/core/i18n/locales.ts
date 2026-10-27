/**
 * Interface and tutor languages (fork feature, docs/language.md).
 *
 * English is the source language: the components are written in it, and
 * other languages are applied at runtime from a catalog, so upstream
 * merges never touch translated code. The tutor's language is a separate
 * choice that follows the interface unless the learner pins it.
 */

export const LOCALES = ["en", "pt-BR"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** "app" = teach in the interface language. */
export type TutorLanguage = "app" | Locale;

export interface LanguageSettings {
	ui: Locale;
	tutor: TutorLanguage;
}

export const DEFAULT_LANGUAGE: LanguageSettings = Object.freeze({ ui: DEFAULT_LOCALE, tutor: "app" });

/** Each language is named in itself, so it can be found from any interface language. */
export const LOCALE_NAMES: Record<Locale, string> = {
	en: "English",
	"pt-BR": "Português (Brasil)",
};

/** Browser storage key shared by the boot script and the provider. */
export const LOCALE_STORAGE_KEY = "lh:locale";
/** Cookie mirror of the interface language. The desktop app serves each
 * launch from a new port, which empties origin-bound storage; cookies are
 * scoped by host, so the next launch can still translate before first paint. */
export const LOCALE_COOKIE = "lh-locale";

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function isTutorLanguage(value: unknown): value is TutorLanguage {
	return value === "app" || isLocale(value);
}

/** Lenient read of a stored record: unknown values fall back to defaults. */
export function parseLanguageSettings(value: unknown): LanguageSettings {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		ui: isLocale(record.ui) ? record.ui : DEFAULT_LANGUAGE.ui,
		tutor: isTutorLanguage(record.tutor) ? record.tutor : DEFAULT_LANGUAGE.tutor,
	};
}

/** The language the tutor writes in. */
export function tutorLocale(settings: LanguageSettings): Locale {
	return settings.tutor === "app" ? settings.ui : settings.tutor;
}

/** True when nothing differs from upstream's English-only behavior. */
export function isDefaultLanguage(settings: LanguageSettings): boolean {
	return settings.ui === DEFAULT_LOCALE && tutorLocale(settings) === DEFAULT_LOCALE;
}
