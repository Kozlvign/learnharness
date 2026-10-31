/**
 * Reading images from pastes, drops and the file picker, and fitting them
 * to the size the models use before upload (fork feature, docs/images.md).
 */
import { IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS, MAX_IMAGE_BYTES } from "@/src/core";

/** Images at most this large that need no scaling are sent as they are. */
const KEEP_BYTES = 1_500_000;
const SENDABLE = ["image/png", "image/jpeg", "image/webp"];

/** How much an image must shrink to fit the limits (1 = not at all). */
export function fitScale(width: number, height: number): number {
	if (!(width > 0 && height > 0)) return 1;
	return Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height), Math.sqrt(IMAGE_MAX_PIXELS / (width * height)));
}

type Transfer = Pick<DataTransfer, "types" | "files"> & { items?: DataTransfer["items"] };

/** Does a drag carry files (not text being dragged around the page)? */
export function carriesFiles(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
	return !!data && Array.from(data.types).includes("Files");
}

/** The files a paste or drop carries. */
export function transferredFiles(data: Transfer | null | undefined): File[] {
	if (!data) return [];
	const files = Array.from(data.files ?? []);
	if (files.length > 0) return files;
	return Array.from(data.items ?? []).flatMap((item) => {
		const file = item.kind === "file" ? item.getAsFile() : null;
		return file ? [file] : [];
	});
}

/** The images in a paste. A paste that also carries plain text stays a
 *  text paste: copying from an office document often puts both on the
 *  clipboard, and then the text is what was meant. */
export function pastedImages(data: Transfer | null | undefined): File[] {
	if (!data || Array.from(data.types).includes("text/plain")) return [];
	return transferredFiles(data).filter((file) => file.type.startsWith("image/"));
}

function encoded(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("This image could not be read."))), type, quality));
}

/** The image as it will be sent: unchanged when it already fits, otherwise
 *  scaled down and re-encoded (PNG for screenshots and drawings while it
 *  stays small, JPEG otherwise). */
export async function preparedImage(file: File): Promise<Blob> {
	let bitmap: ImageBitmap;
	try { bitmap = await createImageBitmap(file); } catch { throw new Error("This image could not be read."); }
	try {
		const scale = fitScale(bitmap.width, bitmap.height);
		if (scale === 1 && SENDABLE.includes(file.type) && file.size <= KEEP_BYTES) return file;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("This image could not be read.");
		context.imageSmoothingQuality = "high";
		if (file.type === "image/png" || file.type === "image/gif") {
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const png = await encoded(canvas, "image/png");
			if (png.size <= KEEP_BYTES) return png;
		}
		// JPEG has no transparency: transparent areas become white, not black.
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const jpeg = await encoded(canvas, "image/jpeg", 0.88);
		if (jpeg.size > MAX_IMAGE_BYTES) throw new Error("The image is too large.");
		return jpeg;
	} finally {
		bitmap.close();
	}
}
