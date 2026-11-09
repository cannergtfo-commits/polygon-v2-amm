import { loadToken } from "@/lib/gecko";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address") || "";
  if (!isAddress(address)) return Response.json({ error: "Need a token address." }, { status: 400 });
  try {
    return Response.json(await loadToken(address));
  } catch (error) {
    const message = error instanceof Error ? error.message : "GeckoTerminal unavailable";
    return Response.json({ error: message }, { status: 503 });
  }
}
