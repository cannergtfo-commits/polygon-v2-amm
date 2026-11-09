import { loadTrending } from "@/lib/gecko";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ tokens: await loadTrending() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trending unavailable";
    return Response.json({ error: message, tokens: [] }, { status: 503 });
  }
}
