#!/usr/bin/env node
/**
 * Dry run on a local anvil fork of Polygon. Quotes are read from mainnet AT a pinned block, the
 * fork starts from that same block, and the unsigned router tx is executed on the FORK ONLY from
 * an anvil dev account. Each case runs from a snapshot so cases do not move each other's pools.
 * Nothing is sent to mainnet: the only sending RPC is http://127.0.0.1:<port>.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { parseAbi } from "viem";
import { ERC20 } from "../src/abis.mjs";
const ERC20T = parseAbi(["function transfer(address,uint256) returns (bool)"]);
import { NATIVE } from "../src/config.mjs";
import { createPlugin } from "../src/plugin.mjs";
import { createRpc } from "../src/rpc.mjs";

const PORT = Number(process.env.FORK_PORT || 8599);
const FORK_URL = process.env.FORK_URL || "https://gateway.tenderly.co/public/polygon";
const ANVIL = process.env.ANVIL || `${process.env.HOME}/.foundry/bin/anvil`;
const LOCAL = `http://127.0.0.1:${PORT}`;
// A fresh random address, impersonated on the fork only. (Anvil's dev account 0 has an EIP-7702
// delegation to a sweeper on Polygon mainnet, so native POL sent to it is forwarded away.)
const SENDER = `0x${randomBytes(20).toString("hex")}`;
const FEE_RECIPIENT = "0x6F47aa396215ab22647dDB3E86b4663DFe11dB14";

const mainnet = createRpc();
const pinned = (await mainnet.blockNumber()) - 2n;
const quoteRpc = createRpc({ blockTag: `0x${pinned.toString(16)}`, callUrls: ["https://polygon-bor-rpc.publicnode.com", FORK_URL] });
const anvil = spawn(ANVIL, ["--fork-url", FORK_URL, "--fork-block-number", pinned.toString(), "--port", String(PORT), "--silent", "--no-rate-limit"], { stdio: "ignore" });
process.on("exit", () => anvil.kill("SIGTERM"));

const rpc = createRpc({ callUrls: [LOCAL], logUrls: [{ url: LOCAL, maxRange: 10_000 }], timeoutMs: 300_000 });
for (let i = 0; i < 60; i++) {
  try {
    await rpc.blockNumber();
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await rpc.request("anvil_setBalance", [SENDER, `0x${(10n ** 22n).toString(16)}`]);
await rpc.request("anvil_impersonateAccount", [SENDER]);
if ((await rpc.request("eth_getCode", [SENDER, "latest"])) !== "0x") throw new Error("test sender has code; rerun");
const plugin = createPlugin({ rpc: quoteRpc });
const forkPlugin = createPlugin({ rpc });

async function bal(token, who) {
  if (token === NATIVE) return BigInt(await rpc.request("eth_getBalance", [who, "latest"]));
  const raw = await rpc.call(token, encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [who] }));
  return decodeFunctionResult({ abi: ERC20, functionName: "balanceOf", data: raw });
}

async function send(tx) {
  try {
    await rpc.request("eth_call", [{ from: SENDER, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value || 0n).toString(16)}` }, "latest"]);
  } catch (err) {
    if (process.env.DEBUG) {
      const trace = await rpc.request("debug_traceCall", [{ from: SENDER, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value || 0n).toString(16)}` }, "latest", { tracer: "callTracer" }]);
      const walk = (c, d = 0) => { console.error(`${"  ".repeat(d)}${c.type} ${c.to} ${c.input.slice(0, 10)} val=${c.value || 0} ${c.error || ""} out=${(c.output || "").slice(0, 74)}`); (c.calls || []).forEach((k) => walk(k, d + 1)); };
      walk(trace);
    }
    throw new Error(`simulation reverted: ${String(err.message).slice(0, 200)}`);
  }
  const hash = await rpc.request("eth_sendTransaction", [{ from: SENDER, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value || 0n).toString(16)}`, gas: `0x${(3_000_000).toString(16)}` }]);
  let rcpt = null;
  for (let i = 0; i < 120 && !rcpt; i++) {
    rcpt = await rpc.request("eth_getTransactionReceipt", [hash]);
    if (!rcpt) await new Promise((r) => setTimeout(r, 500));
  }
  if (!rcpt) throw new Error(`no receipt for ${hash}`);
  if (rcpt.status !== "0x1") throw new Error(`fork tx reverted: ${hash}`);
  return { hash, gasUsed: Number(BigInt(rcpt.gasUsed)), gasPrice: BigInt(rcpt.effectiveGasPrice) };
}

/**
 * Give SENDER `amount` of `token` on the fork. Tries anvil_dealERC20; for proxy tokens with no
 * findable slot, impersonates a pool that is NOT on the route being tested and transfers from it.
 */
async function fund(token, amount, avoidPools) {
  try {
    await rpc.request("anvil_dealERC20", [token, SENDER, `0x${amount.toString(16)}`]);
    return;
  } catch {}
  const row = plugin.listTokens({ limit: 100000 }).tokens.find((t) => t.address === token.toLowerCase());
  const holders = new Set();
  for (const t of plugin.listTokens({ limit: 100000 }).tokens) for (const p of t.pools || []) if (p.hub === token.toLowerCase() || t.address === token.toLowerCase()) holders.add(p.pool);
  for (const holder of holders) {
    if (avoidPools.includes(holder)) continue;
    if ((await bal(token, holder)) < amount) continue;
    await rpc.request("anvil_impersonateAccount", [holder]);
    await rpc.request("anvil_setBalance", [holder, "0x8ac7230489e80000"]);
    const data = encodeFunctionData({ abi: ERC20T, functionName: "transfer", args: [SENDER, amount] });
    const hash = await rpc.request("eth_sendTransaction", [{ from: holder, to: token, data, gas: "0x30d40" }]);
    await rpc.request("anvil_stopImpersonatingAccount", [holder]);
    let rc = null;
    for (let i = 0; i < 60 && !rc; i++) rc = await rpc.request("eth_getTransactionReceipt", [hash]);
    if (rc?.status === "0x1") return;
  }
  throw new Error(`could not fund ${token}${row ? ` (${row.symbol})` : ""} on the fork`);
}

const ONLY = process.env.ONLY;
const cases0 = [
  { tokenIn: "POL", tokenOut: "USDC", amount: "100" },
  { tokenIn: "POL", tokenOut: "BzB", amount: "5" },
  { tokenIn: "POL", tokenOut: "LINK", amount: "500" },
  { tokenIn: "USDC", tokenOut: "AAVE", amount: "50" },
  { tokenIn: "USDC.e", tokenOut: "USDC", amount: "20", onlyVenues: ["quickswap-v4"], hubs: [] },
  { tokenIn: "LINK", tokenOut: "POL", amount: "2" },
  { tokenIn: "LINK", tokenOut: "WPOL", amount: "2" },
];

const cases = ONLY ? cases0.filter((c) => `${c.tokenIn}->${c.tokenOut}` === ONLY) : cases0;
const results = [];
for (const c of cases) {
  const snap = await rpc.request("evm_snapshot", []);
  try {
    const t = Date.now();
    const q = await plugin.quote(c);
    if (!q.steps) {
      results.push({ pair: `${c.tokenIn}->${c.tokenOut}`, error: q.note });
      continue;
    }
    // Mine first: after evm_revert the latest fork block can be minutes old, which would put the
    // router deadline (block time + 90 s, max 180 s) in the past by the time the tx is mined.
    await rpc.request("evm_mine", []);
    const tx = await forkPlugin.buildSwapTx({ quote: q, recipient: SENDER, slippageBps: 100 });
    if (process.env.DEBUG) console.error(JSON.stringify(q.steps, (_, v) => (typeof v === "bigint" ? v.toString() : v)), q.tokenIn, q.tokenOut);
    if (tx.approval) {
      await fund(q.tokenIn, BigInt(tx.approval.amount) * 2n, q.steps.map((st) => String(st.pool).toLowerCase()));
      await send(plugin.buildApproveTx(tx.approval));
    }
    const outToken = q.tokenOut;
    const feeToken = q.wrapperFees[0]?.token;
    const before = await bal(outToken, SENDER);
    const feeBefore = feeToken ? await bal(feeToken, FEE_RECIPIENT) : 0n;
    const sent = await send(tx);
    let got = (await bal(outToken, SENDER)) - before;
    if (outToken === NATIVE) got += BigInt(sent.gasUsed) * sent.gasPrice; // add back gas the sender paid
    const feeGot = feeToken ? (await bal(feeToken, FEE_RECIPIENT)) - feeBefore : 0n;
    results.push({
      pair: `${c.tokenIn}->${c.tokenOut}`,
      amount: c.amount,
      route: q.label,
      quotedOut: q.amountOut.toString(),
      receivedOut: got.toString(),
      diffBps: Number(((got - q.amountOut) * 100_000n) / q.amountOut) / 10,
      minAmountOut: tx.minAmountOut.toString(),
      wrapperFeeQuoted: q.wrapperFees.map((f) => f.amount.toString()),
      wrapperFeeReceived: feeGot.toString(),
      gasUsed: sent.gasUsed,
      gasHint: Number(tx.gasHint),
      ms: Date.now() - t,
    });
  } catch (err) {
    results.push({ pair: `${c.tokenIn}->${c.tokenOut}`, error: String(err.message || err).slice(0, 300) });
  } finally {
    await rpc.request("evm_revert", [snap]);
  }
  console.error(JSON.stringify(results[results.length - 1]));
}
console.log(JSON.stringify({ forkBlock: pinned.toString(), results }, null, 2));
process.exit(0);
