import { findBestRoute } from "@/lib/quotes";
import { QUOTE_BODY_BYTES, QUOTE_BODY_MS, QUOTE_SLOTS, QUOTE_WORK_MS, QuoteSlots, readBoundedBody } from "@/lib/quote-budget";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

const slots = new QuoteSlots(QUOTE_SLOTS);

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Too many quotes at once.") return { status: 429, error: message };
  if (message === "Quote request is too large.") return { status: 400, error: message };
  if (message === "Quote body timed out." || message === "Quote timed out.") return { status: 408, error: message };
  if (
    message === "Amount is outside uint256." ||
    message === "Amount must be a non-zero integer of at most 78 digits." ||
    message === "Paste two token addresses." ||
    message === "Enter an amount" ||
    message.startsWith("Choose two different")
  ) {
    return { status: 400, error: message };
  }
  return { status: 400, error: "Quote failed" };
}

export async function POST(request: Request) {
  try {
    return await slots.occupy(async (signal) => {
      const raw = await readBoundedBody(request, QUOTE_BODY_BYTES, QUOTE_BODY_MS);
      if (signal.aborted) throw new Error("Quote timed out.");
      const body = JSON.parse(raw) as { tokenIn?: string; tokenOut?: string; amountIn?: string };
      if (!body.tokenIn || !body.tokenOut || !isAddress(body.tokenIn) || !isAddress(body.tokenOut)) {
        throw new Error("Paste two token addresses.");
      }
      if (!body.amountIn || !/^\d{1,78}$/.test(body.amountIn)) {
        throw new Error("Amount must be a non-zero integer of at most 78 digits.");
      }
      const amount = BigInt(body.amountIn);
      if (amount <= 0n || amount > (1n << 256n) - 1n) throw new Error("Amount is outside uint256.");
      const quote = await findBestRoute(body.tokenIn, body.tokenOut, amount, signal);
      return Response.json(quote);
    }, QUOTE_WORK_MS);
  } catch (error) {
    const body = publicError(error);
    return Response.json({ error: body.error }, { status: body.status });
  }
}
