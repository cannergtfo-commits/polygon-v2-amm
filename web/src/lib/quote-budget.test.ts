import { QuoteSlots, readBoundedBody } from "@/lib/quote-budget";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

function requestFrom(stream: ReadableStream<Uint8Array>) {
  return new Request("https://desk.local/api/quote", { method: "POST", body: stream, duplex: "half" } as RequestInit);
}

async function main() {
let pulls = 0;
const oversize = new ReadableStream<Uint8Array>({
  pull(controller) {
    pulls += 1;
    controller.enqueue(new Uint8Array(1000));
    if (pulls > 20) controller.close();
  },
});
let oversizeThrew = false;
try {
  await readBoundedBody(requestFrom(oversize), 4096, 2000);
} catch (error) {
  oversizeThrew = error instanceof Error && error.message === "Quote request is too large.";
}
assert(oversizeThrew, "oversize body is rejected");
assert(pulls <= 5, `body read stopped after the cap, pulls=${pulls}`);

const slow = new ReadableStream<Uint8Array>({
  pull() {
    return new Promise(() => undefined);
  },
});
const started = Date.now();
let timed = false;
try {
  await readBoundedBody(requestFrom(slow), 4096, 40);
} catch (error) {
  timed = error instanceof Error && error.message === "Quote body timed out.";
}
assert(timed, "a stalled body hits the deadline");
assert(Date.now() - started < 1000, "the body deadline is the short timer");

const slots = new QuoteSlots(2);
let release: (() => void) | undefined;
const hanging = new Promise<string>((resolve) => {
  release = () => resolve("done");
});
const signals: AbortSignal[] = [];
const first = slots.occupy((signal) => {
  signals.push(signal);
  return hanging;
}, 30).catch(() => "timed");
const second = slots.occupy((signal) => {
  signals.push(signal);
  return hanging;
}, 30).catch(() => "timed");
let blocked = false;
try {
  await slots.occupy(async () => "extra", 30);
} catch (error) {
  blocked = error instanceof Error && error.message === "Too many quotes at once.";
}
assert(blocked, "a full gate rejects the next job");
await new Promise((resolve) => setTimeout(resolve, 50));
assert(slots.inflight === 2, "a timeout does not free the slot while the job is still running");
let stillBlocked = false;
try {
  await slots.occupy(async () => "extra", 30);
} catch (error) {
  stillBlocked = error instanceof Error && error.message === "Too many quotes at once.";
}
assert(stillBlocked, "timed-out work still occupies its slot");
release?.();
await Promise.allSettled([first, second]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert(slots.inflight === 0, "the slot frees when the job settles");

let seen: AbortSignal | undefined;
await slots.occupy((signal) => {
  seen = signal;
  return Promise.resolve("ok");
}, 40);
await new Promise((resolve) => setTimeout(resolve, 60));
assert(seen !== undefined && !seen.aborted, "a finished job does not keep its timer");

let aborted = false;
const slowJob = slots.occupy(async (signal) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      aborted = true;
      reject(new Error("Quote timed out."));
    });
  });
}, 30);
await assertRejects(slowJob);
assert(aborted, "the timeout aborts the work signal");
await new Promise((resolve) => setTimeout(resolve, 0));
assert(slots.inflight === 0, "aborted work releases the slot once it settles");

async function assertRejects(promise: Promise<unknown>) {
  let failed = false;
  try {
    await promise;
  } catch {
    failed = true;
  }
  assert(failed, "expected a rejection");
}

console.log("quote budget tests ok");
}

main();
