"use client";

import { useEffect, useRef, useState } from "react";
import type { Candle, GeckoTokenView, TrendingToken } from "@/lib/gecko";
import { safeImageUrl } from "@/lib/gecko";
import { formatUsd } from "@/lib/format";

const frames = ["15m", "1h", "4h", "1d"];

function money(value: number | null) {
  if (value == null) return "—";
  return formatUsd(value);
}

function signed(value: number | null) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function initials(symbol: string) {
  const letters = symbol.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
  return letters || "?";
}

function TrendMark({ symbol, image }: { symbol: string; image: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = safeImageUrl(image);
  if (!src || failed) return <i aria-hidden="true">{initials(symbol)}</i>;
  return <img src={src} alt="" onError={() => setFailed(true)} />;
}

export function TrendingStrip({ onPick }: { onPick: (token: TrendingToken) => void }) {
  const [tokens, setTokens] = useState<TrendingToken[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/gecko/trending", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Trending unavailable");
        setTokens(body.tokens || []);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>Trending on Polygon</h2>
        <span>GeckoTerminal</span>
      </div>
      {error && <p className="warn">{error}</p>}
      {!error && tokens.length === 0 && <p className="note">Loading trending pools…</p>}
      <div className="trend-row" role="list">
        {tokens.map((token) => {
          const young = token.createdAt ? Date.now() - Date.parse(token.createdAt) < 14 * 86_400_000 : false;
          return (
            <button key={token.address} type="button" role="listitem" className="trend-card" aria-label={`Receive ${token.symbol}`} onClick={() => onPick(token)}>
              <span className="trend-id"><TrendMark symbol={token.symbol} image={token.image} /><b>{token.symbol}</b></span>
              <span className={token.change24h != null && token.change24h < 0 ? "warn-text" : "ok"}>{signed(token.change24h)}</span>
              <small>{money(token.priceUsd)}</small>
              {young && <em>New pool</em>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function TokenPanel({ address }: { address: string }) {
  const [view, setView] = useState<GeckoTokenView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [poolIndex, setPoolIndex] = useState(0);
  const [frame, setFrame] = useState("1h");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chartError, setChartError] = useState<string | null>(null);
  const [noCandles, setNoCandles] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError(null);
    fetch(`/api/gecko/token?address=${address}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Token data unavailable");
        setView(body as GeckoTokenView);
        setPoolIndex(0);
        setNoCandles(false);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => controller.abort();
  }, [address]);

  const selected = view?.pools[poolIndex] ?? null;

  useEffect(() => {
    if (!view) return;
    const controller = new AbortController();
    let cancelled = false;
    setChartError(null);
    setCandles([]);
    setNoCandles(false);
    (async () => {
      const ranked = view.pools.slice(0, 4);
      for (let index = 0; index < ranked.length; index += 1) {
        const item = ranked[index];
        try {
          const response = await fetch(`/api/gecko/ohlcv?pool=${item.address}&timeframe=${frame}&side=${item.base ? "base" : "quote"}`, { signal: controller.signal });
          const body = await response.json();
          if (!response.ok) continue;
          const rows = (body.candles || []) as Candle[];
          if (rows.length > 0) {
            if (!cancelled) {
              setPoolIndex(index);
              setCandles(rows);
            }
            return;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
        }
      }
      if (!cancelled) setNoCandles(true);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [view, frame]);

  useEffect(() => {
    const node = box.current;
    if (!node || candles.length === 0) return;
    let chart: { remove: () => void } | null = null;
    let dead = false;
    import("lightweight-charts").then((lib) => {
      if (dead || !box.current) return;
      const next = lib.createChart(box.current, {
        autoSize: true,
        height: 320,
        layout: { background: { type: lib.ColorType.Solid, color: "#030712" }, textColor: "#8aa3b8" },
        grid: { vertLines: { color: "rgba(62,224,255,0.08)" }, horzLines: { color: "rgba(62,224,255,0.08)" } },
        timeScale: { timeVisible: frame !== "1d", borderColor: "rgba(62,224,255,0.2)" },
        rightPriceScale: { borderColor: "rgba(62,224,255,0.2)" },
      });
      const series = next.addCandlestickSeries({
        upColor: "#3effb1",
        downColor: "#ff5d7a",
        wickUpColor: "#3effb1",
        wickDownColor: "#ff5d7a",
        borderVisible: false,
      });
      series.setData(candles.map((candle) => ({ time: candle.time as never, open: candle.open, high: candle.high, low: candle.low, close: candle.close })));
      next.timeScale().fitContent();
      chart = next;
    }).catch(() => setChartError("Chart library failed to load."));
    return () => {
      dead = true;
      chart?.remove();
    };
  }, [candles, frame]);

  const young = selected?.createdAt ? Date.now() - Date.parse(selected.createdAt) < 14 * 86_400_000 : false;
  const thin = (selected?.liquidityUsd ?? 0) < 10_000;

  return (
    <section className="panel wide token-panel">
      <div className="panel-head">
        <h2>{view ? `${view.symbol} on GeckoTerminal` : "Token"}</h2>
        {view && (
          <span>
            <a href={view.geckoUrl} target="_blank" rel="noreferrer">GeckoTerminal</a>
            {" · "}
            <a href={view.scanUrl} target="_blank" rel="noreferrer">Polygonscan</a>
          </span>
        )}
      </div>
      {error && <p className="warn">{error}</p>}
      {view?.stale && <p className="note">Showing a cached GeckoTerminal response while the rate limit cools down.</p>}
      {view?.error && <p className="warn">{view.error}</p>}
      {view && (
        <>
          <div className="stat-row">
            <article><b>{money(view.priceUsd)}</b><small>Price</small></article>
            <article><b className={view.change24h != null && view.change24h < 0 ? "warn-text" : "ok"}>{signed(view.change24h)}</b><small>24h</small></article>
            <article><b>{money(view.volume24hUsd)}</b><small>24h volume</small></article>
            <article><b>{money(view.liquidityUsd)}</b><small>Liquidity</small></article>
            <article><b>{money(view.fdvUsd)}</b><small>FDV</small></article>
            <article><b>{view.marketCapUsd == null ? "—" : money(view.marketCapUsd)}</b><small>Market cap</small></article>
            <article><b>{view.poolCount}</b><small>Pools</small></article>
            <article><b>{view.holders == null ? "—" : view.holders.toLocaleString()}</b><small>Holders</small></article>
          </div>
          {selected && (
            <p className="note">
              Chart pool <a href={`https://www.geckoterminal.com/polygon_pos/pools/${selected.address}`} target="_blank" rel="noreferrer">{selected.name}</a>
              {selected.dex ? ` · ${selected.dex}` : ""}. One pool is chosen automatically: 70% liquidity and 30% age. Swap quotes still search every allowlisted venue.
            </p>
          )}
          {(young || thin) && (
            <p className="warn">
              {young ? "This pool is under 14 days old. " : ""}
              {thin ? "Liquidity is under $10,000. " : ""}
              Treat the price as fragile.
            </p>
          )}
          <div className="slip">
            {frames.map((item) => (
              <button key={item} type="button" className={frame === item ? "on" : ""} onClick={() => setFrame(item)}>{item}</button>
            ))}
          </div>
          {chartError && <p className="warn">{chartError}</p>}
          <div ref={box} className="chart-box" />
          {noCandles && <p className="note">No candles were published for the scored pools.</p>}
          {candles.length === 0 && !chartError && !noCandles && <p className="note">Waiting for candles…</p>}
        </>
      )}
    </section>
  );
}
