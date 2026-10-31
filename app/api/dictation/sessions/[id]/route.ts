import { dictationSessionResponse } from "@/src/server";

// Fork: local dictation (docs/dictation.md).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Context): Promise<Response> {
	return dictationSessionResponse(request, (await ctx.params).id);
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
	return dictationSessionResponse(request, (await ctx.params).id);
}
