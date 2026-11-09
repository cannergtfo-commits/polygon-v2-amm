/**
 * Wrapper fee shared by the quoter and BlazarFeeRouter._run.
 *
 * A unit of principal is charged the first time it is spent on a non-Blazar leg.
 * `unpaid` is how much of `amount` has not been charged yet in this route.
 * An external leg charges that unpaid slice and its output is fully paid.
 * A Blazar leg charges nothing, and its output carries the same unpaid fraction.
 * A later hop therefore does not charge principal that already paid.
 */
export function wrapperOnSpend(amount: bigint, unpaid: bigint, external: boolean, feeBps: number) {
  const unpaidTaken = unpaid <= 0n ? 0n : unpaid > amount ? amount : unpaid;
  if (!external || feeBps <= 0 || unpaidTaken === 0n || amount === 0n) {
    return { net: amount, fee: 0n, unpaidTaken };
  }
  const fee = (unpaidTaken * BigInt(feeBps)) / 10_000n;
  return { net: amount - fee, fee, unpaidTaken };
}

export function unpaidCarried(external: boolean, spendGross: bigint, amountOut: bigint, unpaidTaken: bigint) {
  if (external || spendGross === 0n || unpaidTaken === 0n || amountOut <= 0n) return 0n;
  return (amountOut * unpaidTaken) / spendGross;
}
