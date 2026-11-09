"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useConnection, useWriteContract } from "wagmi";
import { Button } from "@/components/ui/button";
import { erc20Abi, feedAbi, m421StakeAbi, m421VaultAbi, v2RouterAbi } from "@/lib/abis";
import { pushActivity } from "@/lib/activity";
import { publicClient } from "@/lib/chain";
import { formatAmount, formatUsd, parseAmount, shortAddr } from "@/lib/format";
import { registry, scanAddress } from "@/lib/registry";
import { assertCanWrite } from "@/lib/preview";

const bzb = registry.tokens.find((token) => token.symbol === "BZB")!;
const wbtc = registry.tokens.find((token) => token.symbol === "WBTC")!;
const weth = registry.tokens.find((token) => token.symbol === "WETH")!;
const usdc = registry.tokens.find((token) => token.symbol === "USDC")!;

export default function M421Page() {
  const connection = useConnection();
  const { writeContractAsync: sendWrite, isPending } = useWriteContract();
  const writeContractAsync = (async (args: Parameters<typeof sendWrite>[0]) => {
    assertCanWrite();
    if (connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    return sendWrite(args);
  }) as typeof sendWrite;
  const [desk, setDesk] = useState({ bzb: 0n, wbtc: 0n, weth: 0n, supply: 0n, staked: 0n, earned: 0n, rate: 0n, mine: 0n, free: 0n });
  const [usd, setUsd] = useState({ bzb: 0, wbtc: 0, weth: 0 });
  const [amounts, setAmounts] = useState({ bzb: "", wbtc: "", weth: "", shares: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      const vault = registry.legacy.m421Vault as Address;
      const share = registry.legacy.m421Share as Address;
      const staking = registry.legacy.m421Staking as Address;
      const [rb, rt, re, supply, staked, rate] = await Promise.all([
        publicClient.readContract({ address: vault, abi: m421VaultAbi, functionName: "reserveBzb" }),
        publicClient.readContract({ address: vault, abi: m421VaultAbi, functionName: "reserveWbtc" }),
        publicClient.readContract({ address: vault, abi: m421VaultAbi, functionName: "reserveWeth" }),
        publicClient.readContract({ address: share, abi: erc20Abi, functionName: "totalSupply" }),
        publicClient.readContract({ address: staking, abi: m421StakeAbi, functionName: "totalSupply" }),
        publicClient.readContract({ address: staking, abi: m421StakeAbi, functionName: "currentDailyRate" }),
      ]);
      let mine = 0n;
      let free = 0n;
      let earned = 0n;
      if (connection.address) {
        [free, mine, earned] = await Promise.all([
          publicClient.readContract({ address: share, abi: erc20Abi, functionName: "balanceOf", args: [connection.address] }),
          publicClient.readContract({ address: staking, abi: m421StakeAbi, functionName: "balanceOf", args: [connection.address] }),
          publicClient.readContract({ address: staking, abi: m421StakeAbi, functionName: "earned", args: [connection.address] }),
        ]);
      }
      if (cancel) return;
      setDesk({ bzb: rb, wbtc: rt, weth: re, supply, staked, earned, rate, mine, free });
      let bzbEach = 0;
      let btcPx = 0;
      let ethPx = 0;
      try {
        const spot = await publicClient.readContract({
          address: registry.legacy.quickRouter as Address,
          abi: v2RouterAbi,
          functionName: "getAmountsOut",
          args: [10n ** 18n, [bzb.address as Address, registry.wpol as Address, usdc.address as Address]],
        });
        bzbEach = Number(spot[spot.length - 1]) / 1e6;
      } catch {
        bzbEach = 0;
      }
      try {
        const btc = await publicClient.readContract({
          address: registry.feeds[wbtc.address as keyof typeof registry.feeds].address as Address,
          abi: feedAbi,
          functionName: "latestRoundData",
        });
        btcPx = Number(btc[1]) / 1e8;
      } catch {
        btcPx = 0;
      }
      try {
        const eth = await publicClient.readContract({
          address: registry.feeds[weth.address as keyof typeof registry.feeds].address as Address,
          abi: feedAbi,
          functionName: "latestRoundData",
        });
        ethPx = Number(eth[1]) / 1e8;
      } catch {
        ethPx = 0;
      }
      if (!cancel) {
        setUsd({
          bzb: (Number(rb) / 1e18) * bzbEach,
          wbtc: (Number(rt) / 1e8) * btcPx,
          weth: (Number(re) / 1e18) * ethPx,
        });
        if (!bzbEach || !btcPx || !ethPx) setError("One price feed did not answer. Reserves are still live.");
        else setError(null);
      }
    }
    load().catch((err: Error) => setError(err.message));
    return () => {
      cancel = true;
    };
  }, [connection.address, message]);

  async function approve(token: string, spender: string, amount: bigint) {
    assertCanWrite();
    if (!connection.address || connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    const allowance = await publicClient.readContract({
      address: token as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [connection.address, spender as Address],
    });
    if (allowance >= amount) return false;
    const hash = await writeContractAsync({
      address: token as Address,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender as Address, amount],
    });
    pushActivity({ hash, kind: "Approval", summary: `Approve ${shortAddr(token)}`, at: Date.now() });
    setMessage(`Approval ${shortAddr(hash)} sent. Repeat the action after it confirms.`);
    return true;
  }

  async function deposit() {
    setError("M421 deposits stay off until the legacy minShares argument is checked against the deployed bytecode. The old call passed 0 and 500 as the last two arguments.");
  }

  async function stake() {
    const shares = parseAmount(amounts.shares || "0", 18);
    if (!shares) return;
    if (await approve(registry.legacy.m421Share, registry.legacy.m421Staking, shares)) return;
    const hash = await writeContractAsync({
      address: registry.legacy.m421Staking as Address,
      abi: m421StakeAbi,
      functionName: "stake",
      args: [shares],
    });
    pushActivity({ hash, kind: "M421", summary: "Stake M421", at: Date.now() });
    setMessage(`Stake ${shortAddr(hash)}`);
  }

  return (
    <section className="panel wide">
      <div className="m421-head">
        <img src="https://raw.githubusercontent.com/cannergtfo-commits/polygon-v2-amm/main/docs/m421.jpg" alt="Markarian 421" />
        <div>
          <p className="kicker">Markarian 421</p>
          <h2>Equal parts gold, gas, and a blazar bit.</h2>
          <p>The receipt is M421. The vault and the BZB emissions are the contracts already on Polygon. This page only talks to them.</p>
        </div>
      </div>
      {error && <p className="warn">{error}</p>}
      <div className="stat-row">
        <article>
          <b>{formatAmount(desk.bzb, 18, 2)}</b>
          <small>BZB · {formatUsd(usd.bzb)}</small>
        </article>
        <article>
          <b>{formatAmount(desk.wbtc, 8, 5)}</b>
          <small>WBTC · {formatUsd(usd.wbtc)}</small>
        </article>
        <article>
          <b>{formatAmount(desk.weth, 18, 4)}</b>
          <small>WETH · {formatUsd(usd.weth)}</small>
        </article>
        <article>
          <b>{formatAmount(desk.rate, 18, 0)}</b>
          <small>BZB / day to stakers</small>
        </article>
      </div>
      <p className="note">
        {formatAmount(desk.supply, 18, 2)} M421 supply · {formatAmount(desk.staked, 18, 2)} staked · you hold {formatAmount(desk.free, 18, 4)} free, {formatAmount(desk.mine, 18, 4)} staked, {formatAmount(desk.earned, 18, 4)} BZB earned.
      </p>
      <div className="liq three">
        <label>
          BZB
          <input value={amounts.bzb} onChange={(event) => setAmounts({ ...amounts, bzb: event.target.value })} />
        </label>
        <label>
          WBTC
          <input value={amounts.wbtc} onChange={(event) => setAmounts({ ...amounts, wbtc: event.target.value })} />
        </label>
        <label>
          WETH
          <input value={amounts.weth} onChange={(event) => setAmounts({ ...amounts, weth: event.target.value })} />
        </label>
      </div>
      <div className="actions">
        <Button className="cta" disabled={!connection.isConnected || isPending} onClick={() => deposit().catch((err: Error) => setMessage(err.message))}>
          Deposit basket
        </Button>
        <a href={scanAddress(registry.legacy.m421Vault)} target="_blank" rel="noreferrer">
          Vault {shortAddr(registry.legacy.m421Vault)}
        </a>
        <a href={scanAddress(registry.legacy.m421Staking)} target="_blank" rel="noreferrer">
          Staking {shortAddr(registry.legacy.m421Staking)}
        </a>
      </div>
      <div className="liq">
        <label>
          M421 to stake
          <input value={amounts.shares} onChange={(event) => setAmounts({ ...amounts, shares: event.target.value })} />
        </label>
        <div className="actions">
          <Button variant="outline" disabled={!connection.isConnected || isPending} onClick={() => stake().catch((err: Error) => setMessage(err.message))}>
            Stake M421
          </Button>
          <Button
            variant="outline"
            disabled={!connection.isConnected || isPending}
            onClick={() =>
              writeContractAsync({ address: registry.legacy.m421Staking as Address, abi: m421StakeAbi, functionName: "getReward" })
                .then((hash) => setMessage(`Claim ${shortAddr(hash)}`))
                .catch((err: Error) => setMessage(err.message))
            }
          >
            Claim BZB
          </Button>
          <Button
            variant="outline"
            disabled={!connection.isConnected || isPending}
            onClick={() =>
              writeContractAsync({ address: registry.legacy.m421Staking as Address, abi: m421StakeAbi, functionName: "exit" })
                .then((hash) => setMessage(`Exit ${shortAddr(hash)}`))
                .catch((err: Error) => setMessage(err.message))
            }
          >
            Exit
          </Button>
        </div>
      </div>
      {message && <p className="ok">{message}</p>}
      <p className="note">First deposit still has to be at least $10 and within 5% of equal value. The vault enforces that. Deviation here is passed as 5%.</p>
    </section>
  );
}
