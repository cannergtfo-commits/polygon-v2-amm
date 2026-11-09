import { feePolicy } from "@/lib/bot";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(feePolicy());
}
