import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, getAddress, http, parseAbiItem } from "viem";
import { polygon } from "viem/chains";
import { subtractRoundTrips } from "./volume-score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(path.join(here, "../src/config/registry.json"), "utf8"));
const outDir = path.join(here, "../../indexer/out");
const event = parseAbiItem(
  "event AggregatedSwap(address indexed trader, address indexed tokenIn, address indexed tokenOut, address recipient, uint256 amountIn, uint256 feeAmount, uint256 amountOut, uint256 usdE8, bool usdTrusted, uint16 feeBps, bytes32 routeId)",
);
const router = process.env.FEE_ROUTER || registry.contracts.feeRouter;
const zero = registry.zero.toLowerCase();

function empty(note) {
  mkdirSync(outDir, { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), router, days: [], note, rules: registry.points };
  writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));
  console.log(note);
}

if (!router || router.toLowerCase() === zero) {
  empty("Fee router is not deployed. Set FEE_ROUTER or contracts.feeRouter, then rerun.");
  process.exit(0);
}

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC || registry.rpc[0]),
});

const feedAbi = parseAbiItem("function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)");

const decimalsAbi = parseAbiItem("function decimals() view returns (uint8)");

async function anchorUsd(token, amount, blockNumber, blockTime) {
  const known = registry.tokens.find((item) => item.address.toLowerCase() === token.toLowerCase());
  const feed = registry.feeds[getAddress(token)] || registry.feeds[token];
  if (!known || !feed) return null;
  const round = await client.readContract({
    address: feed.address,
    abi: [feedAbi],
    functionName: "latestRoundData",
    blockNumber,
  });
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (answer <= 0n || updatedAt === 0n || updatedAt > blockTime || answeredInRound < roundId) return null;
  if (blockTime - updatedAt > 86_400n) return null;
  const priceDecimals = await client.readContract({ address: feed.address, abi: [decimalsAbi], functionName: "decimals", blockNumber });
  const scale = BigInt(priceDecimals) + BigInt(known.decimals);
  const usd = scale >= 8n ? (amount * answer) / 10n ** (scale - 8n) : amount * answer * 10n ** (8n - scale);
  return usd;
}

async function priceUsd(token, amount, blockNumber, blockTime) {
  if (amount === 0n) return null;
  return anchorUsd(getAddress(token), amount, blockNumber, blockTime).catch(() => null);
}

const fromBlock = BigInt(process.env.FROM_BLOCK || "0");
const logs = await client.getLogs({
  address: router,
  event,
  fromBlock,
  toBlock: "latest",
});

const trades = [];
for (const log of logs) {
  const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
  const block = await client.getBlock({ blockNumber: log.blockNumber });
  const tokenIn = decoded.args.tokenIn === "0x0000000000000000000000000000000000000000" ? registry.wpol : decoded.args.tokenIn;
  const priced = await priceUsd(tokenIn, decoded.args.amountIn, log.blockNumber - 1n, block.timestamp);
  const usd = priced === null ? 0 : Number(priced) / 1e8;
  trades.push({
    trader: decoded.args.trader.toLowerCase(),
    tokenIn: decoded.args.tokenIn.toLowerCase(),
    tokenOut: decoded.args.tokenOut.toLowerCase(),
    amountIn: decoded.args.amountIn.toString(),
    usd,
    eventUsd: Number(decoded.args.usdE8) / 1e8,
    trusted: decoded.args.usdTrusted,
    time: Number(block.timestamp),
    tx: log.transactionHash,
  });
}

const minUsd = Number(process.env.MIN_TRADE_USD || registry.points.minTradeUsd);
const cap = Number(process.env.WALLET_DAILY_CAP_USD || registry.points.walletDailyCapUsd);
const windowSec = Number(process.env.ROUND_TRIP_WINDOW || registry.points.roundTripWindowSec);
const scored = trades.map((trade) => ({ ...trade, score: trade.usd >= minUsd ? trade.usd : 0 }));
const counted = subtractRoundTrips(scored, windowSec, registry.wpol);

const byDay = new Map();
for (const trade of counted) {
  if (trade.score <= 0) continue;
  const day = Math.floor(trade.time / 86400).toString();
  if (!byDay.has(day)) byDay.set(day, new Map());
  const wallets = byDay.get(day);
  const prev = wallets.get(trade.trader) || { address: trade.trader, volumeUsd: 0, points: 0 };
  prev.volumeUsd += trade.score;
  wallets.set(trade.trader, prev);
}

const shares = registry.points.shareBps;
const capBzb = BigInt(registry.points.dailyCapBzb) * 10n ** 18n;
const days = [...byDay.entries()]
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([dayId, wallets]) => {
    let rows = [...wallets.values()].map((row) => ({
      ...row,
      volumeUsd: Math.min(row.volumeUsd, cap),
    }));
    rows.forEach((row) => {
      row.points = Math.floor(row.volumeUsd * registry.points.perUsd);
    });
    rows = rows.filter((row) => row.points > 0).sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, registry.points.boardSize);
    rows.forEach((row, index) => {
      if (index < shares.length) {
        row.rewardBps = shares[index];
        row.rewardBzb = ((capBzb * BigInt(shares[index])) / 10_000n).toString();
        row.rewarded = true;
      } else {
        row.rewardBps = 0;
        row.rewardBzb = "0";
        row.rewarded = false;
      }
    });
    return { dayId, traders: rows };
  });

mkdirSync(outDir, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  router,
  trades: counted.length,
  days,
  rules: registry.points,
  note: "Points use a registry Chainlink feed only, read at the previous block. Missing feed or stale answer scores 0. Event usdE8, including any untrusted oracle spot, is stored as a cross-check and is not the score.",
};
writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));
for (const day of days) writeFileSync(path.join(outDir, `day-${day.dayId}.json`), JSON.stringify(day, null, 2));
console.log(`Indexed ${counted.length} swaps across ${days.length} days into ${outDir}`);
