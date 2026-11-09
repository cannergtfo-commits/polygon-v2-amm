import { unpaidCarried, wrapperOnSpend } from "./wrapper-fee";

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

const amount = 1_000n * 10n ** 18n;
const externalOnce = wrapperOnSpend(amount, amount, true, 5);
assert(externalOnce.fee === amount * 5n / 10_000n, "external input pays 5 bps once");
assert(unpaidCarried(true, amount, 123n, externalOnce.unpaidTaken) === 0n, "external output is paid");

const second = wrapperOnSpend(500n, 0n, true, 5);
assert(second.fee === 0n, "a later external hop of paid principal pays nothing");

const own = wrapperOnSpend(amount, amount, false, 5);
assert(own.fee === 0n, "Blazar leg pays no wrapper fee");
assert(unpaidCarried(false, amount, 40n, own.unpaidTaken) === 40n, "Blazar output stays unpaid");

const afterOwn = wrapperOnSpend(40n, 40n, true, 5);
assert(afterOwn.fee === 40n * 5n / 10_000n, "the first external hop after Blazar pays once");
assert(wrapperOnSpend(10n, 0n, true, 5).fee === 0n, "the hop after that does not pay again");

const slice = wrapperOnSpend(400n, 400n, true, 5);
const other = wrapperOnSpend(600n, 600n, false, 5);
assert(slice.fee + other.fee === 400n * 5n / 10_000n, "a split charges only the external slice");

console.log("wrapper fee tests ok");
