import { practicedPropositionEvidence } from "@/src/server";

/**
 * Practice evidence per proposition (fork feature, docs/evidence.md):
 * thin transport over a read of the practice session records. Only the
 * propositions with practice items are returned.
 */

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ propositions: practicedPropositionEvidence() });
}
