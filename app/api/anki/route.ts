import { ankiResponse } from "@/src/server";

// Fork: Anki cards (docs/anki.md).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = ankiResponse;
export const PUT = ankiResponse;
