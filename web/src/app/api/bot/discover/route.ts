import { discover } from "@/lib/bot";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(discover());
}
