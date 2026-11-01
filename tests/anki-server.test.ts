// Fork: Anki cards (docs/anki.md). The server side: the AnkiConnect client
// against a fake AnkiConnect, the settings and ledger store, and the HTTP
// handlers. Never touches the user's Anki: every client points at the fake.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
// Anki's data folder: absent unless a test says otherwise.
process.env.ANKI_BASE = path.join(scratch, "no-anki");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const {
	ANKI_HEADER,
	ANKI_NOTE_FIELDS,
	ANKI_NOTE_TEMPLATE,
	ANKI_NOTE_TYPE_NAME,
	ANKI_REASONS,
	DEFAULT_ANKI_SETTINGS,
} = await import("../src/core/anki/contract.ts");
type AnkiCardRecord = import("../src/core/anki/contract.ts").AnkiCardRecord;
type AnkiSettings = import("../src/core/anki/contract.ts").AnkiSettings;
type AnkiStatus = import("../src/core/anki/contract.ts").AnkiStatus;
const store = await import("../src/server/anki/store.ts");
const {
	AnkiActionError,
	AnkiNoteGoneError,
	AnkiProtocolError,
	AnkiSetupError,
	AnkiUnauthorizedError,
	AnkiUnreachableError,
	ankiAddonInstalled,
	createAnkiClient,
	isAnkiDuplicateError,
} = await import("../src/server/anki/client.ts");
const ankiHttp = await import("../src/server/anki/http.ts");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ─── a fake AnkiConnect ─────────────────────────────────────────────────────

type Json = Record<string, any>;
interface Seen { path: string; headers: http.IncomingHttpHeaders; body: Json }
interface Reply { status?: number; body?: unknown; raw?: string | Buffer; delayMs?: number; headers?: Record<string, string> }

/** A small in-memory AnkiConnect: the legacy actions the client uses, the
 *  add-on's error texts, and `api.describe` on /api/v1. */
class FakeAnki {
	server = http.createServer((req, res) => this.handle(req, res));
	url = "";
	requests: Seen[] = [];
	apiKey: string | null = null;
	models = new Map<string, string[]>();
	decks = new Set<string>(["Default"]);
	notes = new Map<number, { deckName: string; modelName: string; fields: Record<string, string>; tags: string[] }>();
	/** card id → its note, and whether it is in review (vs new/learning). */
	cards = new Map<number, { noteId: number; review: boolean }>();
	due: Array<{ cards: number[]; days: string }> = [];
	browsed: string[] = [];
	override: ((seen: Seen) => Reply | undefined) | null = null;
	nextId = 1_700_000_000_000;

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections();
		await new Promise((resolve) => this.server.close(resolve));
	}

	reset(): void {
		this.requests = [];
		this.apiKey = null;
		this.models.clear();
		this.decks = new Set(["Default"]);
		this.notes.clear();
		this.cards.clear();
		this.due = [];
		this.browsed = [];
		this.override = null;
	}

	actions(): string[] {
		return this.requests.filter((seen) => seen.path === "/").map((seen) => seen.body.action as string);
	}

	params(action: string): Json[] {
		return this.requests.filter((seen) => seen.path === "/" && seen.body.action === action).map((seen) => seen.body.params as Json);
	}

	addNoteDirectly(lhId: string, review: boolean[] = [false]): number {
		const id = this.nextId++;
		this.notes.set(id, { deckName: "Default", modelName: ANKI_NOTE_TYPE_NAME, fields: { "LH ID": lhId }, tags: [] });
		for (const inReview of review) this.cards.set(this.nextId++, { noteId: id, review: inReview });
		return id;
	}

	cardsOf(noteId: number, review?: boolean): number[] {
		return [...this.cards].filter(([, card]) => card.noteId === noteId && (review === undefined || card.review === review)).map(([cardId]) => cardId);
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			let body: Json = {};
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { /* recorded as {} */ }
			const seen: Seen = { path: req.url ?? "/", headers: req.headers, body };
			this.requests.push(seen);
			const reply = this.override?.(seen) ?? (seen.path === "/api/v1" ? this.rpc(seen) : { body: this.legacy(body) });
			const send = () => {
				if (res.destroyed) return;
				const raw = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
				res.writeHead(reply.status ?? 200, { "content-type": "application/json", connection: "close", ...reply.headers });
				res.end(raw);
			};
			if (reply.delayMs) setTimeout(send, reply.delayMs);
			else send();
		});
	}

	private rpc(seen: Seen): Reply {
		if (this.apiKey !== null && seen.headers.authorization !== `Bearer ${this.apiKey}`) return { status: 401 };
		if (seen.body.method !== "api.describe") return { body: { jsonrpc: "2.0", id: seen.body.id, error: { code: -32601, message: "Unknown method." } } };
		return { body: { jsonrpc: "2.0", id: seen.body.id, result: { apiMajor: 1, ankiVersion: "26.09.3", schema: {}, methods: [] } } };
	}

	private legacy(body: Json): { result: unknown; error: string | null } {
		const ok = (result: unknown) => ({ result, error: null });
		const fail = (error: string) => ({ result: null, error });
		// The add-on compares the sent key with its own setting, None included.
		if ((body.key ?? null) !== this.apiKey) return fail("valid api key must be provided");
		const p = (body.params ?? {}) as Json;
		switch (body.action) {
			case "version": return ok(6);
			case "getActiveProfile": return ok("User 1");
			case "modelNames": return ok([...this.models.keys()]);
			case "modelFieldNames": {
				const fields = this.models.get(p.modelName);
				return fields ? ok([...fields]) : fail(`model was not found: ${p.modelName}`);
			}
			case "createModel":
				if (this.models.has(p.modelName)) return fail("Model name already exists");
				this.models.set(p.modelName, [...p.inOrderFields]);
				return ok({ id: 1, name: p.modelName });
			case "modelFieldAdd": {
				const fields = this.models.get(p.modelName);
				if (!fields) return fail(`model was not found: ${p.modelName}`);
				fields.splice(p.index ?? fields.length, 0, p.fieldName);
				return ok(null);
			}
			case "createDeck":
				this.decks.add(p.deck);
				return ok(1234);
			case "addNote": {
				const note = p.note as Json;
				const fields = this.models.get(note.modelName);
				if (!fields) return fail(`model was not found: ${note.modelName}`);
				if (!this.decks.has(note.deckName)) return fail(`deck was not found: ${note.deckName}`);
				const first = fields[0]!;
				const taken = [...this.notes.values()].some((other) => other.modelName === note.modelName && other.fields[first] === note.fields[first]);
				if (taken && !note.options?.allowDuplicate) return fail("cannot create note because it is a duplicate");
				const id = this.nextId++;
				this.notes.set(id, { deckName: note.deckName, modelName: note.modelName, fields: note.fields, tags: note.tags });
				this.cards.set(this.nextId++, { noteId: id, review: false });
				return ok(id);
			}
			case "findNotes": {
				const match = /^"LH ID:([0-9a-f]+)" note:LearnHarness$/.exec(p.query);
				if (!match) return fail(`unexpected query: ${p.query}`);
				return ok([...this.notes].filter(([, note]) => note.modelName === ANKI_NOTE_TYPE_NAME && note.fields["LH ID"] === match[1]).map(([id]) => id));
			}
			case "findCards": {
				const match = /^nid:(\d+)( is:review)?$/.exec(p.query);
				if (!match) return fail(`unexpected query: ${p.query}`);
				return ok(this.cardsOf(Number(match[1]), match[2] ? true : undefined));
			}
			case "notesInfo":
				// The add-on answers {} for a note it does not have.
				return ok((p.notes as number[]).map((id) => (this.notes.has(id) ? { noteId: id, modelName: this.notes.get(id)!.modelName, cards: this.cardsOf(id) } : {})));
			case "setDueDate":
				this.due.push({ cards: p.cards, days: p.days });
				return ok(true);
			case "deleteNotes":
				for (const id of p.notes as number[]) {
					this.notes.delete(id);
					for (const cardId of this.cardsOf(id)) this.cards.delete(cardId);
				}
				return ok(null);
			case "guiBrowse":
				this.browsed.push(p.query);
				return ok([]);
			default:
				return fail("unsupported action");
		}
	}
}

const fake = new FakeAnki();
before(() => fake.start());
after(() => fake.stop());

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const LH_ID = "0123456789abcdef";
function noteFields(lhId = LH_ID): Record<(typeof ANKI_NOTE_FIELDS)[number], string> {
	return { "LH ID": lhId, Front: "What is $F$?", Back: "$ma$", Why: "Newton", Pitfall: "", Source: "Session" };
}

// ─── the client ─────────────────────────────────────────────────────────────

describe("AnkiConnect client", () => {
	beforeEach(() => fake.reset());

	it("posts { action, version: 6, params } as JSON, with no Origin header, and the key only when set", async () => {
		assert.equal(await createAnkiClient({ url: fake.url, apiKey: null }).invoke<number>("version"), 6);
		const [plain] = fake.requests;
		assert.equal(plain!.path, "/");
		assert.equal(plain!.headers.origin, undefined, "no Origin header: AnkiConnect admits it");
		assert.equal(plain!.headers["content-type"], "application/json");
		assert.deepEqual(plain!.body, { action: "version", version: 6, params: {} });

		fake.apiKey = "secret";
		assert.equal(await createAnkiClient({ url: fake.url, apiKey: "secret" }).invoke("version"), 6);
		assert.deepEqual(fake.requests[1]!.body, { action: "version", version: 6, params: {}, key: "secret" });
		assert.equal(fake.requests[1]!.headers.origin, undefined);

		await assert.rejects(createAnkiClient({ url: fake.url, apiKey: null }).invoke("version"), AnkiUnauthorizedError);
		await assert.rejects(createAnkiClient({ url: fake.url, apiKey: "wrong" }).invoke("version"), AnkiUnauthorizedError);
	});

	it("a refused port and a slow answer are unreachable", async () => {
		const refused = createAnkiClient({ url: `http://127.0.0.1:${await closedPort()}`, apiKey: null });
		await assert.rejects(refused.invoke("version"), (err: unknown) => err instanceof AnkiUnreachableError && /Nothing answered/.test(err.message));

		fake.override = () => ({ body: { result: 6, error: null }, delayMs: 400 });
		const slow = createAnkiClient({ url: fake.url, apiKey: null, timeoutMs: 100 });
		await assert.rejects(slow.invoke("version"), (err: unknown) => err instanceof AnkiUnreachableError && /within 0.1 s/.test(err.message));
	});

	it("Anki's refusals are action errors; a closed collection is unreachable; a stranger is a protocol error", async () => {
		const client = createAnkiClient({ url: fake.url, apiKey: null });
		await assert.rejects(client.invoke("noSuchAction"), (err: unknown) => err instanceof AnkiActionError && err.message === "unsupported action");

		fake.override = () => ({ body: { result: null, error: "collection is not available" } });
		await assert.rejects(client.invoke("deckNames"), AnkiUnreachableError);
		fake.override = () => ({ body: { result: null, error: "Collection lifecycle operation is active." } });
		await assert.rejects(client.invoke("deckNames"), AnkiUnreachableError);

		const protocol = (pattern: RegExp) => (err: unknown) => err instanceof AnkiProtocolError && !(err instanceof AnkiActionError) && pattern.test(err.message);
		fake.override = () => ({ raw: "<html>not anki</html>", headers: { "content-type": "text/html" } });
		await assert.rejects(client.invoke("version"), protocol(/not JSON/));
		fake.override = () => ({ body: { something: "else" } });
		await assert.rejects(client.invoke("version"), protocol(/did not answer "version" as AnkiConnect/));
		fake.override = () => ({ status: 500 });
		await assert.rejects(client.invoke("version"), protocol(/HTTP 500/));
		fake.override = () => ({ status: 302, headers: { location: "http://example.com/" } });
		await assert.rejects(client.invoke("version"), protocol(/redirect/));
		fake.override = () => ({ raw: Buffer.alloc(4 * 1024 * 1024 + 16, 0x20) });
		await assert.rejects(client.invoke("version"), protocol(/too large/));
		fake.override = (seen) => (seen.body.action === "findNotes" ? { body: { result: "many", error: null } } : undefined);
		await assert.rejects(client.findNoteByLhId(LH_ID), protocol(/"findNotes"/));
	});

	it("checkConnection: connected with the profile and Anki's version, or why not", async () => {
		const connected = await createAnkiClient({ url: fake.url, apiKey: null }).checkConnection();
		assert.deepEqual(connected, { state: "connected", apiVersion: 6, ankiVersion: "26.09.3", profile: "User 1" });
		const describe = fake.requests.find((seen) => seen.path === "/api/v1");
		assert.deepEqual(describe?.body, { jsonrpc: "2.0", id: 1, method: "api.describe" });
		assert.equal(describe?.headers.origin, undefined);
		assert.equal(describe?.headers.authorization, undefined);

		fake.apiKey = "secret";
		fake.requests = [];
		assert.equal((await createAnkiClient({ url: fake.url, apiKey: "secret" }).checkConnection()).state, "connected");
		assert.equal(fake.requests.find((seen) => seen.path === "/api/v1")?.headers.authorization, "Bearer secret");
		const refused = await createAnkiClient({ url: fake.url, apiKey: "wrong" }).checkConnection();
		assert.equal(refused.state, "unauthorized");
		fake.apiKey = null;

		fake.override = (seen) => (seen.path === "/api/v1" ? { status: 404 } : undefined);
		assert.deepEqual(await createAnkiClient({ url: fake.url, apiKey: null }).checkConnection(), { state: "connected", apiVersion: 6, ankiVersion: null, profile: "User 1" });

		fake.override = (seen) => (seen.body.action === "version" ? { body: { result: 5, error: null } } : undefined);
		const old = await createAnkiClient({ url: fake.url, apiKey: null }).checkConnection();
		assert.equal(old.state, "error");
		assert.match(old.state === "error" ? old.error : "", /too old/);

		fake.override = () => ({ raw: "nope" });
		const stranger = await createAnkiClient({ url: fake.url, apiKey: null }).checkConnection();
		assert.equal(stranger.state, "error");
		assert.match(stranger.state === "error" ? stranger.error : "", /did not answer "version" as AnkiConnect \(not JSON\)/);
	});

	it("checkConnection: unreachable says whether the add-on folder is there", async () => {
		const url = `http://127.0.0.1:${await closedPort()}`;
		const missing = await createAnkiClient({ url, apiKey: null }).checkConnection();
		assert.equal(missing.state, "unreachable");
		assert.equal(missing.state === "unreachable" && missing.addonInstalled, null);

		const base = path.join(scratch, "anki-with-addon");
		fs.mkdirSync(path.join(base, "addons21", "2055492159"), { recursive: true });
		const previous = process.env.ANKI_BASE;
		process.env.ANKI_BASE = base;
		try {
			const installed = await createAnkiClient({ url, apiKey: null }).checkConnection();
			assert.equal(installed.state === "unreachable" && installed.addonInstalled, true);
		} finally {
			process.env.ANKI_BASE = previous;
		}
	});

	it("ensureNoteType creates the note type once, then trusts it for a while", async () => {
		const client = createAnkiClient({ url: fake.url, apiKey: null });
		await Promise.all([client.ensureNoteType(), client.ensureNoteType()]);
		assert.deepEqual(fake.actions(), ["modelNames", "createModel"], "concurrent calls share one check");
		assert.deepEqual(fake.params("createModel")[0], {
			modelName: ANKI_NOTE_TYPE_NAME,
			inOrderFields: [...ANKI_NOTE_FIELDS],
			css: ANKI_NOTE_TEMPLATE.css,
			isCloze: false,
			cardTemplates: [{ Name: ANKI_NOTE_TEMPLATE.name, Front: ANKI_NOTE_TEMPLATE.front, Back: ANKI_NOTE_TEMPLATE.back }],
		});
		await client.ensureNoteType();
		assert.equal(fake.requests.length, 2, "cached");

		fake.requests = [];
		await createAnkiClient({ url: fake.url, apiKey: null }).ensureNoteType();
		assert.deepEqual(fake.actions(), ["modelNames", "modelFieldNames"], "an existing complete note type is left alone");
	});

	it("ensureNoteType adds the fields an existing note type lacks, or says how to fix it", async () => {
		fake.models.set(ANKI_NOTE_TYPE_NAME, ["LH ID", "Front", "back", "Source"]);
		await createAnkiClient({ url: fake.url, apiKey: null }).ensureNoteType();
		assert.deepEqual(fake.params("modelFieldAdd"), [
			{ modelName: ANKI_NOTE_TYPE_NAME, fieldName: "Why", index: 3 },
			{ modelName: ANKI_NOTE_TYPE_NAME, fieldName: "Pitfall", index: 4 },
		]);
		assert.deepEqual(fake.models.get(ANKI_NOTE_TYPE_NAME), ["LH ID", "Front", "back", "Why", "Pitfall", "Source"]);

		fake.models.set(ANKI_NOTE_TYPE_NAME, ["Front", "Back"]);
		fake.override = (seen) => (seen.body.action === "modelFieldAdd" ? { body: { result: null, error: "unsupported action" } } : undefined);
		const missing = await createAnkiClient({ url: fake.url, apiKey: null }).ensureNoteType().then(() => null, (err: unknown) => err);
		assert.ok(missing instanceof AnkiSetupError);
		assert.equal(
			(missing as Error).message,
			'The "LearnHarness" note type in Anki lacks the field(s) "LH ID", "Why", "Pitfall", "Source" and this AnkiConnect cannot add fields. ' +
				'Add them in Anki (Tools > Manage Note Types > LearnHarness > Fields), or rename that note type so LearnHarness creates a fresh one.',
		);
	});

	it("the note type or a deck refused: a setup error with Anki's own text", async () => {
		fake.override = (seen) => (seen.body.action === "createModel" ? { body: { result: null, error: "collection is read-only" } } : undefined);
		await assert.rejects(
			createAnkiClient({ url: fake.url, apiKey: null }).ensureNoteType(),
			(err: unknown) => err instanceof AnkiSetupError && err.message === "collection is read-only" && err.cause instanceof AnkiActionError,
		);
		fake.override = (seen) => (seen.body.action === "createDeck" ? { body: { result: null, error: "invalid deck name" } } : undefined);
		await assert.rejects(createAnkiClient({ url: fake.url, apiKey: null }).ensureDeck("::"), (err: unknown) => err instanceof AnkiSetupError && err.message === "invalid deck name");
		// Anki closed while preparing: still unreachable, not a setup error.
		fake.override = () => ({ body: { result: null, error: "collection is not available" } });
		await assert.rejects(createAnkiClient({ url: fake.url, apiKey: null }).ensureDeck("Deck"), AnkiUnreachableError);
		await assert.rejects(createAnkiClient({ url: fake.url, apiKey: null }).ensureNoteType(), AnkiUnreachableError);
	});

	it("adds notes; a second note with the same LH ID is a duplicate and is found by its LH ID", async () => {
		const client = createAnkiClient({ url: fake.url, apiKey: null });
		await client.ensureNoteType();
		await client.ensureDeck("LearnHarness::Physics");
		assert.deepEqual(fake.params("createDeck"), [{ deck: "LearnHarness::Physics" }]);

		const note = { deck: "LearnHarness::Physics", fields: noteFields(), tags: ["LearnHarness", "LearnHarness::phase::teach"] };
		const noteId = await client.addCardNote(note);
		assert.equal(typeof noteId, "number");
		assert.deepEqual(fake.params("addNote")[0], {
			note: {
				deckName: "LearnHarness::Physics",
				modelName: ANKI_NOTE_TYPE_NAME,
				fields: noteFields(),
				tags: ["LearnHarness", "LearnHarness::phase::teach"],
				options: { allowDuplicate: false, duplicateScope: "collection" },
			},
		});

		const duplicate = await client.addCardNote(note).then(() => null, (err: unknown) => err);
		assert.ok(isAnkiDuplicateError(duplicate));
		assert.equal(isAnkiDuplicateError(new AnkiActionError("deck was not found: X")), false);
		assert.equal(isAnkiDuplicateError(new Error("cannot create note because it is a duplicate")), false);

		assert.equal(await client.findNoteByLhId(LH_ID), noteId);
		assert.deepEqual(fake.params("findNotes")[0], { query: `"LH ID:${LH_ID}" note:LearnHarness` });
		assert.equal(await client.findNoteByLhId("fedcba9876543210"), null);
		await assert.rejects(client.findNoteByLhId('x" OR deck:*'), AnkiActionError);
	});

	it("resurface brings only review cards to today; a new note's cards are left alone", async () => {
		const client = createAnkiClient({ url: fake.url, apiKey: null });
		const reviewed = fake.addNoteDirectly(LH_ID, [true, false]);
		assert.equal(await client.resurface(reviewed), true);
		assert.deepEqual(fake.params("findCards"), [{ query: `nid:${reviewed} is:review` }]);
		assert.deepEqual(fake.due, [{ cards: fake.cardsOf(reviewed, true), days: "0" }], "the review card only");

		fake.requests = [];
		const fresh = fake.addNoteDirectly("1111111111111111", [false]);
		assert.equal(await client.resurface(fresh), false);
		assert.deepEqual(fake.actions(), ["findCards", "notesInfo"]);
		assert.equal(fake.due.length, 1, "no due date for a new card");
	});

	it("a note deleted in Anki: resurface and open say it is gone; delete still succeeds", async () => {
		const client = createAnkiClient({ url: fake.url, apiKey: null });
		const noteId = fake.addNoteDirectly(LH_ID, [true]);
		await client.openNote(noteId);
		assert.deepEqual(fake.params("notesInfo"), [{ notes: [noteId] }]);
		assert.deepEqual(fake.params("guiBrowse"), [{ query: `nid:${noteId}` }]);

		await client.deleteNote(noteId);
		assert.deepEqual(fake.params("deleteNotes"), [{ notes: [noteId] }]);
		assert.equal(fake.notes.has(noteId), false);
		await client.deleteNote(noteId);

		const gone = (err: unknown) => err instanceof AnkiNoteGoneError && err.message === `Note ${noteId} is no longer in Anki.`;
		await assert.rejects(client.resurface(noteId), gone);
		fake.requests = [];
		await assert.rejects(client.openNote(noteId), gone);
		assert.deepEqual(fake.actions(), ["notesInfo"], "the browser is not opened on nothing");
		await assert.rejects(client.deleteNote(-1), AnkiActionError);
	});
});

describe("ankiAddonInstalled", () => {
	const root = path.join(scratch, "addon-check");

	it("ANKI_BASE wins: true with the add-on folder, false without, null without Anki's folder", () => {
		const base = path.join(root, "custom");
		assert.equal(ankiAddonInstalled({ ANKI_BASE: base }, "win32"), null);
		fs.mkdirSync(path.join(base, "addons21"), { recursive: true });
		assert.equal(ankiAddonInstalled({ ANKI_BASE: base }, "linux"), false);
		fs.mkdirSync(path.join(base, "addons21", "2055492159"));
		assert.equal(ankiAddonInstalled({ ANKI_BASE: base }, "darwin"), true);
	});

	it("the platform defaults: %APPDATA%, Application Support, XDG data", () => {
		const appData = path.join(root, "appdata");
		fs.mkdirSync(path.join(appData, "Anki2", "addons21", "2055492159"), { recursive: true });
		assert.equal(ankiAddonInstalled({ APPDATA: appData }, "win32"), true);

		const home = path.join(root, "home");
		fs.mkdirSync(path.join(home, "Library", "Application Support", "Anki2"), { recursive: true });
		assert.equal(ankiAddonInstalled({ HOME: home }, "darwin"), false);

		assert.equal(ankiAddonInstalled({ HOME: home }, "linux"), null);
		fs.mkdirSync(path.join(home, ".local", "share", "Anki2", "addons21", "2055492159"), { recursive: true });
		assert.equal(ankiAddonInstalled({ HOME: home }, "linux"), true);
		const xdg = path.join(root, "xdg");
		fs.mkdirSync(path.join(xdg, "Anki2"), { recursive: true });
		assert.equal(ankiAddonInstalled({ HOME: home, XDG_DATA_HOME: xdg }, "linux"), false);
	});
});

// ─── the store ──────────────────────────────────────────────────────────────

const ISO = "2026-10-31T12:00:00.000Z";
function cardRecord(overrides: Partial<AnkiCardRecord> = {}): AnkiCardRecord {
	return {
		id: LH_ID,
		key: "chat-1:call-1",
		chatId: "chat-1",
		toolCallId: "call-1",
		sessionTitle: "Forces",
		phase: "teach",
		kind: "wrong",
		missClass: null,
		confident: false,
		targets: [],
		status: "waiting",
		attempts: 0,
		createdAt: ISO,
		updatedAt: ISO,
		...overrides,
	};
}

function writeLedger(cards: unknown[], extra: Record<string, unknown> = {}): void {
	fs.mkdirSync(path.dirname(store.ankiLedgerFile()), { recursive: true });
	fs.writeFileSync(store.ankiLedgerFile(), JSON.stringify({ version: 1, cards, ...extra }));
}

function dataFiles(): string[] {
	return fs.existsSync(process.env.LH_DATA_DIR!) ? fs.readdirSync(process.env.LH_DATA_DIR!) : [];
}

function clearData(): void {
	fs.rmSync(process.env.LH_DATA_DIR!, { recursive: true, force: true });
}

describe("Anki settings store", () => {
	beforeEach(clearData);

	it("lives in <data>/anki.json and defaults without a file", () => {
		assert.equal(store.ankiSettingsFile(), path.join(process.env.LH_DATA_DIR!, "anki.json"));
		assert.deepEqual(store.ankiSettings(), DEFAULT_ANKI_SETTINGS);
	});

	it("saves through the parse, atomically, and re-reads only when the file changes", () => {
		const saved = store.saveAnkiSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true, url: "http://localhost:9999", apiKey: "  key  ", perSessionLimit: 5000 });
		assert.equal(saved.enabled, true);
		assert.equal(saved.apiKey, "key");
		assert.equal(saved.perSessionLimit, DEFAULT_ANKI_SETTINGS.perSessionLimit, "out of range: the default");
		assert.deepEqual(JSON.parse(fs.readFileSync(store.ankiSettingsFile(), "utf8")), saved);
		assert.deepEqual(dataFiles(), ["anki.json"], "no temporary file left behind");
		assert.deepEqual(store.ankiSettings(), saved);

		// Same mtime: the cached value stands.
		const file = store.ankiSettingsFile();
		const pinned = new Date("2026-01-01T00:00:00.000Z");
		fs.utimesSync(file, pinned, pinned);
		assert.equal(store.ankiSettings().enabled, true);
		fs.writeFileSync(file, JSON.stringify({ ...saved, enabled: false }));
		fs.utimesSync(file, pinned, pinned);
		assert.equal(store.ankiSettings().enabled, true, "unchanged mtime: not re-read");
		const later = new Date("2026-01-02T00:00:00.000Z");
		fs.utimesSync(file, later, later);
		assert.equal(store.ankiSettings().enabled, false, "changed mtime: re-read");

		fs.writeFileSync(file, "{ not json");
		assert.deepEqual(store.ankiSettings(), DEFAULT_ANKI_SETTINGS, "unreadable: defaults");
	});

	it("enabledAt is the server's: set when enabled turns on, kept otherwise", async () => {
		const off = store.saveAnkiSettings({ ...DEFAULT_ANKI_SETTINGS, enabledAt: "2020-01-01T00:00:00.000Z" });
		assert.equal(off.enabledAt, null, "a caller cannot set it");

		const before = Date.now();
		const on = store.saveAnkiSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true });
		assert.ok(on.enabledAt !== null && Date.parse(on.enabledAt) >= before && Date.parse(on.enabledAt) <= Date.now());
		assert.equal(store.ankiSettings().enabledAt, on.enabledAt, "stored");

		await sleep(5);
		assert.equal(store.saveAnkiSettings({ ...on, lowConfidenceMax: 10, enabledAt: null }).enabledAt, on.enabledAt, "still on: kept");
		assert.equal(store.saveAnkiSettings({ ...on, enabled: false }).enabledAt, on.enabledAt, "turned off: kept");
		const again = store.saveAnkiSettings({ ...on, enabled: true });
		assert.ok(again.enabledAt !== null && again.enabledAt > on.enabledAt!, "turned on again: now");
	});
});

describe("Anki card ledger", () => {
	beforeEach(clearData);

	it("is empty without a file and keeps only well-formed records", () => {
		assert.equal(store.ankiLedgerFile(), path.join(process.env.LH_DATA_DIR!, "anki-cards.json"));
		assert.deepEqual(store.readAnkiLedger(), { version: 1, cards: [] });

		const good = cardRecord();
		writeLedger([good, null, "card", [], { ...good, id: 7 }, { ...good, key: undefined }, { ...good, chatId: null }, { ...good, status: "lost" }, cardRecord({ id: "1111111111111111", status: "sent", noteId: 42 })]);
		const ledger = store.readAnkiLedger();
		assert.deepEqual(ledger.cards.map((card) => card.id), [LH_ID, "1111111111111111"]);
	});

	it("loaded records get safe targets, attempts and timestamps", () => {
		const { targets: _t, attempts: _a, createdAt: _c, updatedAt: _u, ...bare } = cardRecord();
		writeLedger([
			{ ...bare, id: "1111111111111111", targets: "p1", attempts: "2", createdAt: 5, updatedAt: ISO },
			{ ...bare, id: "2222222222222222", attempts: Number.NaN, createdAt: ISO },
			{ ...bare, id: "3333333333333333", targets: ["p1"], attempts: 2 },
		]);
		const [first, second, third] = store.readAnkiLedger().cards;
		assert.deepEqual([first!.targets, first!.attempts, first!.createdAt, first!.updatedAt], [[], 0, ISO, ISO]);
		assert.deepEqual([second!.targets, second!.attempts, second!.createdAt, second!.updatedAt], [[], 0, ISO, ISO], "NaN (null in JSON) → 0");
		assert.deepEqual([third!.targets, third!.attempts, third!.createdAt, third!.updatedAt], [["p1"], 2, "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"]);
	});

	it("an unreadable ledger is moved aside and starts empty", () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			fs.mkdirSync(process.env.LH_DATA_DIR!, { recursive: true });
			fs.writeFileSync(store.ankiLedgerFile(), "{ half a ledger");
			assert.deepEqual(store.readAnkiLedger(), { version: 1, cards: [] });
			const aside = dataFiles().filter((name) => /^anki-cards\.json\.corrupt-\d+$/.test(name));
			assert.equal(aside.length, 1);
			assert.equal(fs.readFileSync(path.join(process.env.LH_DATA_DIR!, aside[0]!), "utf8"), "{ half a ledger");
			assert.equal(fs.existsSync(store.ankiLedgerFile()), false);

			writeLedger([cardRecord()], { version: 2 });
			assert.deepEqual(store.readAnkiLedger().cards, [], "another version: moved aside too");
			assert.equal(dataFiles().filter((name) => name.includes(".corrupt-")).length, 2);
			assert.equal(errors.length, 2);
		} finally {
			console.error = original;
		}
	});

	it("two unreadable ledgers in the same millisecond keep both copies", () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		const now = mock.method(Date, "now", () => 1_700_000_000_000);
		try {
			fs.mkdirSync(process.env.LH_DATA_DIR!, { recursive: true });
			fs.writeFileSync(store.ankiLedgerFile(), "first");
			store.readAnkiLedger();
			fs.writeFileSync(store.ankiLedgerFile(), "second");
			store.readAnkiLedger();
			const aside = dataFiles().filter((name) => name.includes(".corrupt-")).sort();
			assert.deepEqual(aside, ["anki-cards.json.corrupt-1700000000000", "anki-cards.json.corrupt-1700000000000-1"]);
			assert.equal(fs.readFileSync(path.join(process.env.LH_DATA_DIR!, aside[0]!), "utf8"), "first");
			assert.equal(fs.readFileSync(path.join(process.env.LH_DATA_DIR!, aside[1]!), "utf8"), "second");
		} finally {
			now.mock.restore();
			console.error = original;
		}
	});

	it("updates read fresh, write atomically and return the mutate's result", async () => {
		writeLedger([cardRecord()]);
		const result = await store.updateAnkiLedger((ledger) => {
			ledger.cards[0]!.status = "queued";
			ledger.cards.push(cardRecord({ id: "2222222222222222", key: "chat-1:call-2" }));
			return "done";
		});
		assert.equal(result, "done");
		const written = JSON.parse(fs.readFileSync(store.ankiLedgerFile(), "utf8"));
		assert.equal(written.version, 1);
		assert.deepEqual(written.cards.map((card: AnkiCardRecord) => [card.id, card.status]), [[LH_ID, "queued"], ["2222222222222222", "waiting"]]);
		assert.deepEqual(dataFiles(), ["anki-cards.json"], "no temporary file left behind");

		// An update that changes nothing does not rewrite the file.
		const pinned = new Date("2026-01-01T00:00:00.000Z");
		fs.utimesSync(store.ankiLedgerFile(), pinned, pinned);
		assert.equal(await store.updateAnkiLedger((ledger) => ledger.cards.length), 2);
		assert.equal(fs.statSync(store.ankiLedgerFile()).mtimeMs, pinned.getTime());
	});

	it("a written update announces each chat whose records changed, once; an unchanged one announces nothing", async () => {
		const { subscribe } = await import("../src/core/events.ts");
		writeLedger([cardRecord(), cardRecord({ id: "2222222222222222", key: "chat-2:call-1", chatId: "chat-2" })]);
		const heard: string[] = [];
		const off = subscribe((event) => {
			const chatId = (event as { chatId?: unknown }).chatId;
			if (event.type === "anki-changed" && typeof chatId === "string") heard.push(chatId);
		});
		try {
			await store.updateAnkiLedger((ledger) => {
				ledger.cards[0]!.status = "queued";
				ledger.cards.push(cardRecord({ id: "3333333333333333", key: "chat-3:call-1", chatId: "chat-3" }));
				ledger.cards.push(cardRecord({ id: "4444444444444444", key: "chat-3:call-2", chatId: "chat-3" }));
			});
			assert.deepEqual(heard.sort(), [cardRecord().chatId, "chat-3"].sort(), "chat-2 did not change");
			heard.length = 0;
			await store.updateAnkiLedger((ledger) => ledger.cards.length);
			assert.deepEqual(heard, []);
			await assert.rejects(store.updateAnkiLedger((ledger) => {
				ledger.cards[1]!.status = "sent";
				throw new Error("nothing written");
			}));
			assert.deepEqual(heard, [], "a failed update announces nothing");
		} finally {
			off();
		}
	});

	it("concurrent updates never interleave and run in call order", async () => {
		let active = 0;
		let overlapped = false;
		const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.updateAnkiLedger(async (ledger) => {
			if (active++ > 0) overlapped = true;
			await sleep(Math.random() * 4);
			ledger.cards.push(cardRecord({ id: index.toString(16).padStart(16, "0"), key: `chat-1:call-${index}` }));
			active -= 1;
			return index;
		})));
		assert.equal(overlapped, false);
		assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => index));
		assert.deepEqual(store.readAnkiLedger().cards.map((card) => card.key), Array.from({ length: 20 }, (_, index) => `chat-1:call-${index}`));
	});

	it("a refused rename is retried with backoff; a final failure leaves no temporary file", async () => {
		const realRename = fsPromises.rename;
		const stubRename = (impl: typeof fsPromises.rename) => {
			(fsPromises as { rename: typeof fsPromises.rename }).rename = impl;
			syncBuiltinESMExports();
		};
		const refusal = (code: string) => Object.assign(new Error(code), { code });
		try {
			writeLedger([cardRecord()]);
			let refusals = 0;
			stubRename(async (from, to) => {
				if (refusals++ < 3) throw refusal("EPERM");
				return realRename(from, to);
			});
			await store.updateAnkiLedger((ledger) => { ledger.cards[0]!.status = "queued"; });
			assert.equal(refusals, 4, "three refusals, then the rename");
			assert.equal(store.readAnkiLedger().cards[0]!.status, "queued");
			assert.deepEqual(dataFiles(), ["anki-cards.json"]);

			const before = fs.readFileSync(store.ankiLedgerFile(), "utf8");
			stubRename(async () => { throw refusal("EXDEV"); });
			await assert.rejects(store.updateAnkiLedger((ledger) => { ledger.cards[0]!.status = "sent"; }), /EXDEV/);
			assert.deepEqual(dataFiles(), ["anki-cards.json"], "not transient: given up at once, temporary file deleted");

			const started = Date.now();
			stubRename(async () => { throw refusal("EBUSY"); });
			await assert.rejects(store.updateAnkiLedger((ledger) => { ledger.cards[0]!.status = "sent"; }), /EBUSY/);
			const waited = Date.now() - started;
			assert.ok(waited >= 1400 && waited <= 3000, `retried for about 2 s (${waited} ms)`);
			assert.deepEqual(dataFiles(), ["anki-cards.json"], "temporary file deleted");
			assert.equal(fs.readFileSync(store.ankiLedgerFile(), "utf8"), before, "ledger untouched");
		} finally {
			stubRename(realRename);
		}
	});

	it("a throwing mutate writes nothing and the next update still runs", async () => {
		writeLedger([cardRecord()]);
		const before = fs.readFileSync(store.ankiLedgerFile(), "utf8");
		const failing = store.updateAnkiLedger(async (ledger) => {
			ledger.cards.length = 0;
			await tick();
			throw new Error("boom");
		});
		const next = store.updateAnkiLedger((ledger) => ledger.cards.length);
		await assert.rejects(failing, /boom/);
		assert.equal(fs.readFileSync(store.ankiLedgerFile(), "utf8"), before);
		assert.equal(await next, 1);
	});
});

// ─── the HTTP handlers ──────────────────────────────────────────────────────

const ORIGIN = "http://127.0.0.1:3123";

function api(pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}, trusted = true): Request {
	const method = init.method ?? "GET";
	const headers: Record<string, string> = { ...(init.headers ?? {}) };
	if (trusted && method !== "GET") Object.assign(headers, { origin: ORIGIN, [ANKI_HEADER]: "1" });
	return new Request(`${ORIGIN}${pathname}`, { ...init, method, headers });
}

function putSettings(body: unknown, headers: Record<string, string> = {}): Request {
	return api("/api/anki", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function cardAction(id: string, method: "POST" | "DELETE", body?: unknown): Request {
	return api(`/api/anki/cards/${id}`, method === "POST"
		? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? { action: "open" }) }
		: { method });
}

function enable(overrides: Partial<AnkiSettings> = {}): AnkiSettings {
	return store.saveAnkiSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true, url: fake.url, ...overrides });
}

describe("Anki HTTP API", () => {
	let runs = 0;
	let gate: Promise<void> | null = null;
	const handlers = ankiHttp.createAnkiHttp({
		runPipeline: async () => {
			runs += 1;
			await gate;
		},
	});

	beforeEach(() => {
		clearData();
		fake.reset();
		runs = 0;
		gate = null;
	});

	it("GET reads with no Origin or the same origin; writes need the Origin and the header", async () => {
		assert.equal((await handlers.ankiResponse(api("/api/anki"))).status, 200);
		assert.equal((await handlers.ankiResponse(api("/api/anki", { headers: { origin: ORIGIN } }))).status, 200);
		assert.equal((await handlers.ankiResponse(api("/api/anki", { headers: { origin: "http://evil.test" } }))).status, 403);
		assert.equal((await handlers.ankiResponse(api("/api/anki", { headers: { "sec-fetch-site": "cross-site" } }))).status, 403);

		const body = JSON.stringify(DEFAULT_ANKI_SETTINGS);
		const noHeader = api("/api/anki", { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body }, false);
		assert.equal((await handlers.ankiResponse(noHeader)).status, 403);
		const otherOrigin = api("/api/anki", { method: "PUT", headers: { origin: "http://evil.test", [ANKI_HEADER]: "1", "content-type": "application/json" }, body }, false);
		assert.equal((await handlers.ankiResponse(otherOrigin)).status, 403);
		const noOrigin = api("/api/anki", { method: "PUT", headers: { [ANKI_HEADER]: "1", "content-type": "application/json" }, body }, false);
		assert.equal((await handlers.ankiResponse(noOrigin)).status, 403);
		assert.equal((await handlers.ankiSyncResponse(api("/api/anki/sync", { method: "POST" }, false))).status, 403);
		assert.equal((await handlers.ankiCardResponse(api(`/api/anki/cards/${LH_ID}`, { method: "DELETE" }, false), LH_ID)).status, 403);

		const response = await handlers.ankiResponse(putSettings(DEFAULT_ANKI_SETTINGS));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
	});

	it("GET while disabled reports it without calling Anki", async () => {
		writeLedger([cardRecord({ status: "queued" })]);
		const response = await ankiHttp.ankiResponse(api("/api/anki"));
		const status = (await response.json()) as AnkiStatus;
		assert.deepEqual(status.settings, DEFAULT_ANKI_SETTINGS);
		assert.equal(status.apiKeySet, false);
		assert.deepEqual(status.connection, { state: "disabled" });
		assert.equal(status.pending, 1);
		assert.equal(fake.requests.length, 0);
	});

	it("PUT validates and saves the settings", async () => {
		const wrongType = api("/api/anki", { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" });
		assert.equal((await handlers.ankiResponse(wrongType)).status, 415);
		assert.equal((await handlers.ankiResponse(putSettings({ ...DEFAULT_ANKI_SETTINGS, deckTemplate: "x".repeat(5000) }))).status, 413);
		assert.equal((await handlers.ankiResponse(putSettings("{ nope"))).status, 400);
		assert.equal((await handlers.ankiResponse(putSettings([]))).status, 400);
		assert.equal((await handlers.ankiResponse(putSettings({ ...DEFAULT_ANKI_SETTINGS, url: "http://192.168.0.2:8765" }))).status, 400);
		assert.equal((await handlers.ankiResponse(putSettings({ ...DEFAULT_ANKI_SETTINGS, url: 8765 }))).status, 400);
		assert.equal((await handlers.ankiResponse(putSettings({ apiKey: 42 }))).status, 400);
		assert.equal((await handlers.ankiResponse(putSettings({ triggers: true }))).status, 400);
		assert.equal(fs.existsSync(store.ankiSettingsFile()), false, "nothing saved");
		assert.equal((await handlers.ankiResponse(api("/api/anki", { method: "POST" }))).status, 405);

		const port = await closedPort();
		const response = await handlers.ankiResponse(putSettings({ ...DEFAULT_ANKI_SETTINGS, enabled: true, url: `http://127.0.0.1:${port}`, lowConfidenceMax: 20, triggers: { lowConfidence: false } }));
		assert.equal(response.status, 200);
		const status = (await response.json()) as AnkiStatus;
		assert.equal(status.settings.enabled, true);
		assert.equal(status.settings.lowConfidenceMax, 20);
		assert.deepEqual(status.settings.triggers, { ...DEFAULT_ANKI_SETTINGS.triggers, lowConfidence: false });
		assert.equal(status.connection.state, "unreachable");
		assert.equal(typeof status.settings.enabledAt, "string", "turned on: the server stamps it");
		assert.deepEqual(JSON.parse(fs.readFileSync(store.ankiSettingsFile(), "utf8")), status.settings);
	});

	it("PUT is a partial merge; the apiKey is write-only", async () => {
		enable({ url: `http://127.0.0.1:${await closedPort()}`, lowConfidenceMax: 20 });
		const enabledAt = store.ankiSettings().enabledAt;
		const put = async (body: unknown) => {
			const response = await handlers.ankiResponse(putSettings(body));
			assert.equal(response.status, 200);
			return (await response.json()) as AnkiStatus;
		};

		let status = await put({ apiKey: "  secret  " });
		assert.equal(status.settings.apiKey, null, "never sent back");
		assert.equal(status.apiKeySet, true);
		assert.equal(store.ankiSettings().apiKey, "secret");
		assert.equal(status.settings.lowConfidenceMax, 20, "left out: kept");
		assert.equal(status.settings.enabled, true);

		status = await put({ perSessionLimit: 3, triggers: { wrong: false }, enabledAt: "2001-01-01T00:00:00.000Z" });
		assert.equal(status.apiKeySet, true, "apiKey left out: kept");
		assert.equal(store.ankiSettings().apiKey, "secret");
		assert.equal(status.settings.perSessionLimit, 3);
		assert.deepEqual(status.settings.triggers, { ...DEFAULT_ANKI_SETTINGS.triggers, wrong: false });
		assert.equal(status.settings.enabledAt, enabledAt, "enabledAt in the body: ignored");

		status = await put({ triggers: { dontKnow: false } });
		assert.deepEqual(status.settings.triggers, { ...DEFAULT_ANKI_SETTINGS.triggers, wrong: false, dontKnow: false }, "per trigger");

		status = await put({ apiKey: "" });
		assert.equal(status.apiKeySet, false, "empty: cleared");
		await put({ apiKey: "again" });
		status = await put({ apiKey: null });
		assert.equal(status.apiKeySet, false, "null: cleared");
		assert.equal(store.ankiSettings().apiKey, null);

		const raw = await (await handlers.ankiResponse(api("/api/anki"))).text();
		await put({ apiKey: "hidden-value" });
		const after = await (await handlers.ankiResponse(api("/api/anki"))).text();
		assert.equal(raw.includes("hidden-value") || after.includes("hidden-value"), false, "no answer carries the key");
	});

	it("GET while enabled checks Anki and lists the newest 100 cards; queued cards start a background flush", async () => {
		enable();
		const cards = Array.from({ length: 105 }, (_, index) => cardRecord({
			id: index.toString(16).padStart(16, "0"),
			key: `chat-1:call-${index}`,
			status: index < 3 ? "waiting" : index < 5 ? "queued" : "sent",
			updatedAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
		}));
		writeLedger(cards);
		let release!: () => void;
		gate = new Promise((resolve) => { release = resolve; });

		const status = (await (await handlers.ankiResponse(api("/api/anki"))).json()) as AnkiStatus;
		assert.deepEqual(status.connection, { state: "connected", apiVersion: 6, ankiVersion: "26.09.3", profile: "User 1" });
		assert.equal(status.cards.length, 100);
		assert.equal(status.cards[0]!.key, "chat-1:call-104", "newest first");
		assert.equal(status.cards[99]!.key, "chat-1:call-5");
		assert.equal(status.pending, 5);
		await tick();
		assert.equal(runs, 1, "queued + connected: a background flush");

		await handlers.ankiResponse(api("/api/anki"));
		await handlers.ankiStatus();
		await tick();
		assert.equal(runs, 1, "one flush at a time");
		gate = null;
		release();
		await tick();
		await tick();
		assert.equal(runs, 2, "requests during a run: one more run after it");
		await tick();
		assert.equal(runs, 2);

		// Nothing queued: no flush.
		writeLedger([cardRecord({ status: "waiting" })]);
		await handlers.ankiResponse(api("/api/anki"));
		await tick();
		assert.equal(runs, 2);
	});

	it("a background flush that fails is logged, not thrown", async () => {
		enable();
		writeLedger([cardRecord({ status: "queued" })]);
		const logged: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => { logged.push(args); };
		try {
			const failing = ankiHttp.createAnkiHttp({ runPipeline: async () => { throw new Error("pipeline down"); } });
			assert.equal((await failing.ankiResponse(api("/api/anki"))).status, 200);
			await tick();
			await tick();
			assert.match(String((logged[0] as unknown[])[0]), /background flush failed/);
		} finally {
			console.error = original;
		}
	});

	it("GET while Anki is closed: unreachable, and no flush", async () => {
		enable({ url: `http://127.0.0.1:${await closedPort()}` });
		writeLedger([cardRecord({ status: "queued" })]);
		const status = (await (await handlers.ankiResponse(api("/api/anki"))).json()) as AnkiStatus;
		assert.equal(status.connection.state, "unreachable");
		await tick();
		assert.equal(runs, 0);
	});

	it("sync runs the pipeline and answers the status; off = 409", async () => {
		assert.equal((await handlers.ankiSyncResponse(api("/api/anki/sync", { method: "POST" }))).status, 409);
		assert.equal(runs, 0);
		enable();
		writeLedger([cardRecord({ status: "queued" })]);
		const response = await handlers.ankiSyncResponse(api("/api/anki/sync", { method: "POST" }));
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as AnkiStatus).connection.state, "connected");
		await tick();
		assert.equal(runs, 1, "the sync itself, no extra background flush");
		assert.equal((await handlers.ankiSyncResponse(api("/api/anki/sync"))).status, 405);
	});

	it("open: only a sent card with its own note; Anki's errors map to 503/401/410/502", async () => {
		enable();
		const noteId = fake.addNoteDirectly(LH_ID);
		writeLedger([
			cardRecord({ status: "sent", noteId }),
			cardRecord({ id: "2222222222222222", key: "chat-1:call-2", status: "queued" }),
		]);
		assert.equal((await handlers.ankiCardResponse(cardAction("nothex", "POST"), "nothex")).status, 404);
		assert.equal((await handlers.ankiCardResponse(cardAction("3333333333333333", "POST"), "3333333333333333")).status, 404);
		assert.equal((await handlers.ankiCardResponse(cardAction("2222222222222222", "POST"), "2222222222222222")).status, 409);
		assert.equal((await handlers.ankiCardResponse(cardAction(LH_ID, "POST", { action: "explode" }), LH_ID)).status, 400);
		const notJson = api(`/api/anki/cards/${LH_ID}`, { method: "POST", headers: { "content-type": "text/plain" }, body: "open" });
		assert.equal((await handlers.ankiCardResponse(notJson, LH_ID)).status, 415);
		assert.equal((await handlers.ankiCardResponse(api(`/api/anki/cards/${LH_ID}`, { method: "PUT" }), LH_ID)).status, 405);

		const opened = await handlers.ankiCardResponse(cardAction(LH_ID, "POST"), LH_ID);
		assert.equal(opened.status, 200);
		assert.deepEqual(fake.browsed, [`nid:${noteId}`]);

		fake.apiKey = "secret";
		const unauthorized = await handlers.ankiCardResponse(cardAction(LH_ID, "POST"), LH_ID);
		assert.equal(unauthorized.status, 401);
		assert.equal(((await unauthorized.json()) as { code: string }).code, "unauthorized");
		fake.apiKey = null;

		fake.override = (seen) => (seen.body.action === "guiBrowse" ? { body: { result: null, error: "the browser is busy" } } : undefined);
		const refused = await handlers.ankiCardResponse(cardAction(LH_ID, "POST"), LH_ID);
		assert.equal(refused.status, 502);
		const refusedBody = (await refused.json()) as { error: string; code: string };
		assert.match(refusedBody.error, /the browser is busy/);
		assert.equal(refusedBody.code, "action");
		fake.override = () => ({ raw: "not anki" });
		const stranger = await handlers.ankiCardResponse(cardAction(LH_ID, "POST"), LH_ID);
		assert.equal(stranger.status, 502);
		assert.equal(((await stranger.json()) as { code: string }).code, "protocol");
		fake.override = null;

		fake.notes.delete(noteId);
		const gone = await handlers.ankiCardResponse(cardAction(LH_ID, "POST"), LH_ID);
		assert.equal(gone.status, 410);
		assert.equal(((await gone.json()) as { code: string }).code, "noteGone");

		enable({ url: `http://127.0.0.1:${await closedPort()}` });
		assert.equal((await handlers.ankiCardResponse(cardAction(LH_ID, "POST"), LH_ID)).status, 503);
	});

	it("retry: a failed card goes back to queued and the pipeline runs; other cards = 409", async () => {
		enable();
		writeLedger([
			cardRecord({ status: "failed", attempts: 3, reason: "deck was not found: X" }),
			cardRecord({ id: "2222222222222222", key: "chat-1:call-2", status: "sent", noteId: 7 }),
		]);
		const retry = (id: string) => handlers.ankiCardResponse(cardAction(id, "POST", { action: "retry" }), id);

		const response = await retry(LH_ID);
		assert.equal(response.status, 200);
		const record = ((await response.json()) as AnkiStatus).cards.find((card) => card.id === LH_ID)!;
		assert.equal(record.status, "queued");
		assert.equal(record.attempts, 0);
		assert.equal("reason" in record, false);
		assert.ok(record.updatedAt > ISO);
		await tick();
		assert.equal(runs, 1, "the pipeline runs in the background");

		assert.equal((await retry(LH_ID)).status, 409, "queued now: nothing to retry");
		assert.equal((await retry("2222222222222222")).status, 409);
		assert.equal((await retry("3333333333333333")).status, 404);
		await tick();
		assert.equal(runs, 1);
	});

	it("delete: removes the note from Anki when sent; Anki closed = 503 and nothing changes", async () => {
		enable();
		const noteId = fake.addNoteDirectly(LH_ID);
		const otherNote = fake.addNoteDirectly("4444444444444444");
		writeLedger([
			cardRecord({ status: "sent", noteId }),
			cardRecord({ id: "2222222222222222", key: "chat-1:call-2", status: "queued" }),
			cardRecord({ id: "3333333333333333", key: "chat-1:call-3", status: "sent", noteId: otherNote, duplicateOf: "4444444444444444" }),
		]);
		assert.equal((await handlers.ankiCardResponse(cardAction("5555555555555555", "DELETE"), "5555555555555555")).status, 404);

		enable({ url: `http://127.0.0.1:${await closedPort()}` });
		const unreachable = await handlers.ankiCardResponse(cardAction(LH_ID, "DELETE"), LH_ID);
		assert.equal(unreachable.status, 503);
		assert.match(((await unreachable.json()) as { error: string }).error, /Open Anki/);
		assert.equal(store.readAnkiLedger().cards[0]!.status, "sent", "record unchanged");

		enable();
		const removed = await handlers.ankiCardResponse(cardAction(LH_ID, "DELETE"), LH_ID);
		assert.equal(removed.status, 200);
		assert.deepEqual(fake.params("deleteNotes"), [{ notes: [noteId] }]);
		const record = ((await removed.json()) as AnkiStatus).cards.find((card) => card.id === LH_ID)!;
		assert.equal(record.status, "removed");
		assert.equal(record.reason, ANKI_REASONS.removedByUser);

		fake.requests = [];
		assert.equal((await handlers.ankiCardResponse(cardAction("2222222222222222", "DELETE"), "2222222222222222")).status, 200);
		assert.equal((await handlers.ankiCardResponse(cardAction("3333333333333333", "DELETE"), "3333333333333333")).status, 200);
		assert.deepEqual(fake.params("deleteNotes"), [], "queued: nothing in Anki; folded into another card: that note stays");
		assert.equal(fake.notes.has(otherNote), true);
		assert.deepEqual(store.readAnkiLedger().cards.map((card) => card.status), ["removed", "removed", "removed"]);

		assert.equal((await handlers.ankiCardResponse(cardAction(LH_ID, "DELETE"), LH_ID)).status, 200, "removing again is harmless");
		assert.deepEqual(fake.params("deleteNotes"), []);
	});

	it("delete: a sent card whose note was already deleted in Anki is simply removed", async () => {
		enable();
		writeLedger([cardRecord({ status: "sent", noteId: 123_456 })]);
		const response = await handlers.ankiCardResponse(cardAction(LH_ID, "DELETE"), LH_ID);
		assert.equal(response.status, 200);
		assert.equal(store.readAnkiLedger().cards[0]!.status, "removed");
	});
});
