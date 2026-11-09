import { createPublicClient, fallback, http } from "viem";
import { polygon } from "viem/chains";
import { registry } from "@/lib/registry";

export const publicClient = createPublicClient({
  chain: polygon,
  transport: fallback(
    registry.rpc.map((url) => http(url, { timeout: 12_000 })),
    { rank: false },
  ),
  batch: { multicall: true },
});

/** One quote's RPC calls share this signal. Aborting it cancels their fetches. */
export function clientFor(signal: AbortSignal) {
  return createPublicClient({
    chain: polygon,
    transport: fallback(
      registry.rpc.map((url) => http(url, { timeout: 8_000, fetchOptions: { signal } })),
      { rank: false },
    ),
    batch: { multicall: true },
  });
}
