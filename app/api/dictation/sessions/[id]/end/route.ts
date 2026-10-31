import { dictationSessionEndResponse } from "@/src/server";

// Fork: local dictation (docs/dictation.md).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	return dictationSessionEndResponse(request, (await ctx.params).id);
}
