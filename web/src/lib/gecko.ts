import { isNative, registry } from "@/lib/registry";
import { scorePools } from "@/lib/pool-score";

const ROOT = "https://api.geckoterminal.com/api/v2";
const NETWORK = "polygon_pos";
const FRESH_MS = 45_000;
const MAX_PER_MINUTE = 28;

type CacheEntry = { at: number; body: unknown };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ body: unknown; stale: boolean }>>();
const hits: number[] = [];

export type GeckoPool = {
  address: string;
  name: string;
  dex: string;
  liquidityUsd: number;
  volume24hUsd: number;
  change24h: number | null;
  createdAt: string | null;
  priceUsd: number | null;
  base: boolean;
  score: number;
};

export type GeckoTokenView = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image: string | null;
  priceUsd: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  poolCount: number;
  holders: number | null;
  pools: GeckoPool[];
  bestPool: string | null;
  geckoUrl: string;
  scanUrl: string;
  stale: boolean;
  error: string | null;
};

export type TrendingToken = {
  address: string;
  symbol: string;
  name: string;
  pool: string;
  poolName: string;
  priceUsd: number | null;
  change24h: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  createdAt: string | null;
  image: string | null;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allow(): boolean {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) hits.shift();
  if (hits.length >= MAX_PER_MINUTE) return false;
  hits.push(now);
  return true;
}

async function gecko(path: string): Promise<{ body: unknown; stale: boolean }> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < FRESH_MS) return { body: hit.body, stale: false };
  const pending = inflight.get(path);
  if (pending) return pending;
  const job = fetchGecko(path, hit).finally(() => inflight.delete(path));
  inflight.set(path, job);
  return job;
}

async function fetchGecko(path: string, hit: CacheEntry | undefined): Promise<{ body: unknown; stale: boolean }> {
  const stale = () => {
    if (!hit) throw new Error("GeckoTerminal rate limit. Try again in a minute.");
    return { body: hit.body, stale: true };
  };
  if (!allow()) {
    await sleep(1200);
    if (!allow()) return stale();
  }
  const response = await fetch(`${ROOT}${path}`, {
    headers: { accept: "application/json", "user-agent": "BlazarSwap/0.1" },
    cache: "no-store",
  });
  if (response.status === 429) return stale();
  if (!response.ok) throw new Error(`GeckoTerminal returned ${response.status}`);
  const body = await response.json();
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(path, { at: Date.now(), body });
  return { body, stale: false };
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalToken(address: string) {
  return isNative(address) ? registry.wpol : address;
}

export async function loadToken(address: string): Promise<GeckoTokenView> {
  const token = canonicalToken(address).toLowerCase();
  const [tokenRes, poolRes, infoRes] = await Promise.all([
    gecko(`/networks/${NETWORK}/tokens/${token}`),
    gecko(`/networks/${NETWORK}/tokens/${token}/pools?page=1`),
    gecko(`/networks/${NETWORK}/tokens/${token}/info`).catch(() => ({ body: null, stale: false })),
  ]);
  const tokenBody = asRecord(asRecord(tokenRes.body).data);
  const attrs = asRecord(tokenBody.attributes);
  const poolRows = Array.isArray(asRecord(poolRes.body).data) ? (asRecord(poolRes.body).data as unknown[]) : [];
  const now = Date.now();
  const facts = poolRows.map((row) => {
    const item = asRecord(row);
    const poolAttrs = asRecord(item.attributes);
    const created = typeof poolAttrs.pool_created_at === "string" ? poolAttrs.pool_created_at : null;
    return {
      row: item,
      address: String(poolAttrs.address || ""),
      liquidityUsd: num(poolAttrs.reserve_in_usd) ?? 0,
      ageSeconds: created ? Math.max(0, (now - Date.parse(created)) / 1000) : 0,
    };
  });
  const ranked = scorePools(facts);
  const byAddress = new Map(facts.map((fact) => [fact.address.toLowerCase(), fact]));
  const pools: GeckoPool[] = ranked.map((scored) => {
    const fact = byAddress.get(scored.address.toLowerCase());
    const item = fact?.row ?? {};
    const poolAttrs = asRecord(item.attributes);
    const baseId = String(asRecord(asRecord(asRecord(item.relationships).base_token).data).id || "");
    const base = baseId.toLowerCase().endsWith(token);
    const change = num(asRecord(poolAttrs.price_change_percentage).h24);
    const dex = String(asRecord(asRecord(asRecord(item.relationships).dex).data).id || "");
    return {
      address: scored.address,
      name: String(poolAttrs.name || scored.address),
      dex,
      liquidityUsd: scored.liquidityUsd,
      volume24hUsd: num(asRecord(poolAttrs.volume_usd).h24) ?? 0,
      change24h: change,
      createdAt: typeof poolAttrs.pool_created_at === "string" ? poolAttrs.pool_created_at : null,
      priceUsd: num(poolAttrs.base_token_price_usd),
      base,
      score: scored.score,
    };
  });
  const best = pools[0] ?? null;
  const infoAttrs = asRecord(asRecord(asRecord(infoRes.body).data).attributes);
  const holders = num(asRecord(infoAttrs.holders).count);
  const volume = num(asRecord(attrs.volume_usd).h24);
  return {
    address: token,
    name: String(attrs.name || "Token"),
    symbol: String(attrs.symbol || "TOKEN"),
    decimals: num(attrs.decimals) ?? 18,
    image: safeImageUrl(attrs.image_url),
    priceUsd: num(attrs.price_usd) ?? best?.priceUsd ?? null,
    change24h: best?.change24h ?? null,
    volume24hUsd: volume,
    liquidityUsd: num(attrs.total_reserve_in_usd) ?? best?.liquidityUsd ?? null,
    fdvUsd: num(attrs.fdv_usd),
    marketCapUsd: num(attrs.market_cap_usd),
    poolCount: pools.length,
    holders,
    pools,
    bestPool: best?.address ?? null,
    geckoUrl: `https://www.geckoterminal.com/polygon_pos/tokens/${token}`,
    scanUrl: `${registry.explorer}/token/${token}`,
    stale: tokenRes.stale || poolRes.stale,
    error: pools.length ? null : "No GeckoTerminal pools for this token.",
  };
}

export async function loadCandles(pool: string, timeframe: string, tokenSide: "base" | "quote"): Promise<Candle[]> {
  const frames: Record<string, { path: string; aggregate: number }> = {
    "15m": { path: "minute", aggregate: 15 },
    "1h": { path: "hour", aggregate: 1 },
    "4h": { path: "hour", aggregate: 4 },
    "1d": { path: "day", aggregate: 1 },
  };
  const frame = frames[timeframe] ?? frames["1h"];
  const { body } = await gecko(
    `/networks/${NETWORK}/pools/${pool}/ohlcv/${frame.path}?aggregate=${frame.aggregate}&limit=150&currency=usd&token=${tokenSide}`,
  );
  const list = asRecord(asRecord(asRecord(body).data).attributes).ohlcv_list;
  if (!Array.isArray(list)) return [];
  const candles: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    candles.push({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0),
    });
  }
  const byTime = new Map<number, Candle>();
  for (const candle of candles.sort((a, b) => a.time - b.time)) byTime.set(candle.time, candle);
  return [...byTime.values()];
}

export async function loadTrending(): Promise<TrendingToken[]> {
  const { body } = await gecko(`/networks/${NETWORK}/trending_pools?page=1`);
  const rows = Array.isArray(asRecord(body).data) ? (asRecord(body).data as unknown[]) : [];
  const seen = new Set<string>();
  const tokens: TrendingToken[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    const attrs = asRecord(item.attributes);
    const baseId = String(asRecord(asRecord(asRecord(item.relationships).base_token).data).id || "");
    const address = baseId.replace(/^polygon_pos_/i, "");
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const name = String(attrs.name || "");
    const symbol = name.split("/")[0]?.trim() || "TOKEN";
    tokens.push({
      address,
      symbol,
      name,
      pool: String(attrs.address || ""),
      poolName: name,
      priceUsd: num(attrs.base_token_price_usd),
      change24h: num(asRecord(attrs.price_change_percentage).h24),
      liquidityUsd: num(attrs.reserve_in_usd),
      volume24hUsd: num(asRecord(attrs.volume_usd).h24),
      createdAt: typeof attrs.pool_created_at === "string" ? attrs.pool_created_at : null,
      image: null,
    });
    if (tokens.length >= 12) break;
  }
  if (tokens.length) {
    try {
      const { body } = await gecko(`/networks/${NETWORK}/tokens/multi/${tokens.map((token) => token.address).join(",")}`);
      const rows = Array.isArray(asRecord(body).data) ? (asRecord(body).data as unknown[]) : [];
      const images = new Map<string, string>();
      for (const row of rows) {
        const item = asRecord(row);
        const attrs = asRecord(item.attributes);
        const address = String(attrs.address || "");
        const image = safeImageUrl(attrs.image_url);
        if (address && image) images.set(address.toLowerCase(), image);
      }
      for (const token of tokens) token.image = images.get(token.address.toLowerCase()) ?? null;
    } catch {
      // Initials stand in when the image lookup is rate limited.
    }
  }
  return tokens;
}
