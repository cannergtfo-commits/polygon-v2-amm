export const QUOTE_BODY_BYTES = 4_096;
export const QUOTE_BODY_MS = 2_000;
export const QUOTE_WORK_MS = 12_000;
export const QUOTE_SLOTS = 4;

export class QuoteSlots {
  private active = 0;

  constructor(private readonly max: number) {}

  get inflight() {
    return this.active;
  }

  tryEnter() {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  /**
   * The slot stays taken until `work` settles. A timeout aborts the signal and
   * rejects the caller, but it does not free the slot early and it does not
   * leave the timer running after a success.
   */
  async occupy<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    if (!this.tryEnter()) throw new Error("Too many quotes at once.");
    const controller = new AbortController();
    let settled = false;
    const leave = () => {
      if (settled) return;
      settled = true;
      this.active -= 1;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const job = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(leave);
    try {
      return await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Quote timed out."));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Run a bounded pool of workers. A failure stops new picks, and the returned
 * promise stays pending until every worker that already started has settled.
 */
export async function mapSettled<T, R>(items: readonly T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;
  async function worker() {
    while (failure === undefined && cursor < items.length) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index], index);
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }
  const workers = Math.min(Math.max(size, 0), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failure !== undefined) throw failure;
  return out;
}

export async function readBoundedBody(request: Request, maxBytes: number, deadlineMs: number): Promise<string> {
  const body = request.body;
  if (!body) {
    const text = await request.text();
    if (text.length > maxBytes) throw new Error("Quote request is too large.");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => undefined);
  }, deadlineMs);
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (timedOut) throw new Error("Quote body timed out.");
        throw error;
      }
      if (timedOut) throw new Error("Quote body timed out.");
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Quote request is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}
