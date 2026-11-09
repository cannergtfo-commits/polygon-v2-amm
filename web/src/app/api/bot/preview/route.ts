import { unsignedPreview } from "@/lib/bot";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 4_096) return Response.json({ error: "Preview request is too large." }, { status: 400 });
    const body = JSON.parse(raw) as { tokenIn?: string; tokenOut?: string; amountIn?: string; slippage?: string; recipient?: string };
    if (!body.tokenIn || !body.tokenOut || !body.amountIn) return Response.json({ error: "tokenIn, tokenOut, and amountIn are required." }, { status: 400 });
    return Response.json(unsignedPreview({ tokenIn: body.tokenIn, tokenOut: body.tokenOut, amountIn: body.amountIn, slippage: body.slippage, recipient: body.recipient }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
