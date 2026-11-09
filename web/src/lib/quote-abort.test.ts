import { clientFor } from "@/lib/chain";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

async function main() {
  const controller = new AbortController();
  const original = globalThis.fetch;
  let seen: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    seen = signal;
    if (!signal) throw new Error("fetch starts with a live signal");
    if (signal.aborted) throw new Error("fetch starts with a live signal");
    controller.abort();
    if (!signal.aborted) throw new Error("aborting the quote aborts the in-flight fetch");
    throw new Error("stopped");
  }) as typeof fetch;
  try {
    const client = clientFor(controller.signal);
    await client.getBlockNumber().catch(() => undefined);
  } finally {
    globalThis.fetch = original;
  }
  assert(seen != null, "quote transport called fetch");
  console.log("quote abort transport test ok");
}

main();
