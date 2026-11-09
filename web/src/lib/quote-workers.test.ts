import { mapSettled, QuoteSlots } from "./quote-budget";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

async function main() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let open = 0;
    const slots = new QuoteSlots(1);
    const started = Date.now();
    let rejected = false;
    try {
      await slots.occupy(
        () =>
          mapSettled([0, 1, 2, 3], 4, async (item) => {
            open += 1;
            if (item === 0) {
              open -= 1;
              throw new Error("Quote timed out.");
            }
            await new Promise((resolve) => setTimeout(resolve, 80));
            open -= 1;
            return item;
          }),
        5_000,
      );
    } catch (error) {
      rejected = error instanceof Error && error.message === "Quote timed out.";
    }
    const elapsed = Date.now() - started;
    assert(rejected, "the original failure is preserved");
    assert(elapsed >= 70, `the root returned before siblings finished (${elapsed}ms)`);
    assert(open === 0, `siblings still running after the root settled: ${open}`);
    assert(slots.inflight === 0, "the slot is released only after the root, which now includes the siblings");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(unhandled.length === 0, `unhandled rejections: ${unhandled.length}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  console.log("quote worker join tests ok");
}

main();
