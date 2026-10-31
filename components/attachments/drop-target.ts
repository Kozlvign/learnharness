"use client";

/**
 * Where dropped images go (fork feature, docs/images.md).
 *
 * Upstream's drop zone (components/file-path-drop-zone.tsx) turns dropped
 * files into file path chips. While a composer can attach images, it
 * registers here and takes the dropped images as attachments; every other
 * file stays a path chip. With no composer registered (a question or a
 * practice problem is open, or the session is compacting), images become
 * path chips too.
 */

type Receiver = (files: File[]) => void;

const receivers: Receiver[] = [];

/** Registers a composer that takes dropped images. Returns the unregister. */
export function acceptDroppedImages(receive: Receiver): () => void {
	receivers.push(receive);
	return () => {
		const index = receivers.lastIndexOf(receive);
		if (index >= 0) receivers.splice(index, 1);
	};
}

function isImage(type: string): boolean {
	return type.startsWith("image/");
}

/** Hands the dropped images to the composer, when one takes them.
 *  Returns the files it took; the caller handles the rest. */
export function takeDroppedImages(files: readonly File[]): Set<File> {
	const receive = receivers.at(-1);
	const images = receive ? files.filter((file) => isImage(file.type)) : [];
	if (receive && images.length > 0) receive(images);
	return new Set(images);
}

/** True while a drag carries only images and a composer takes them, so the
 *  composer's own hint shows instead of the path drop overlay. File types
 *  are readable during a drag; the files themselves are not. */
export function dragTakenAsImages(data: Pick<DataTransfer, "items"> | null | undefined): boolean {
	if (receivers.length === 0 || !data) return false;
	const files = Array.from(data.items).filter((item) => item.kind === "file");
	return files.length > 0 && files.every((item) => isImage(item.type));
}
