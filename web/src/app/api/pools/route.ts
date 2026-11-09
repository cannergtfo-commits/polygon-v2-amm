import type { Address } from "viem";
import { erc20Abi, v2FactoryAbi, v2PairAbi } from "@/lib/abis";
import { publicClient } from "@/lib/chain";
import { registry, tokenByAddress } from "@/lib/registry";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > 1_000_000) {
      return Response.json({ error: "Bad cursor." }, { status: 400 });
    }
    const factory = registry.legacy.factory as Address;
    const length = await publicClient.readContract({ address: factory, abi: v2FactoryAbi, functionName: "allPairsLength" });
    const total = Number(length);
    const start = Math.min(cursor, total);
    const end = Math.min(total, start + 25);
    const pairCalls = await publicClient.multicall({
      allowFailure: false,
      contracts: Array.from({ length: end - start }, (_, index) => ({
        address: factory,
        abi: v2FactoryAbi,
        functionName: "allPairs" as const,
        args: [BigInt(start + index)] as const,
      })),
    });
    const pools = await Promise.all(
      pairCalls.map(async (pair) => {
        const [token0, token1, reserves] = await Promise.all([
          publicClient.readContract({ address: pair, abi: v2PairAbi, functionName: "token0" }),
          publicClient.readContract({ address: pair, abi: v2PairAbi, functionName: "token1" }),
          publicClient.readContract({ address: pair, abi: v2PairAbi, functionName: "getReserves" }),
        ]);
        const meta = async (token: Address) => {
          const known = tokenByAddress(token);
          if (known) return { address: token, symbol: known.symbol, decimals: known.decimals };
          try {
            const [symbol, decimals] = await Promise.all([
              publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
              publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
            ]);
            return { address: token, symbol, decimals };
          } catch {
            return { address: token, symbol: "???", decimals: 18 };
          }
        };
        const [a, b] = await Promise.all([meta(token0), meta(token1)]);
        return {
          pair,
          token0: a,
          token1: b,
          reserve0: reserves[0].toString(),
          reserve1: reserves[1].toString(),
        };
      }),
    );
    return Response.json({ factory, router: registry.legacy.router, total, cursor: start, nextCursor: end < total ? end : null, pools });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read BlazarSwap pools";
    return Response.json({ error: message }, { status: 500 });
  }
}
