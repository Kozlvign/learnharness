import { ankiCardResponse } from "@/src/server";

// Fork: Anki cards (docs/anki.md).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Context): Promise<Response> {
	return ankiCardResponse(request, (await ctx.params).id);
}

export async function POST(request: Request, ctx: Context): Promise<Response> {
	return ankiCardResponse(request, (await ctx.params).id);
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
	return ankiCardResponse(request, (await ctx.params).id);
}
