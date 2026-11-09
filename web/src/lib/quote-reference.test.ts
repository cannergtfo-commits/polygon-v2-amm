import { findBestRoute } from "@/lib/quotes";
import { QuoteSlots } from "@/lib/quote-budget";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

function urlOf(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function aborted(signal: AbortSignal | null | undefined) {
  return new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (!signal) {
      fail();
      return;
    }
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

async function withFetch<T>(
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<{ result: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { result, unhandled };
  } finally {
    globalThis.fetch = original;
    process.off("unhandledRejection", onUnhandled);
  }
}

async function main() {
  let open = 0;
  const early = await withFetch(async (input, init) => {
    const url = urlOf(input);
    open += 1;
    try {
      if (url.includes("paraswap.io")) return await aborted(init?.signal ?? null);
      const signal = init?.signal ?? null;
      if (signal && !signal.aborted) {
        const stop = () => undefined;
        signal.addEventListener("abort", stop, { once: true });
      }
      return await aborted(init?.signal ?? null);
    } finally {
      open -= 1;
    }
  }, async () => {
    const controller = new AbortController();
    const pending = findBestRoute(WPOL, USDC, 10n ** 18n, controller.signal);
    const started = Date.now();
    while (open === 0 && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    let failed = false;
    try {
      await pending;
    } catch (error) {
      failed = error instanceof Error && error.message === "Quote timed out.";
    }
    assert(failed, "aborting during the route rejects the quote");
    assert(open === 0, `early abort left ${open} fetches running`);
    return "early";
  });
  assert(early.unhandled.length === 0, `early abort left ${early.unhandled.length} unhandled rejections`);

  open = 0;
  const slots = new QuoteSlots(1);
  const timed = await withFetch(async (input, init) => {
    open += 1;
    try {
      return await aborted(init?.signal ?? null);
    } finally {
      open -= 1;
    }
  }, async () => {
    let rejected = false;
    try {
      await slots.occupy((signal) => findBestRoute(WPOL, USDC, 10n ** 18n, signal), 40);
    } catch (error) {
      rejected = error instanceof Error && error.message === "Quote timed out.";
    }
    assert(rejected, "the quote slot reports the timeout");
    const started = Date.now();
    while (slots.inflight !== 0) {
      if (Date.now() - started > 5_000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(slots.inflight === 0, "the slot is still held");
    assert(open === 0, `timeout left ${open} fetches running after the slot was released`);
    return "timeout";
  });
  assert(timed.unhandled.length === 0, `timeout left ${timed.unhandled.length} unhandled rejections`);
  console.log("quote reference join tests ok");
}

main();
