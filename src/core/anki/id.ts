/**
 * Anki cards from mistakes (fork feature, docs/anki.md): a card's ledger id.
 * Pure and browser-safe, with no imports, so the chat can compute a probe
 * question's card id from its miss key.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** The card's ledger id and the note's "LH ID": 16 hex chars, FNV-1a 64
 *  over the key's UTF-8 bytes. The same miss always gets the same id, so a
 *  retried send finds the note it already created. */
export function ankiCardId(key: string): string {
	let hash = FNV_OFFSET;
	for (const byte of new TextEncoder().encode(key)) {
		hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
	}
	return hash.toString(16).padStart(16, "0");
}
