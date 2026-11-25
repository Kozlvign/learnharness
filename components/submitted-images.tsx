"use client";

import type { ImageContent } from "@earendil-works/pi-ai";
import { attachmentUrl } from "./attachments/composer-images";
import { useSessionMermaid } from "./session-overlay";

// Use session prose metrics, not the compact labels surrounding thinking/images.
const previewSize = "calc(var(--lh-prose-size) * var(--lh-prose-leading) * 5)";

/** Explicit native image data only. Paths are never interpreted here.
 *  Fork: `attachments` are the learner's attached images by name
 *  (docs/images.md), shown from their files ahead of the inline images. */
export function SubmittedImages({ images, attachments }: { images?: readonly Readonly<ImageContent>[]; attachments?: readonly string[] }) {
	const viewer = useSessionMermaid();
	const sources = [...(attachments ?? []).map(attachmentUrl), ...(images ?? []).map((image) => `data:${image.mimeType};base64,${image.data}`)];
	if (!sources.length) return null;
	return <div className="w-full space-y-3" data-testid="submitted-images">
		{sources.map((src, index) => {
			const preview = (
				// Native accepted bytes have no remote optimization or re-encoding.
				// eslint-disable-next-line @next/next/no-img-element
				<img src={src} alt="Submitted image" draggable={false} className="block h-auto max-w-full opacity-100"
					style={{ maxHeight: previewSize, maxWidth: `min(100%, ${previewSize})` }} />
			);
			return <figure key={index} className="mx-auto my-3 w-fit max-w-full">
				{viewer?.openImage ? <button type="button" className="block max-w-full cursor-zoom-in" aria-label="Open submitted image fullscreen"
					onClick={event => {
						const element = event.currentTarget.querySelector("img");
						if (element?.naturalWidth && element.naturalHeight) viewer.openImage?.({ src, width: element.naturalWidth, height: element.naturalHeight });
					}}>{preview}</button> : preview}
			</figure>;
		})}
	</div>;
}
