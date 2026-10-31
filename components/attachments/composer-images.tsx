"use client";

/**
 * Attached images on screen (fork feature, docs/images.md): the composer's
 * tray and attach button, the images in a sent message, and the viewer
 * that opens one at full size.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlusIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import type { ComposerImages } from "./use-composer-images";

export function attachmentUrl(name: string): string {
	return `/api/attachments/${encodeURIComponent(name)}`;
}

/** One image at full size over the page. Esc or a click closes it. */
export function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Claimed at the document, like the app's dialogs: one Esc, one action.
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Image"
			data-testid="image-viewer"
			onClick={onClose}
			className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-background/85 p-6 backdrop-blur-sm"
		>
			{/* eslint-disable-next-line @next/next/no-img-element -- local attachment, no optimization to gain */}
			<img src={src} alt="" className="max-h-full max-w-full rounded-md object-contain shadow-lg" />
		</div>,
		document.body,
	);
}

/** The attach button, left of the composer's text. */
export function AttachImagesButton({ images }: { images: ComposerImages }) {
	return (
		<button
			type="button"
			data-testid="attach-images"
			onClick={images.pick}
			aria-label="Attach images"
			title="Attach images. You can also paste or drop them."
			className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			<ImagePlusIcon className="size-4" />
		</button>
	);
}

/** The images waiting to be sent, above the composer's text. Spans the
 *  composer's full width (it is a flex-wrap row). */
export function ComposerImageTray({ images }: { images: ComposerImages }) {
	const [open, setOpen] = useState<string | null>(null);
	if (images.items.length === 0 && !images.dragging && !images.error) return null;
	return (
		<div data-testid="composer-images" className="basis-full px-1 pt-1">
			{images.dragging && (
				<div className="mb-1.5 rounded-lg border border-dashed border-muted-foreground/50 px-3 py-3 text-center font-ui text-xs text-muted-foreground">
					Drop images to attach them
				</div>
			)}
			{images.items.length > 0 && (
				<ul className="flex flex-wrap gap-1.5">
					{images.items.map((image) => (
						<li key={image.key} className="group relative size-14 overflow-hidden rounded-lg border border-border bg-muted">
							<button type="button" onClick={() => setOpen(image.preview)} aria-label="View image" className="block size-full cursor-zoom-in">
								{/* eslint-disable-next-line @next/next/no-img-element -- a local file preview */}
								<img src={image.preview} alt="" className="size-full object-cover" />
							</button>
							{image.name === null && (
								<span role="status" aria-label="Attaching image" className="absolute inset-0 flex items-center justify-center bg-background/60">
									<LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
								</span>
							)}
							<button
								type="button"
								onClick={() => images.remove(image.key)}
								aria-label="Remove image"
								className="absolute right-0.5 top-0.5 flex size-5 cursor-pointer items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-sm transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
							>
								<XIcon className="size-3" />
							</button>
						</li>
					))}
				</ul>
			)}
			{images.error && (
				<p role="alert" className="mt-1 px-1 font-ui text-xs text-destructive">
					{images.error}
				</p>
			)}
			{open && <ImageViewer src={open} onClose={() => setOpen(null)} />}
		</div>
	);
}

/** The images of a sent message, from its view parts. */
export function MessageImages({ parts }: { parts: readonly { type: string; attachment?: unknown }[] }) {
	const [open, setOpen] = useState<string | null>(null);
	const names = parts.flatMap((part) => (part.type === "image" && typeof part.attachment === "string" ? [part.attachment] : []));
	if (names.length === 0) return null;
	return (
		<div data-testid="message-images" className="my-1 flex flex-wrap gap-2">
			{names.map((name) => (
				<button
					key={name}
					type="button"
					onClick={() => setOpen(attachmentUrl(name))}
					aria-label="View image"
					className="cursor-zoom-in overflow-hidden rounded-md border border-border bg-muted"
				>
					{/* eslint-disable-next-line @next/next/no-img-element -- local attachment, no optimization to gain */}
					<img src={attachmentUrl(name)} alt="Attached image" loading="lazy" className="block max-h-40 max-w-60 object-contain" />
				</button>
			))}
			{open && <ImageViewer src={open} onClose={() => setOpen(null)} />}
		</div>
	);
}
