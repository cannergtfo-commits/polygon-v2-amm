"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address } from "viem";
import { useConnection, useWriteContract } from "wagmi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { erc20Abi, feeRouterAbi } from "@/lib/abis";
import { pushActivity } from "@/lib/activity";
import { publicClient } from "@/lib/chain";
import { safeImageUrl } from "@/lib/gecko";
import { quoteIsStale, quoteRequestKey, selectBuyToken, slippageBpsOf } from "@/lib/trade-selection";
import { approvalPlan, buildSwapEnvelope, confirmChoice, guardedSend, type SwapEnvelope } from "@/lib/review-envelope";
import { bpsLabel, formatAmount, formatUsd, parseAmount, shortAddr } from "@/lib/format";
import { addresses, isDeployed, isNative, registry, scanAddress, scanTx, tokenByAddress } from "@/lib/registry";
import type { QuoteResponse, TokenMeta } from "@/lib/types";
import type { TrendingToken } from "@/lib/gecko";
import { TokenPanel, TrendingStrip } from "@/components/token-panel";

const listed = registry.tokens;

function TokenFace({ token }: { token: TokenMeta }) {
  return (
    <span className="token-face">
      {token.logo?.startsWith("https://") || token.logo?.startsWith("/") ? <img src={token.logo} alt="" /> : <i />}
      {token.symbol}
    </span>
  );
}

export function SwapDesk() {
  const connection = useConnection();
  const { writeContractAsync: sendWrite, isPending } = useWriteContract();
  const writeContractAsync = (async (args: Parameters<typeof sendWrite>[0]) => {
    if (connection.chainId !== 137) throw new Error("Switch to Polygon PoS before signing.");
    return guardedSend(() => sendWrite(args));
  }) as typeof sendWrite;
  const [sell, setSell] = useState<TokenMeta>(listed.find((token) => token.base)!);
  const [buy, setBuy] = useState<TokenMeta>(listed.find((token) => token.symbol === "USDC")!);
  const [amount, setAmount] = useState("1000");
  const [custom, setCustom] = useState("");
  const [customSide, setCustomSide] = useState<"sell" | "buy">("sell");
  const [slippage, setSlippage] = useState("0.50");
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quotedAt, setQuotedAt] = useState(0);
  const [quoteKey, setQuoteKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [balances, setBalances] = useState({ sell: 0n, buy: 0n, allowance: 0n });
  const [gasUnits, setGasUnits] = useState<bigint | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [chartSide, setChartSide] = useState<"sell" | "buy">("sell");
  const [txError, setTxError] = useState<string | null>(null);
  const [impactAck, setImpactAck] = useState(false);
  const [slipAck, setSlipAck] = useState(false);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [swapSim, setSwapSim] = useState<string | null>(null);
  const [approvalSim, setApprovalSim] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<SwapEnvelope | null>(null);

  const parsed = useMemo(() => parseAmount(amount, sell.decimals), [amount, sell.decimals]);
  const ready = isDeployed(addresses.feeRouter);
  const slippageBps = slippageBpsOf(slippage);
  const requestKey = quoteRequestKey({
    chainId: connection.chainId,
    account: connection.address,
    sell: sell.address,
    buy: buy.address,
    amount: parsed?.toString() ?? "",
    slippageBps: slippageBps ?? -1,
  });
  const minOut = quote?.best && slippageBps != null ? (BigInt(quote.best.amountOut) * BigInt(Math.max(0, 10_000 - slippageBps))) / 10_000n : 0n;
  const highImpact = (frozen?.quote.priceImpactBps ?? 0) > 1500;

  useEffect(() => {
    setQuote(null);
    setQuotedAt(0);
    setQuoteKey("");
    setOpen(false);
    if (!parsed || parsed === 0n || slippageBps == null) {
      setError(slippageBps == null ? "Slippage must be from 0.01% to 5%." : null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/quote", {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tokenIn: sell.address, tokenOut: buy.address, amountIn: parsed.toString() }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Quote failed");
        setQuote(body as QuoteResponse);
        setQuotedAt(Date.now());
        setQuoteKey(requestKey);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setQuote(null);
        setQuotedAt(0);
        setQuoteKey("");
        setError(err instanceof Error ? err.message : "Quote failed");
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestKey, parsed, slippageBps, quoteNonce]);

  useEffect(() => {
    let cancel = false;
    async function load() {
      if (!connection.address) {
        setBalances({ sell: 0n, buy: 0n, allowance: 0n });
        return;
      }
      const account = connection.address;
      const sellBal = isNative(sell.address)
        ? await publicClient.getBalance({ address: account })
        : await publicClient.readContract({ address: sell.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
      const buyBal = isNative(buy.address)
        ? await publicClient.getBalance({ address: account })
        : await publicClient.readContract({ address: buy.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
      let allowance = 0n;
      if (!isNative(sell.address) && ready) {
        allowance = await publicClient.readContract({
          address: sell.address as Address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, addresses.feeRouter as Address],
        });
      }
      if (!cancel) setBalances({ sell: sellBal, buy: buyBal, allowance });
    }
    load().catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [connection.address, sell.address, buy.address, ready, txHash]);

  useEffect(() => {
    if (!open || !frozen || !connection.address || !ready) {
      setGasUnits(null);
      setSwapSim(null);
      setApprovalSim(null);
      return;
    }
    const reviewed = frozen;
    let cancel = false;
    setGasUnits(null);
    setSwapSim(null);
    setApprovalSim(null);
    async function estimateOne(to: Address, data: `0x${string}`, value: bigint) {
      return publicClient.estimateGas({ account: connection.address!, to, data, value });
    }
    async function estimate() {
      const swap = estimateOne(addresses.feeRouter as Address, reviewed.data, reviewed.value)
        .then((gas) => {
          if (!cancel) {
            setGasUnits(gas);
            setSwapSim(reviewed.fingerprint);
          }
        })
        .catch(() => {
          if (!cancel) setSwapSim(null);
        });
      const approval = reviewed.approval
        ? estimateOne(reviewed.approval.token, reviewed.approval.data, 0n)
            .then(() => {
              if (!cancel) setApprovalSim(reviewed.approval!.fingerprint);
            })
            .catch(() => {
              if (!cancel) setApprovalSim(null);
            })
        : Promise.resolve();
      await Promise.all([swap, approval]);
    }
    estimate();
    return () => {
      cancel = true;
    };
  }, [open, frozen, connection.address, ready]);

  async function applyCustom() {
    const known = tokenByAddress(custom);
    if (known) {
      const next = { address: known.address, symbol: known.symbol, name: known.name, decimals: known.decimals, logo: known.logo };
      if (customSide === "sell") setSell(next);
      else setBuy(next);
      setCustom("");
      return;
    }
    const response = await fetch("/api/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokenIn: customSide === "sell" ? custom : sell.address,
        tokenOut: customSide === "buy" ? custom : buy.address,
        amountIn: "1",
      }),
    });
    const body = await response.json();
    if (!response.ok && !body.tokenIn) {
      setError(body.error || "That address is not a token");
      return;
    }
    const meta = (customSide === "sell" ? body.tokenIn : body.tokenOut) as TokenMeta | undefined;
    if (!meta) {
      setError(body.error || "Could not read that token");
      return;
    }
    if (customSide === "sell") setSell(meta);
    else setBuy(meta);
    setCustom("");
  }

  async function send(kind: "approve" | "reset" | "swap") {
    if (!connection.address || !frozen) return;
    if (connection.chainId !== 137) {
      setTxError("Switch to Polygon PoS before signing.");
      return;
    }
    if (frozen.key !== requestKey) {
      setTxError("This quote does not match the current trade. Wait for a new price.");
      setOpen(false);
      return;
    }
    if (kind === "swap" && (swapSim !== frozen.fingerprint || BigInt(Math.floor(Date.now() / 1000) + 15) > frozen.deadline)) {
      setTxError("This review expired or its simulation does not match. Open it again.");
      setOpen(false);
      return;
    }
    if ((kind === "approve" || kind === "reset") && (!frozen.approval || approvalSim !== frozen.approval.fingerprint || frozen.approval.kind !== kind)) {
      setTxError("The approval simulation does not match this review.");
      return;
    }
    setTxError(null);
    try {
      if ((kind === "reset" || kind === "approve") && frozen.approval) {
        const hash = await writeContractAsync({
          address: frozen.approval.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [frozen.approval.spender, frozen.approval.amount],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Approval failed");
        const allowance = await publicClient.readContract({
          address: frozen.approval.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [connection.address, frozen.approval.spender],
        });
        pushActivity({ hash, kind: "Approval", summary: `${kind === "reset" ? "Reset" : "Approve"} ${sell.symbol} for the fee router`, at: Date.now() });
        setTxHash(hash);
        setOpen(false);
        setFrozen(null);
        setSwapSim(null);
        setApprovalSim(null);
        setQuote(null);
        setQuotedAt(0);
        setQuoteKey("");
        setQuoteNonce((value) => value + 1);
        setBalances((prev) => ({ ...prev, allowance }));
        return;
      }
      const hash = await writeContractAsync({
        address: addresses.feeRouter as Address,
        abi: feeRouterAbi,
        functionName: "swap",
        args: [
          frozen.sell,
          frozen.buy,
          frozen.amountIn,
          frozen.minOut,
          frozen.recipient,
          frozen.deadline,
          frozen.unwrap,
          frozen.calls,
          frozen.sweeps,
        ],
        value: frozen.value,
      });
      pushActivity({
        hash,
        kind: "Swap",
        summary: `${amount} ${sell.symbol} → ${formatAmount(BigInt(frozen.quote.best?.amountOut ?? "0"), buy.decimals)} ${buy.symbol}`,
        at: Date.now(),
      });
      setTxHash(hash);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : "Transaction rejected");
    }
  }

  const gasDisplay = swapSim === frozen?.fingerprint ? gasUnits : null;
  const gasWei = gasDisplay && frozen ? gasDisplay * BigInt(frozen.quote.gasPrice || "0") : 0n;
  const gasUsd = gasDisplay && frozen?.quote.polUsdE8 ? formatUsd(Number((gasWei * BigInt(frozen.quote.polUsdE8)) / 10n ** 18n) / 1e8) : null;
  const choice = confirmChoice({
    ready,
    chainId: connection.chainId,
    connected: connection.isConnected,
    loading,
    pending: isPending,
    requestKey,
    envelope: frozen,
    approvalSim,
    swapSim,
    highImpact,
    impactAck,
    slipAck,
  });

  async function pickTrending(token: TrendingToken) {
    try {
      const response = await fetch(`/api/gecko/token?address=${token.address}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load that token");
      const next = {
        address: body.address as string,
        symbol: body.symbol as string,
        name: body.name as string,
        decimals: body.decimals ?? 18,
        logo: safeImageUrl(body.image) || undefined,
      };
      const choice = selectBuyToken(sell, buy, next, listed, registry.wpol);
      if (!choice) {
        setError("That token matches both sides. Pick a different pay token first.");
        return;
      }
      setSell(choice.pay);
      setBuy(choice.buy);
      setQuote(null);
      setQuotedAt(0);
      setChartSide("buy");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that token");
    }
  }

  return (
    <div className="desk-stack">
    <div className="layout">
      <section className="hero-copy">
        <p className="kicker">Aggregator desk</p>
        <h1>Best price across the blazar and the rest of Polygon.</h1>
        <p>
          One quote checks BlazarSwap, QuickSwap v2 and v3, Uniswap v3, SushiSwap, and ApeSwap, including multi-hop and split routes.
          External routes pay {bpsLabel(registry.fee.aggregatorBps)} once on the principal that leaves BlazarSwap pools. A later hop does not pay it again. A BlazarSwap-only fill pays the pool fee alone.
        </p>
        <div className="stat-row">
          <article>
            <b>0.05%</b>
            <small>Aggregator fee</small>
          </article>
          <article>
            <b>0.25%</b>
            <small>Owner fee cap</small>
          </article>
          <article>
            <b>BZB</b>
            <small>Always routable</small>
          </article>
        </div>
      </section>

      <section className="panel desk">
        <div className="panel-head">
          <h2>Swap</h2>
          <Badge variant="outline">Polygon · 137</Badge>
        </div>

        <label className="token-box">
          <div className="row">
            <span>You pay</span>
            <span>{connection.address ? `Balance ${formatAmount(balances.sell, sell.decimals, 4)}` : "Wallet not connected"}</span>
          </div>
          <div className="row input-row">
            <input className="amount" value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} />
            <TokenFace token={sell} />
          </div>
        </label>

        <button
          className="flip"
          type="button"
          onClick={() => {
            setSell(buy);
            setBuy(sell);
          }}
          aria-label="Flip tokens"
        >
          ↕
        </button>

        <div className="token-box">
          <div className="row">
            <span>You receive</span>
            <span>{loading ? "Pricing…" : quote?.best ? `Min ${formatAmount(minOut, buy.decimals)}` : "—"}</span>
          </div>
          <div className="row input-row">
            <div className="amount out">{quote?.best ? formatAmount(BigInt(quote.best.amountOut), buy.decimals) : loading ? "…" : "0"}</div>
            <TokenFace token={buy} />
          </div>
        </div>

        <div className="picks">
          {listed.map((token) => (
            <button
              key={token.address}
              type="button"
              className={sell.address.toLowerCase() === token.address.toLowerCase() || buy.address.toLowerCase() === token.address.toLowerCase() ? "on" : ""}
              onClick={() => {
                if (sell.address.toLowerCase() === token.address.toLowerCase()) return;
                setBuy({ address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals, logo: token.logo });
              }}
            >
              {token.symbol}
            </button>
          ))}
        </div>

        <div className="paste">
          <Input value={custom} placeholder="Paste any ERC-20 address" onChange={(event) => setCustom(event.target.value.trim())} />
          <Button type="button" variant="outline" onClick={() => setCustomSide(customSide === "sell" ? "buy" : "sell")}>
            {customSide === "sell" ? "Set sell" : "Set buy"}
          </Button>
          <Button type="button" onClick={applyCustom} disabled={!custom}>
            Load
          </Button>
        </div>

        <div className="slip">
          <span>Slippage</span>
          {["0.10", "0.50", "1.00"].map((value) => (
            <button key={value} type="button" className={slippage === value ? "on" : ""} onClick={() => setSlippage(value)}>
              {value}%
            </button>
          ))}
          <input value={slippage} onChange={(event) => setSlippage(event.target.value)} />
        </div>

        <div className="meta">
          <div>
            <span>Route</span>
            <b>{quote?.best?.label ?? (loading ? "Searching venues…" : "No route yet")}</b>
          </div>
          <div>
            <span>Aggregator fee</span>
            <b>
              {quote ? `${formatAmount(BigInt(quote.feeAmount), sell.decimals)} ${sell.symbol}` : "—"} · {bpsLabel(quote?.feeBps ?? registry.fee.aggregatorBps)}
            </b>
          </div>
          <div>
            <span>Price impact</span>
            <b className={(quote?.priceImpactBps ?? 0) > 200 ? "warn-text" : ""}>
              {quote?.priceImpactBps == null ? "—" : `${(quote.priceImpactBps / 100).toFixed(2)}%`}
            </b>
          </div>
          <div>
            <span>Gas</span>
            <b>
              {gasDisplay ? `${formatAmount(gasWei, 18, 5)} POL` : "—"}
              {gasUsd ? ` · ${gasUsd}` : ""}
            </b>
          </div>
        </div>

        {quote?.alternatives?.length ? (
          <div className="alts">
            {quote.alternatives.map((route) => (
              <div key={route.id}>
                <span>{route.label}</span>
                <b>
                  {formatAmount(BigInt(route.amountOut), buy.decimals)} {buy.symbol}
                </b>
              </div>
            ))}
          </div>
        ) : null}

        {error && <p className="warn">{error}</p>}
        {!ready && <p className="note">Quotes are live. The fee router address is still empty, so signing a swap stays disabled until you deploy on a fork or Amoy.</p>}

        <Button
          className="cta full"
          disabled={!quote?.best || !parsed || loading}
          onClick={() => {
            if (!quote?.best || !parsed || loading || quoteKey !== requestKey || slippageBps == null || quoteIsStale(quotedAt, Date.now()) || minOut === 0n) {
              setError("This quote is older than 45 seconds. Wait for a fresh price.");
              return;
            }
            setTxHash(null);
            setTxError(null);
            setImpactAck(false);
            setSlipAck(false);
            setSwapSim(null);
            setApprovalSim(null);
            const sellTo = (isNative(sell.address) ? "0x0000000000000000000000000000000000000000" : sell.address) as Address;
            const buyTo = (isNative(buy.address) ? registry.wpol : buy.address) as Address;
            const approval = !connection.address || isNative(sell.address)
              ? null
              : balances.allowance > 0n && balances.allowance < parsed
                ? approvalPlan("reset", sell.address as Address, addresses.feeRouter as Address, 0n, connection.address)
                : balances.allowance < parsed
                  ? approvalPlan("approve", sell.address as Address, addresses.feeRouter as Address, parsed, connection.address)
                  : null;
            try {
              setFrozen(buildSwapEnvelope({
                key: requestKey,
                quote,
                feeRouter: addresses.feeRouter as Address,
                sell: sellTo,
                buy: buyTo,
                amountIn: parsed,
                minOut,
                slippageBps,
                recipient: (connection.address ?? "0x0000000000000000000000000000000000000000") as Address,
                unwrap: isNative(buy.address),
                value: isNative(sell.address) ? parsed : 0n,
                approval,
                nowSeconds: Math.floor(Date.now() / 1000),
              }));
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not freeze this review.");
              return;
            }
            setOpen(true);
          }}
        >
          {loading ? "Reading pools…" : quote?.best ? "Review route" : "No route"}
        </Button>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="review">
          <DialogHeader>
            <DialogTitle>Confirm swap</DialogTitle>
            <DialogDescription>Nothing is signed until you press the button below.</DialogDescription>
          </DialogHeader>
          {frozen?.quote.best && (
            <div className="review-body">
              <p className="route-title">{frozen.quote.best.label}</p>
              {frozen.quote.best.steps.map((step, index) => (
                <div className="hop" key={`${step.pool ?? step.venue}-${index}`}>
                  <b>
                    {index + 1}. {step.venue}
                  </b>
                  <span>
                    {step.kind === "v2" ? `pool fee ${bpsLabel(step.feeBps ?? 30)}` : step.kind === "v3" ? `fee tier ${bpsLabel((step.feeTier ?? 0) / 100)}` : "dynamic fee"}
                    {step.bps !== 10_000 ? ` · ${step.bps / 100}% of input` : ""}
                  </span>
                  {step.pool && (
                    <a href={scanAddress(step.pool)} target="_blank" rel="noreferrer">
                      Pool {shortAddr(step.pool)}
                    </a>
                  )}
                  {step.router && (
                    <a href={scanAddress(step.router)} target="_blank" rel="noreferrer">
                      Router {shortAddr(step.router)}
                    </a>
                  )}
                  {step.factory && (
                    <a href={scanAddress(step.factory)} target="_blank" rel="noreferrer">
                      Factory {shortAddr(step.factory)}
                    </a>
                  )}
                </div>
              ))}
              <div className="meta tight">
                <div>
                  <span>You pay</span>
                  <b>
                    {amount} {sell.symbol}
                  </b>
                </div>
                <div>
                  <span>Aggregator fee</span>
                  <b>
                    {formatAmount(BigInt(frozen.quote.feeAmount), sell.decimals)} {sell.symbol} to {shortAddr(registry.fee.recipient)}
                  </b>
                </div>
                <div>
                  <span>Quoted output</span>
                  <b>
                    {formatAmount(BigInt(frozen.quote.best.amountOut), buy.decimals)} {buy.symbol}
                  </b>
                </div>
                <div>
                  <span>Min received</span>
                  <b>
                    {formatAmount(frozen.minOut, buy.decimals)} {buy.symbol} at {(frozen.slippageBps / 100).toFixed(2)}% slippage
                  </b>
                </div>
                <div>
                  <span>Price impact</span>
                  <b>{frozen.quote.priceImpactBps == null ? "not estimated" : `${(frozen.quote.priceImpactBps / 100).toFixed(2)}%`}</b>
                </div>
                <div>
                  <span>Gas</span>
                  <b>
                    {gasDisplay?.toString() ?? "—"} units
                    {gasUsd ? ` · ${gasUsd}` : ""}
                  </b>
                </div>
                <div>
                  <span>Approval</span>
                  <b>
                    {frozen.approval?.kind === "reset"
                      ? `Reset ${sell.symbol} to 0, then review the approval.`
                      : frozen.approval?.kind === "approve"
                        ? `Approve exactly ${formatAmount(frozen.approval.amount, sell.decimals)} ${sell.symbol}`
                        : isNative(sell.address)
                          ? "None. POL is sent with the transaction."
                          : "Allowance already covers this amount"}
                  </b>
                </div>
              </div>
              <div className="addrs">
                <a href={scanAddress(ready ? addresses.feeRouter : registry.fee.recipient)} target="_blank" rel="noreferrer">
                  Fee router {ready ? shortAddr(addresses.feeRouter) : "not deployed"}
                </a>
                <a href={scanAddress(registry.fee.recipient)} target="_blank" rel="noreferrer">
                  Fee recipient {shortAddr(registry.fee.recipient)}
                </a>
                <a href={scanAddress(isNative(sell.address) ? registry.wpol : sell.address)} target="_blank" rel="noreferrer">
                  {sell.symbol} {shortAddr(isNative(sell.address) ? registry.wpol : sell.address)}
                </a>
                <a href={scanAddress(isNative(buy.address) ? registry.wpol : buy.address)} target="_blank" rel="noreferrer">
                  {buy.symbol} {shortAddr(isNative(buy.address) ? registry.wpol : buy.address)}
                </a>
              </div>
              {frozen.quote.notes.map((note) => (
                <p className="note" key={note}>
                  {note}
                </p>
              ))}
              {highImpact && (
                <label className="ack">
                  <input type="checkbox" checked={impactAck} onChange={(event) => setImpactAck(event.target.checked)} />
                  Price impact is above 15%. I still want this route.
                </label>
              )}
              {frozen.slippageBps > 100 && (
                <label className="ack">
                  <input type="checkbox" checked={slipAck} onChange={(event) => setSlipAck(event.target.checked)} />
                  Slippage is above 1%. I accept that minimum.
                </label>
              )}
              {connection.isConnected && ready && frozen.approval && approvalSim !== frozen.approval.fingerprint && (
                <p className="warn">Approval simulation failed. That allowance step will not be sent.</p>
              )}
              {connection.isConnected && ready && !frozen.approval && swapSim !== frozen.fingerprint && (
                <p className="warn">Swap simulation failed. This route will not be signed.</p>
              )}
              {connection.isConnected && ready && frozen.approval && approvalSim === frozen.approval.fingerprint && swapSim !== frozen.fingerprint && (
                <p className="note">The swap is simulated again after this allowance is confirmed.</p>
              )}
              {txHash && (
                <p className="ok">
                  Submitted <a href={scanTx(txHash)} target="_blank" rel="noreferrer">{shortAddr(txHash)}</a>
                </p>
              )}
              {txError && <p className="warn">{txError}</p>}
              {!connection.isConnected ? (
                <p className="note">Connect a wallet to sign. The route above is the one that would be sent.</p>
              ) : connection.chainId !== 137 ? (
                <p className="warn">Switch the wallet to Polygon PoS before signing.</p>
              ) : (
                <Button
                  className="cta full"
                  disabled={!choice.enabled}
                  onClick={() => {
                    if (choice.kind === "approve" || choice.kind === "reset" || choice.kind === "swap") send(choice.kind);
                  }}
                >
                  {!ready
                    ? "Router not deployed"
                    : isPending
                      ? "Waiting for wallet…"
                      : choice.kind === "reset"
                        ? `Reset ${sell.symbol} allowance`
                        : choice.kind === "approve"
                          ? `Approve ${sell.symbol}`
                          : "Swap"}
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    <TrendingStrip onPick={pickTrending} />
    <div className="slip">
      <button type="button" className={chartSide === "sell" ? "on" : ""} onClick={() => setChartSide("sell")}>Chart {sell.symbol}</button>
      <button type="button" className={chartSide === "buy" ? "on" : ""} onClick={() => setChartSide("buy")}>Chart {buy.symbol}</button>
    </div>
    <TokenPanel address={isNative((chartSide === "sell" ? sell : buy).address) ? registry.wpol : (chartSide === "sell" ? sell : buy).address} />
    </div>
  );
}
