"use client";
/** Settings → General: interface and tutor language (fork feature, docs/language.md). */
import { isLocale, isTutorLanguage, LOCALE_NAMES, LOCALES } from "@/src/core";
import { SettingsRow, ThinSelect } from "@/components/settings/controls";
import { useLanguage } from "./language-provider";

export function LanguageSettings() {
	const { settings, update, error } = useLanguage();
	// Language names stay in their own language whatever the interface shows.
	const names = LOCALES.map((locale) => (
		<option key={locale} value={locale} data-lh-i18n="off">{LOCALE_NAMES[locale]}</option>
	));
	return (
		<>
			<SettingsRow label="Language" hint="Menus, buttons and messages." testid="row-language">
				<ThinSelect
					value={settings?.ui ?? "en"}
					ariaLabel="Language"
					testid="select-language"
					disabled={!settings}
					onChange={(value) => { if (isLocale(value)) void update({ ui: value }); }}
				>
					{names}
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Tutor language"
				hint={error ?? "What the tutor teaches, asks and names concepts in. Takes effect on its next reply."}
				testid="row-tutor-language"
			>
				<ThinSelect
					value={settings?.tutor ?? "app"}
					ariaLabel="Tutor language"
					testid="select-tutor-language"
					disabled={!settings}
					onChange={(value) => { if (isTutorLanguage(value)) void update({ tutor: value }); }}
				>
					<option value="app">Same as the app</option>
					{names}
				</ThinSelect>
			</SettingsRow>
		</>
	);
}
