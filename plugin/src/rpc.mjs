/**
 * Minimal JSON-RPC client with endpoint fallback, request accounting and Multicall3 batching.
 * No keys, no Alchemy. Every request is counted so a refresh can report its RPC cost.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { ALCHEMY_CU, MULTICALL3, MULTICALL_CHUNK, RPCS } from "./config.mjs";

const MULTICALL_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function createStats() {
  return { requests: {}, subcalls: 0, bytesIn: 0, byUrl: {} };
}

export function alchemyCuOf(stats) {
  let cu = 0;
  for (const [method, n] of Object.entries(stats.requests)) cu += (ALCHEMY_CU[method] ?? 26) * n;
  return cu;
}

export function createRpc({ callUrls = RPCS.call, logUrls = RPCS.logs, stats = createStats(), fetchImpl = fetch, timeoutMs = 30_000, blockTag = "latest" } = {}) {
  let id = 0;
  let preferred = 0;

  async function post(url, method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    stats.requests[method] = (stats.requests[method] || 0) + 1;
    stats.byUrl[url] = (stats.byUrl[url] || 0) + 1;
    stats.bytesIn += text.length;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RpcError(`non-JSON reply from ${new URL(url).host} (HTTP ${res.status})`, res.status);
    }
    if (json.error) throw new RpcError(json.error.message || JSON.stringify(json.error), json.error.code);
    return json.result;
  }

  /** Read call with fallback across free endpoints. A revert is not retried elsewhere. */
  async function request(method, params) {
    let last;
    for (let i = 0; i < callUrls.length; i++) {
      const url = callUrls[(preferred + i) % callUrls.length];
      try {
        const out = await post(url, method, params);
        preferred = (preferred + i) % callUrls.length;
        return out;
      } catch (err) {
        last = err;
        if (/revert/i.test(err.message) || err.code === 3) throw err;
      }
    }
    throw last;
  }

  /**
   * eth_getLogs over [from, to] with adaptive chunking. Tries each log endpoint, shrinking the
   * window on range/size errors. Returns the logs and the last block fully covered.
   */
  async function getLogs({ address, topics, fromBlock, toBlock }) {
    const out = [];
    let start = BigInt(fromBlock);
    const end = BigInt(toBlock);
    let ep = 0;
    let span = BigInt(logUrls[0].maxRange);
    while (start <= end) {
      const endpoint = logUrls[ep];
      if (span > BigInt(endpoint.maxRange)) span = BigInt(endpoint.maxRange);
      const stop = start + span - 1n > end ? end : start + span - 1n;
      try {
        const logs = await post(endpoint.url, "eth_getLogs", [{ address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${stop.toString(16)}` }]);
        out.push(...logs);
        start = stop + 1n;
        if (span < BigInt(endpoint.maxRange)) span = span * 2n;
      } catch (err) {
        if (span > 2_000n) {
          span = span / 4n;
        } else if (ep + 1 < logUrls.length) {
          ep += 1;
          span = BigInt(logUrls[ep].maxRange);
        } else {
          throw err;
        }
      }
    }
    return out;
  }

  async function call(to, data, block = blockTag) {
    return request("eth_call", [{ to, data }, block]);
  }

  /**
   * Batch read calls through Multicall3.aggregate3 with allowFailure. Each item is
   * { to, data } or { to, abi, functionName, args }. Returns { ok, data, value } per item.
   */
  async function multicallChunk(slice, encodedSlice, block) {
    const callData = encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: "aggregate3",
      args: [slice.map((item, k) => ({ target: item.to, allowFailure: true, callData: encodedSlice[k] }))],
    });
    let raw;
    try {
      raw = await call(MULTICALL3, callData, block);
    } catch (err) {
      if (slice.length > 25) {
        const mid = Math.ceil(slice.length / 2);
        const a = await multicallChunk(slice.slice(0, mid), encodedSlice.slice(0, mid), block);
        const b = await multicallChunk(slice.slice(mid), encodedSlice.slice(mid), block);
        return [...a, ...b];
      }
      throw err;
    }
    stats.subcalls += slice.length;
    const rows = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: raw });
    return rows.map((row, k) => {
      const item = slice[k];
      const ok = row.success && row.returnData !== "0x";
      if (ok && item.abi) {
        try {
          return { ok, data: row.returnData, value: decodeFunctionResult({ abi: item.abi, functionName: item.functionName, data: row.returnData }) };
        } catch {
          return { ok: false, data: row.returnData };
        }
      }
      return { ok, data: row.returnData };
    });
  }

  /**
   * Batch read calls through Multicall3.aggregate3 with allowFailure. Each item is
   * { to, data } or { to, abi, functionName, args }. Returns { ok, data, value } per item.
   * Chunks run with small concurrency so a full sweep finishes in minutes, not hours.
   */
  async function multicall(items, { chunk = MULTICALL_CHUNK, block = blockTag, concurrency = 4 } = {}) {
    const encoded = items.map((item) => (item.data ? item.data : encodeFunctionData({ abi: item.abi, functionName: item.functionName, args: item.args || [] })));
    const starts = [];
    for (let i = 0; i < items.length; i += chunk) starts.push(i);
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < starts.length) {
        const i = starts[next++];
        const rows = await multicallChunk(items.slice(i, i + chunk), encoded.slice(i, i + chunk), block);
        rows.forEach((row, k) => (results[i + k] = row));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
    return results;
  }

  async function blockNumber() {
    return BigInt(await request("eth_blockNumber", []));
  }

  async function block(tag = blockTag) {
    return request("eth_getBlockByNumber", [tag, false]);
  }

  return { request, call, multicall, getLogs, blockNumber, block, stats, blockTag };
}
