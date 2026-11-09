import { loadCandles } from "@/lib/gecko";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pool = url.searchParams.get("pool") || "";
  const timeframe = url.searchParams.get("timeframe") || "1h";
  const side = url.searchParams.get("side") === "quote" ? "quote" : "base";
  if (!isAddress(pool)) return Response.json({ error: "Need a pool address." }, { status: 400 });
  try {
    const candles = await loadCandles(pool, timeframe, side);
    return Response.json({ candles });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chart unavailable";
    return Response.json({ error: message, candles: [] }, { status: 503 });
  }
}
