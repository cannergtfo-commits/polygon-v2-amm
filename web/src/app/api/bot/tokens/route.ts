import { searchTokens } from "@/lib/bot";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json({ tokens: searchTokens(query) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token search failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
