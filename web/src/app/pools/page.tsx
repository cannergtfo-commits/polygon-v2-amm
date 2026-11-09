"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useConnection, useWriteContract } from "wagmi";
import { Button } from "@/components/ui/button";
import { erc20Abi, v2PairAbi, v2RouterAbi } from "@/lib/abis";
import { pushActivity } from "@/lib/activity";
import { publicClient } from "@/lib/chain";
import { formatAmount, parseAmount, shortAddr } from "@/lib/format";
import { registry, scanAddress } from "@/lib/registry";
import { assertCanWrite } from "@/lib/preview";

type Pool = {
  pair: string;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  reserve0: string;
  reserve1: string;
};

export default function PoolsPage() {
  const connection = useConnection();
  const { writeContractAsync: sendWrite, isPending } = useWriteContract();
  const writeContractAsync = (async (args: Parameters<typeof sendWrite>[0]) => {
    assertCanWrite();
    if (connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    return sendWrite(args);
  }) as typeof sendWrite;
  const [pools, setPools] = useState<Pool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [a, setA] = useState("100");
  const [b, setB] = useState("1");
  const [picked, setPicked] = useState<Pool | null>(null);
  const [lp, setLp] = useState("0");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/pools")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Pools unavailable");
        setPools(body.pools);
        setPicked(body.pools[0] ?? null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function approveThen(token: string, amount: bigint, next: () => Promise<void>) {
    assertCanWrite();
    if (!connection.address || connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    const allowance = await publicClient.readContract({
      address: token as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [connection.address, registry.legacy.router as Address],
    });
    if (allowance < amount) {
      const hash = await writeContractAsync({
        address: token as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [registry.legacy.router as Address, amount],
      });
      pushActivity({ hash, kind: "Approval", summary: `Approve ${shortAddr(token)} for the Blazar router`, at: Date.now() });
      setMessage(`Approval ${shortAddr(hash)} sent. Confirm it, then press the button again.`);
      return;
    }
    await next();
  }

  async function add() {
    if (!picked || !connection.address) return;
    setMessage(null);
    const amountA = parseAmount(a, picked.token0.decimals);
    const amountB = parseAmount(b, picked.token1.decimals);
    if (!amountA || !amountB) {
      setMessage("Enter both amounts.");
      return;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    try {
      await approveThen(picked.token0.address, amountA, async () => {
        await approveThen(picked.token1.address, amountB, async () => {
          const hash = await writeContractAsync({
            address: registry.legacy.router as Address,
            abi: v2RouterAbi,
            functionName: "addLiquidity",
            args: [
              picked.token0.address as Address,
              picked.token1.address as Address,
              amountA,
              amountB,
              (amountA * 95n) / 100n,
              (amountB * 95n) / 100n,
              connection.address!,
              deadline,
            ],
          });
          pushActivity({ hash, kind: "Liquidity", summary: `Add ${picked.token0.symbol}/${picked.token1.symbol}`, at: Date.now() });
          setMessage(`Add liquidity submitted: ${shortAddr(hash)}`);
        });
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Add liquidity failed");
    }
  }

  async function remove() {
    if (!picked || !connection.address) return;
    const amount = parseAmount(lp, 18);
    if (!amount) {
      setMessage("Enter LP amount.");
      return;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    try {
      const [supply, reserves] = await Promise.all([
        publicClient.readContract({ address: picked.pair as Address, abi: erc20Abi, functionName: "totalSupply" }),
        publicClient.readContract({ address: picked.pair as Address, abi: v2PairAbi, functionName: "getReserves" }),
      ]);
      const min0 = supply === 0n ? 0n : (amount * reserves[0] * 95n) / (supply * 100n);
      const min1 = supply === 0n ? 0n : (amount * reserves[1] * 95n) / (supply * 100n);
      await approveThen(picked.pair, amount, async () => {
        const hash = await writeContractAsync({
          address: registry.legacy.router as Address,
          abi: v2RouterAbi,
          functionName: "removeLiquidity",
          args: [picked.token0.address as Address, picked.token1.address as Address, amount, min0, min1, connection.address!, deadline],
        });
        pushActivity({ hash, kind: "Liquidity", summary: `Remove ${picked.token0.symbol}/${picked.token1.symbol}`, at: Date.now() });
        setMessage(`Remove liquidity submitted: ${shortAddr(hash)}`);
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Remove liquidity failed");
    }
  }

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>BlazarSwap pools</h2>
        <a href={scanAddress(registry.legacy.factory)} target="_blank" rel="noreferrer">
          Factory {shortAddr(registry.legacy.factory)}
        </a>
      </div>
      <p className="note">These are the already-deployed pairs. Adding or removing liquidity uses the existing router and does not charge the new aggregator fee.</p>
      {loading && <p>Reading the factory…</p>}
      {error && <p className="warn">{error}</p>}
      <div className="pool-list">
        {pools.map((pool) => (
          <button key={pool.pair} type="button" className={picked?.pair === pool.pair ? "pool on" : "pool"} onClick={() => setPicked(pool)}>
            <b>
              {pool.token0.symbol} / {pool.token1.symbol}
            </b>
            <span>
              {formatAmount(BigInt(pool.reserve0), pool.token0.decimals, 4)} {pool.token0.symbol}
            </span>
            <span>
              {formatAmount(BigInt(pool.reserve1), pool.token1.decimals, 4)} {pool.token1.symbol}
            </span>
            <a href={scanAddress(pool.pair)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
              {shortAddr(pool.pair)}
            </a>
          </button>
        ))}
      </div>
      {picked && (
        <div className="liq">
          <h3>
            {picked.token0.symbol} / {picked.token1.symbol}
          </h3>
          <label>
            {picked.token0.symbol}
            <input value={a} onChange={(event) => setA(event.target.value)} />
          </label>
          <label>
            {picked.token1.symbol}
            <input value={b} onChange={(event) => setB(event.target.value)} />
          </label>
          <Button className="cta" disabled={isPending || !connection.isConnected} onClick={add}>
            {connection.isConnected ? "Approve / add liquidity" : "Connect to add"}
          </Button>
          <label>
            LP tokens to remove
            <input value={lp} onChange={(event) => setLp(event.target.value)} />
          </label>
          <Button variant="outline" disabled={isPending || !connection.isConnected} onClick={remove}>
            Approve LP / remove
          </Button>
          <p className="note">
            Spender is the existing router{" "}
            <a href={scanAddress(registry.legacy.router)} target="_blank" rel="noreferrer">
              {shortAddr(registry.legacy.router)}
            </a>
            . Adds and removes both keep a 5% floor under the quoted token amounts. The spender is the existing Blazar router, not the new fee wrapper.
          </p>
          {message && <p className="ok">{message}</p>}
        </div>
      )}
    </section>
  );
}
