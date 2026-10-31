import { attachmentResponse } from "@/src/server";

// Fork: images attached to messages (docs/images.md).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
	const { name } = await ctx.params;
	return attachmentResponse(request, name);
}
