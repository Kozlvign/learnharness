/**
 * Hides the page until the first translation pass when the interface
 * language isn't English (fork feature, docs/language.md), so English text
 * never flashes. The provider lifts the hide after its first pass; the
 * timeout lifts it anyway if something fails.
 */
import { LOCALE_COOKIE, LOCALE_STORAGE_KEY } from "@/src/core";

const SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${LOCALE_COOKIE}=([^;]+)/);var l=m?decodeURIComponent(m[1]):localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)});if(!l||l==="en")return;var d=document.documentElement;d.lang=l;d.setAttribute("data-lh-i18n","pending");var s=document.createElement("style");s.textContent="html[data-lh-i18n=pending] body{visibility:hidden}";document.head.appendChild(s);setTimeout(function(){d.removeAttribute("data-lh-i18n")},3000)}catch(e){}})();`;

export function LanguageBootScript() {
	return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
