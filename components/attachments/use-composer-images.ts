"use client";

/**
 * The images a composer is about to send (fork feature, docs/images.md).
 *
 * Images arrive by pasting (into the composer or anywhere outside a text
 * field), by dropping files anywhere on the page, or through the picker.
 * Each is fitted to the models' size, uploaded at once, and sent by name
 * with the message. Dropped files that are not images become upstream's
 * file path chips (drop-target.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_IMAGES_PER_MESSAGE } from "@/src/core";
import { carriesFiles, pastedImages, preparedImage, transferredFiles } from "./image-files";
import { attachmentUrl } from "./composer-images";
import { acceptDroppedImages, dragTakenAsImages } from "./drop-target";

export interface PendingImage {
	key: string;
	/** A local URL of the picked file, for the thumbnail. */
	preview: string;
	/** The attachment name once uploaded; null while attaching. */
	name: string | null;
}

export interface ComposerImages {
	items: readonly PendingImage[];
	uploading: boolean;
	/** Files are being dragged over the page. */
	dragging: boolean;
	error: string | null;
	add(files: readonly File[]): void;
	remove(key: string): void;
	clear(): void;
	/** Puts uploaded images back in the tray, replacing what is there (a
	 *  failed session opening returns its images, like its text). */
	restore(names: readonly string[]): void;
	/** The uploaded images' names, in order (read at send time). */
	names(): string[];
	isUploading(): boolean;
	/** For a text field's paste event: attaches the pasted images. */
	onPaste(event: { clipboardData: DataTransfer | null; preventDefault(): void }): void;
	/** Opens the file picker. */
	pick(): void;
}

let nextKey = 0;

async function upload(image: Blob): Promise<string> {
	const response = await fetch("/api/attachments", {
		method: "POST",
		headers: { "Content-Type": image.type, "x-learnharness-attachment": "1" },
		body: image,
	});
	const body = (await response.json().catch(() => null)) as { name?: unknown; error?: unknown } | null;
	if (!response.ok || typeof body?.name !== "string") {
		throw new Error(typeof body?.error === "string" ? body.error : "The image could not be attached.");
	}
	return body.name;
}

function editable(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

export function useComposerImages({ enabled = true }: { enabled?: boolean } = {}): ComposerImages {
	const [items, setItems] = useState<PendingImage[]>([]);
	const itemsRef = useRef<PendingImage[]>([]);
	const [dragging, setDragging] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const enabledRef = useRef(enabled);
	useEffect(() => {
		enabledRef.current = enabled;
	}, [enabled]);

	const update = useCallback((change: (current: PendingImage[]) => PendingImage[]) => {
		itemsRef.current = change(itemsRef.current);
		setItems(itemsRef.current);
	}, []);

	const add = useCallback((files: readonly File[]) => {
		const images = files.filter((file) => file.type.startsWith("image/"));
		const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - itemsRef.current.length);
		setError(
			images.length > room
				? `A message can carry up to ${MAX_IMAGES_PER_MESSAGE} images.`
				: images.length < files.length
					? "Only images can be attached."
					: null,
		);
		for (const file of images.slice(0, room)) {
			const key = `image_${++nextKey}`;
			const preview = URL.createObjectURL(file);
			update((current) => [...current, { key, preview, name: null }]);
			preparedImage(file)
				.then(upload)
				.then(
					(name) => update((current) => current.map((item) => (item.key === key ? { ...item, name } : item))),
					(err: unknown) => {
						URL.revokeObjectURL(preview);
						update((current) => current.filter((item) => item.key !== key));
						setError(err instanceof Error && err.message ? err.message : "The image could not be attached.");
					},
				);
		}
	}, [update]);

	const remove = useCallback((key: string) => {
		const item = itemsRef.current.find((candidate) => candidate.key === key);
		if (item) URL.revokeObjectURL(item.preview);
		update((current) => current.filter((candidate) => candidate.key !== key));
		setError(null);
	}, [update]);

	const clear = useCallback(() => {
		for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
		update(() => []);
		setError(null);
	}, [update]);

	const restore = useCallback((restored: readonly string[]) => {
		for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
		update(() => restored.map((name) => ({ key: `image_${++nextKey}`, preview: attachmentUrl(name), name })));
		setError(null);
	}, [update]);

	const names = useCallback(() => itemsRef.current.flatMap((item) => (item.name ? [item.name] : [])), []);
	const isUploading = useCallback(() => itemsRef.current.some((item) => item.name === null), []);

	const onPaste = useCallback((event: { clipboardData: DataTransfer | null; preventDefault(): void }) => {
		const files = pastedImages(event.clipboardData);
		if (files.length === 0) return;
		event.preventDefault();
		add(files);
	}, [add]);

	const pick = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.addEventListener("change", () => add(Array.from(input.files ?? [])));
		input.click();
	}, [add]);

	// Images dropped on upstream's drop zone, which covers the content
	// area, come here while this composer takes them.
	useEffect(() => (enabled ? acceptDroppedImages(add) : undefined), [enabled, add]);

	// Pasting outside any text field, and dropping outside upstream's drop
	// zone (the sidebar). The zone decides what the content area accepts.
	useEffect(() => {
		let settle: ReturnType<typeof setTimeout> | undefined;
		const onWindowPaste = (event: ClipboardEvent) => {
			if (event.defaultPrevented || !enabledRef.current || editable(event.target)) return;
			onPaste(event);
		};
		const onDragOver = (event: DragEvent) => {
			if (!carriesFiles(event.dataTransfer) || !enabledRef.current) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			// The hint is for images only; other files show the zone's overlay.
			if (!dragTakenAsImages(event.dataTransfer)) return;
			setDragging(true);
			clearTimeout(settle);
			settle = setTimeout(() => setDragging(false), 200);
		};
		const onDrop = (event: DragEvent) => {
			if (!carriesFiles(event.dataTransfer)) return;
			event.preventDefault();
			clearTimeout(settle);
			setDragging(false);
			if (enabledRef.current) add(transferredFiles(event.dataTransfer));
		};
		window.addEventListener("paste", onWindowPaste);
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", onDrop);
		return () => {
			clearTimeout(settle);
			window.removeEventListener("paste", onWindowPaste);
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", onDrop);
		};
	}, [add, onPaste]);

	// The thumbnails' local URLs go with the composer.
	useEffect(() => () => {
		for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
	}, []);

	const uploading = items.some((item) => item.name === null);
	return useMemo(
		() => ({ items, uploading, dragging, error, add, remove, clear, restore, names, isUploading, onPaste, pick }),
		[items, uploading, dragging, error, add, remove, clear, restore, names, isUploading, onPaste, pick],
	);
}
