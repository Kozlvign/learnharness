/** Translation catalogs (fork feature, docs/language.md). English is the
 * source text, so its catalog is empty. */
import type { Locale } from "./locales.ts";
import type { Messages } from "./translator.ts";
import ptBR from "./catalog/pt-BR.json" with { type: "json" };

export const CATALOGS: Record<Locale, Messages> = {
	en: {},
	"pt-BR": ptBR.messages as Messages,
};
