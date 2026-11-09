import { readFile } from "node:fs/promises";
import path from "node:path";
import { registry } from "@/lib/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const file = path.join(process.cwd(), "..", "indexer", "out", "latest.json");
  try {
    const raw = await readFile(file, "utf8");
    return Response.json(JSON.parse(raw));
  } catch {
    return Response.json({
      generatedAt: null,
      days: [],
      note: "No indexer output yet. Points start after BlazarFeeRouter is deployed on a fork or Amoy and `node web/scripts/index-volume.mjs` runs.",
      rules: registry.points,
    });
  }
}
