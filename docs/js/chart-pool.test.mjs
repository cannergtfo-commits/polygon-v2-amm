// node docs/js/chart-pool.test.mjs
import assert from "node:assert/strict";
import { NATIVE, WPOL } from "./desk-core.mjs";
import {
  ageLabel,
  bestChartPool,
  canonicalChartToken,
  chartCaption,
  dexLabel,
  emptyChartCopy,
  geckoEmbedUrl,
  geckoPoolUrl,
  geckoPoolsPath,
  geckoTokenUrl,
  liquidityLabel,
  poolsFromGecko,
  scorePools,
} from "./chart-pool.mjs";

const day = 86_400;
const now = Date.parse("2026-11-10T00:00:00Z");
const deep = "0x1111111111111111111111111111111111111111";
const thin = "0x2222222222222222222222222222222222222222";
const older = "0x3333333333333333333333333333333333333333";

const deepYoung = scorePools([
  { address: "deep", liquidityUsd: 1_000_000, ageSeconds: 1 * day },
  { address: "thin", liquidityUsd: 10_000, ageSeconds: 1000 * day },
]);
assert.equal(deepYoung[0].address, "deep");
assert.ok(Math.abs(deepYoung[0].score - (0.7 + 0.3 * (1 / 1000))) < 1e-9);

const close = scorePools([
  { address: "newer", liquidityUsd: 100, ageSeconds: 10 * day },
  { address: "older", liquidityUsd: 95, ageSeconds: 1000 * day },
]);
assert.equal(close[0].address, "older");

const olderWins = scorePools([
  { address: "a", liquidityUsd: 50, ageSeconds: 10 },
  { address: "b", liquidityUsd: 50, ageSeconds: 20 },
]);
assert.equal(olderWins[0].address, "b");
assert.ok(olderWins[0].score > olderWins[1].score);

const tiedScore = scorePools([
  { address: "deeper", liquidityUsd: 70, ageSeconds: 0 },
  { address: "older", liquidityUsd: 40, ageSeconds: 100 },
]);
assert.equal(tiedScore[0].score, tiedScore[1].score);
assert.equal(tiedScore[0].address, "deeper");

assert.equal(scorePools([]).length, 0);
const junk = scorePools([{ address: "z", liquidityUsd: Number.NaN, ageSeconds: -5 }]);
assert.equal(junk[0].liquidityUsd, 0);
assert.equal(junk[0].ageSeconds, 0);

assert.equal(canonicalChartToken(NATIVE), WPOL.toLowerCase());
assert.equal(canonicalChartToken(WPOL.toUpperCase()), WPOL.toLowerCase());
assert.equal(canonicalChartToken("0xabc"), null);
assert.equal(canonicalChartToken("0x1111111111111111111111111111111111111111/extra"), null);
assert.equal(geckoPoolsPath(NATIVE), `/networks/polygon_pos/tokens/${WPOL.toLowerCase()}/pools?page=1`);

const token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function row(address, name, dex, liquidity, createdAt, baseAddress = token) {
  return {
    attributes: {
      address,
      name,
      reserve_in_usd: liquidity,
      pool_created_at: createdAt,
    },
    relationships: {
      dex: { data: { id: dex, type: "dex" } },
      base_token: { data: { id: `polygon_pos_${baseAddress}`, type: "token" } },
    },
  };
}

const body = {
  data: [
    row(thin, "Thin / WPOL", "quickswap", "95", "2020-01-01T00:00:00Z"),
    { attributes: { address: "not-a-pool", name: "Bad", reserve_in_usd: "999999999" } },
    { attributes: { name: "Missing address", reserve_in_usd: "999999999" } },
    row(deep, "Deep / WPOL", "uniswap_v3_polygon_pos", "1000000", "2026-01-01T00:00:00Z"),
    row(older, "Older / WPOL", "sushiswap", "40", "2019-01-01T00:00:00Z"),
  ],
};

const pools = poolsFromGecko(body, token, now);
assert.deepEqual(pools.map((pool) => pool.address), [thin, deep, older]);
assert.equal(pools.every((pool) => pool.base), true);
const best = bestChartPool(body, { token, nowMs: now });
assert.equal(best.address, deep);
assert.equal(best.name, "Deep / WPOL");
assert.equal(best.dex, "uniswap_v3_polygon_pos");
assert.equal(best.base, true);
assert.ok(pools.some((pool) => pool.address === best.address));
assert.equal(bestChartPool({ data: [] }, { token, nowMs: now }), null);
assert.equal(bestChartPool(null, { nowMs: now }), null);

const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sided = {
  data: [
    row(deep, "USDC / TOKEN", "quickswap", "5000000", "2024-01-01T00:00:00Z", other),
    row(thin, "TOKEN / USDT", "uniswap_v3_polygon_pos", "80000", "2023-01-01T00:00:00Z", token),
  ],
};
const sidedBest = bestChartPool(sided, { token, nowMs: now });
assert.equal(sidedBest.address, thin, "embed should chart the pool where this token is base");
assert.equal(bestChartPool(sided, { nowMs: now }).address, deep, "without a token, liquidity still wins");
const quoteOnly = { data: [row(deep, "USDC / TOKEN", "quickswap", "5000000", "2024-01-01T00:00:00Z", other)] };
assert.equal(bestChartPool(quoteOnly, { token, nowMs: now }).address, deep);

const embed = geckoEmbedUrl(best.address);
const embedUrl = new URL(embed);
assert.equal(embedUrl.origin, "https://www.geckoterminal.com");
assert.equal(embedUrl.pathname, `/polygon_pos/pools/${deep}`);
assert.equal(embedUrl.searchParams.get("embed"), "1");
assert.equal(embedUrl.searchParams.get("info"), "0");
assert.equal(embedUrl.searchParams.get("swaps"), "0");
assert.equal(embedUrl.searchParams.get("light_chart"), "0");
assert.equal(embedUrl.searchParams.get("chart_type"), "price");
assert.equal(embedUrl.searchParams.get("resolution"), "15m");
assert.equal(embedUrl.searchParams.get("bg_color"), "030712");
assert.equal(geckoEmbedUrl("javascript:alert(1)"), null);
assert.equal(geckoEmbedUrl(`${deep}/../tokens/evil`), null);
assert.equal(geckoPoolUrl(deep), `https://www.geckoterminal.com/polygon_pos/pools/${deep}`);
assert.equal(geckoTokenUrl(NATIVE), `https://www.geckoterminal.com/polygon_pos/tokens/${WPOL.toLowerCase()}`);

assert.equal(liquidityLabel(1473.144), "Liquidity $1,473");
assert.equal(liquidityLabel(Number.NaN), "Liquidity unavailable");
assert.equal(ageLabel("2026-11-09T00:00:00Z", now), "Age 1 day");
assert.equal(ageLabel("2026-11-08T00:00:00Z", now), "Age 2 days");
assert.equal(ageLabel(null, now), "Age unavailable");

assert.equal(dexLabel("uniswap_v3_polygon_pos"), "Uniswap v3");
assert.equal(dexLabel("quickswap"), "QuickSwap");
assert.equal(dexLabel("some_other_dex"), "some_other_dex");
const caption = chartCaption(best);
assert.match(caption, /Uniswap v3/);
assert.match(caption, /70% liquidity and 30% age/);
assert.match(caption, /Swaps still search every allowlisted venue/);
assert.equal(caption.includes("Deep / WPOL"), true);
assert.equal(chartCaption(best, { blazarPairUnlisted: true }).includes("The Blazar pair is not on GeckoTerminal."), true);
assert.match(emptyChartCopy("none").note, /every allowlisted venue/);
assert.match(emptyChartCopy("down").frame, /unavailable/);

console.log("chart pool tests ok");
