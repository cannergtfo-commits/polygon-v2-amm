"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { useConnection, useWriteContract } from "wagmi";
import { Button } from "@/components/ui/button";
import { erc20Abi, stakingAbi } from "@/lib/abis";
import { pushActivity } from "@/lib/activity";
import { publicClient } from "@/lib/chain";
import { formatAmount, parseAmount, shortAddr } from "@/lib/format";
import { addresses, isDeployed, registry, scanAddress } from "@/lib/registry";
import { assertCanWrite } from "@/lib/preview";

const bzb = registry.tokens.find((token) => token.base)!;

export default function StakePage() {
  const connection = useConnection();
  const { writeContractAsync: sendWrite, isPending } = useWriteContract();
  const writeContractAsync = (async (args: Parameters<typeof sendWrite>[0]) => {
    assertCanWrite();
    if (connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    return sendWrite(args);
  }) as typeof sendWrite;
  const live = isDeployed(addresses.bzbStaking);
  const [amount, setAmount] = useState("100");
  const [state, setState] = useState({ staked: 0n, earned: 0n, total: 0n, daily: 0n, wallet: 0n, allowance: 0n });
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    let cancel = false;
    async function load() {
      const staking = addresses.bzbStaking as Address;
      const account = connection.address;
      const [total, daily, wallet, staked, earned, allowance] = await Promise.all([
        publicClient.readContract({ address: staking, abi: stakingAbi, functionName: "totalSupply" }),
        publicClient.readContract({ address: staking, abi: stakingAbi, functionName: "dailyRate" }),
        account
          ? publicClient.readContract({ address: bzb.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [account] })
          : Promise.resolve(0n),
        account ? publicClient.readContract({ address: staking, abi: stakingAbi, functionName: "balanceOf", args: [account] }) : Promise.resolve(0n),
        account ? publicClient.readContract({ address: staking, abi: stakingAbi, functionName: "earned", args: [account] }) : Promise.resolve(0n),
        account
          ? publicClient.readContract({ address: bzb.address as Address, abi: erc20Abi, functionName: "allowance", args: [account, staking] })
          : Promise.resolve(0n),
      ]);
      if (!cancel) setState({ staked, earned, total, daily, wallet, allowance });
    }
    load().catch((err: Error) => setMessage(err.message));
    return () => {
      cancel = true;
    };
  }, [live, connection.address, message]);

  async function stake() {
    assertCanWrite();
    if (!connection.address || connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    const parsed = parseAmount(amount, 18);
    if (!parsed) return;
    const staking = addresses.bzbStaking as Address;
    if (state.allowance < parsed) {
      const hash = await writeContractAsync({
        address: bzb.address as Address,
        abi: erc20Abi,
        functionName: "approve",
        args: [staking, parsed],
      });
      pushActivity({ hash, kind: "Approval", summary: "Approve BZB for staking", at: Date.now() });
      setMessage(`Approval ${shortAddr(hash)} sent. Stake again after it confirms.`);
      return;
    }
    const hash = await writeContractAsync({ address: staking, abi: stakingAbi, functionName: "stake", args: [parsed] });
    pushActivity({ hash, kind: "Stake", summary: `Stake ${amount} BZB`, at: Date.now() });
    setMessage(`Stake submitted ${shortAddr(hash)}`);
  }

  async function call(fn: "withdraw" | "getReward" | "exit") {
    assertCanWrite();
    if (connection.chainId !== 137) throw new Error("Connect on Polygon PoS.");
    const staking = addresses.bzbStaking as Address;
    const parsed = parseAmount(amount, 18);
    const hash = await writeContractAsync({
      address: staking,
      abi: stakingAbi,
      functionName: fn,
      args: fn === "withdraw" ? [parsed ?? 0n] : undefined,
    });
    pushActivity({ hash, kind: "Stake", summary: fn, at: Date.now() });
    setMessage(`${fn} submitted ${shortAddr(hash)}`);
  }

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>Stake BZB</h2>
        <span>{live ? shortAddr(addresses.bzbStaking) : "Not deployed"}</span>
      </div>
      <p>
        Stake BlazarBits and earn BlazarBits. The accounting is the Synthetix reward-per-token model: the owner refills BZB and streams it over a configurable duration. There is no lock and no stake fee. Withdrawals stay open if staking is paused.
      </p>
      <div className="stat-row">
        <article>
          <b>{live ? formatAmount(state.total, 18, 2) : "—"}</b>
          <small>BZB staked</small>
        </article>
        <article>
          <b>{live ? formatAmount(state.daily, 18, 2) : "—"}</b>
          <small>BZB / day</small>
        </article>
        <article>
          <b>{live ? formatAmount(state.earned, 18, 4) : "—"}</b>
          <small>Your earned</small>
        </article>
        <article>
          <b>{live ? formatAmount(state.staked, 18, 2) : "—"}</b>
          <small>Your stake</small>
        </article>
      </div>
      {!live && (
        <p className="note">
          The staking contract is in this repo and covered by tests. Put its address in <code>NEXT_PUBLIC_BZB_STAKING</code> after you deploy to a fork or Amoy. It does not replace M421 staking.
        </p>
      )}
      <div className="liq">
        <label>
          Amount
          <input value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <div className="actions">
          <Button className="cta" disabled={!live || !connection.isConnected || isPending} onClick={() => stake().catch((err: Error) => setMessage(err.message))}>
            {state.allowance < (parseAmount(amount, 18) ?? 0n) ? "Approve BZB" : "Stake"}
          </Button>
          <Button variant="outline" disabled={!live || !connection.isConnected || isPending} onClick={() => call("withdraw").catch((err: Error) => setMessage(err.message))}>
            Withdraw
          </Button>
          <Button variant="outline" disabled={!live || !connection.isConnected || isPending} onClick={() => call("getReward").catch((err: Error) => setMessage(err.message))}>
            Claim
          </Button>
          <Button variant="outline" disabled={!live || !connection.isConnected || isPending} onClick={() => call("exit").catch((err: Error) => setMessage(err.message))}>
            Exit
          </Button>
        </div>
        {message && <p className="ok">{message}</p>}
        <p className="note">
          Staking token and reward token are both{" "}
          <a href={scanAddress(bzb.address)} target="_blank" rel="noreferrer">
            BZB {shortAddr(bzb.address)}
          </a>
          . The owner cannot recover staked BZB or BZB already owed to stakers.
        </p>
      </div>
    </section>
  );
}
