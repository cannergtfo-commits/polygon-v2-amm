#!/usr/bin/env node
// usage: node scripts/quote.mjs <tokenIn> <tokenOut> <amount>
import { createPlugin } from "../src/plugin.mjs";
const [tokenIn = "POL", tokenOut = "USDC", amount = "10"] = process.argv.slice(2);
const p = createPlugin();
const q = await p.quote({ tokenIn, tokenOut, amount });
console.log(JSON.stringify(q, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.error("rpc", JSON.stringify(p.rpcStats.requests), "subcalls", p.rpcStats.subcalls);
