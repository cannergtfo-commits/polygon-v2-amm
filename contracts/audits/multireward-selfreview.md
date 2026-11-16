# BlazarMultiRewardStaking self-review

Scope: `contracts/src/BlazarMultiRewardStaking.sol` (single file, non-upgradeable, OZ 5.1, solc 0.8.26, via_ir).
Tests: `test/BlazarMultiRewardStaking.t.sol` (36 unit + fuzz), `test/invariant/MultiRewardSolvency.t.sol` (4 invariants + afterInvariant drain).
Deploy script (not run, simulated only): `script/DeployMultiRewardStaking.s.sol`.

This is an internal review by the bot that wrote the code. It is not an independent audit.

## Design in one page

- Stake token is immutable (BZB). `minStake` is immutable (deploy uses 1e15 = 0.001 BZB). Every position is 0 or >= minStake.
- Up to 10 reward tokens, owner-listed, permanent (no removal). BZB may be one of them.
- Each reward token has one run at a time: `amount, emitted, start, duration, startWeight, endWeight`.
- Curve: rate ∝ `wS + (wE - wS)·x/D`. Cumulative emission is the closed-form integral
  `E(x) = amount · (wS·x·(2D − x) + wE·x²) / (D²·(wS + wE))`, rounded down with `Math.mulDiv`.
  E(0)=0, E(D)=amount exactly, E non-decreasing ⇒ sum of checkpoint deltas telescopes to exactly `amount`.
- Accounting per token: `rewardPerTokenStored` (1e36 scale), `owed` (emitted while staked − paid),
  future = `amount − emitted`. `reserved = owed + future (+ totalStaked for the stake token)`.
  Funding checks `balance >= reserved`; `recover` can only take `balance − reserved`.
- Emission while totalStaked == 0 is credited to nobody and becomes recoverable surplus.
- Top-up of a live/scheduled run: settle, roll the un-emitted remainder into a new run (new duration/curve) starting now.
- User paths: `stake` (pausable), `withdraw`, `emergencyWithdraw`, `claim`, `claimMany`, `claimAll`, `exit`.
  `withdraw`/`emergencyWithdraw` never call a reward token.

## Pass #1 findings (and fixes)

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1.1 | Medium | Reward-per-token accumulator could overflow if `totalStaked` is tiny (1 wei) during a very large run: one checkpoint adds up to `2^128·1e36 ≈ 2^248`. A second such run would overflow and make the shared checkpoint revert, which would brick `withdraw`/`claim` for everyone (emergencyWithdraw would still work). | Added immutable `minStake`; every position is 0 or ≥ minStake, so `totalStaked` is 0 or ≥ minStake. With 1e15 the per-checkpoint increment is ≤ 2^198, so overflow would need ~2^58 max-size runs. Runs are capped at `MAX_RUN_AMOUNT = 2^128−1`. Test: `test_minStakeEnforced`. |
| 1.2 | Low | Owner could top up a live run with a delayed `startTime`, freezing emission of the remainder for up to 30 days. | A delayed start is now rejected whenever there is a remainder to roll over (`BadStart`). Test: `test_noDelayedStartWhenRemainderExists`. |
| 1.3 | Info | Events were emitted after the token transfer in `_pay`, `_withdraw`, `emergencyWithdraw`. Indexers could see reordered logs under a reentrant token (state was already safe under `nonReentrant` + CEI). | Events moved before the transfer. `stake`/`_notify` must emit after because they log the measured received amount. |
| 1.4 | Info | `nonReentrant` was not the first modifier on owner functions. | Reordered so the guard runs first. |
| 1.5 | Info (design) | Fee-on-transfer: run amount and stake are credited with the measured balance delta. Rebasing / balance-changing tokens are unsupported (documented in NatSpec). Owner must vet reward tokens. | Documented. Tests: `test_feeOnTransferRewardCreditsReceived`, `test_feeOnTransferStakeCreditsReceived`. |
| 1.6 | Info (design) | `renounceOwnership` would strand surplus and stop future runs. | Disabled (reverts). Users can still withdraw/claim without an owner. |
| 1.7 | Info (design) | Front-running `notify`, flash staking, donation, first-staker: emission is per-second with no lump sum; staking and leaving in the same block earns 0; donations never change `totalStaked`; no shares, so no inflation attack. | Tests: `test_flashStakeEarnsNothing`, `test_recoverCannotTouchFutureOrOwed` (donation), fuzz `testFuzz_checkpointFrequencyNoExploit`. |

## Pass #2 findings (fresh eyes, after pass-1 fixes)

| # | Sev | Finding | Fix / disposition |
|---|-----|---------|-----|
| 2.1 | Medium (test harness) | `vm.expectRevert` before a reverting `new` (via_ir + deployCode) ended the test early and reported PASS without running the rest. `test_constructorRejectsZeroAndEoa` and `test_minStakeEnforced` were silently skipping assertions. | Replaced with a try/catch helper (`_expectDeployRevert`) and re-verified gas/trace. |
| 2.2 | Low (test harness) | via_ir caches `block.timestamp` across `vm.warp`, so chained `vm.warp(block.timestamp + x)` did not advance time (curve tests initially failed, and the checkpoint-frequency fuzz was barely moving time). | All tests and the invariant handler use `vm.getBlockTimestamp()`. |
| 2.3 | Info | Unsafe-typecast lints on `uint128(total)`, `uint128(nowE)`, `uint64(start)`. | All bounded (total ≤ MAX_RUN_AMOUNT, nowE ≤ amount, start ≤ now+30d). Comments + lint waivers added. `Recovered` event moved before transfer. |
| 2.4 | Info | `emergencyWithdraw` lowers `totalStaked` without a checkpoint. Checked: the next checkpoint spreads that interval's emission over the remaining balances, whose sum equals the new `totalStaked`, so Σ credited ≤ emitted still holds. The leaver forfeits only uncheckpointed accrual. A user splitting stake across accounts to exploit this always loses: `(X+Y)/(X+Y+H) ≥ Y/(Y+H)`. | No change. Test: `test_emergencyWithdrawKeepsCreditedRewards` + invariant handler calls it. |
| 2.5 | Info | Rounding dust (≤ ~1 wei per user checkpoint per token) stays inside `owed` forever and is not recoverable. | Accepted (conservative direction). |
| 2.6 | Info | Gas: with 10 live reward tokens, a user's first checkpoint costs ~1.09M gas (20 zero→non-zero slots); steady-state `withdraw` ~385k; `claimAll` ~700k; `emergencyWithdraw` ~72k flat. | Accepted for Polygon; asserted in `test_gasWorstCaseWithdrawAndClaimAllTenTokens`. |
| 2.7 | Info (centralization) | The owner can top up a live run with a longer duration / back-loaded curve, which stretches out the remainder (it cannot take it, it can only delay it). Owner can also recover zero-stake emission. Owner cannot touch principal, owed rewards or scheduled future emission. | Open question for the user (see below). Recommend the owner be a Safe. |
| 2.8 | Info (design) | `claimAll`/`exit` revert if any one reward token's transfer reverts. | By design. `claim`, `claimMany`, `withdraw`, `emergencyWithdraw` are independent of that token. Test: `test_blacklistedRewardDoesNotBlockWithdrawOrOtherClaims`, `test_reentrantRewardTokenCannotReenter`. |
| 2.9 | Info (design) | Reward tokens cannot be removed. 10 slots total for the contract's life. A broken token keeps its slot. | Open question. Removal would need per-user settlement of retired tokens, which would break bounded gas. |
| 2.10 | Info | A single run is capped at 2^128−1 wei. Tokens with > 3.4e20 whole units per run (18 dec) cannot be funded in one run. | Accepted. |

## Static analysis

- `forge lint`: remaining items are block-timestamp (intended), calls-loop in `notifyRewardAmounts` (owner-only, owner-chosen tokens), require-in-loop, and reentrancy-events on `stake`/`_notify`/`recover` paths that must log measured amounts (all under `nonReentrant`).
- Slither 0.11.6: 19 informational results: strict equalities on zero checks, timestamp comparisons, calls-loop in batch notify, cyclomatic complexity of `_notify`. No reentrancy, access-control, arbitrary-send or uninitialized findings.

## Tests

- Unit/fuzz: 36 (fuzz at 10,000 runs in the deep campaign).
- Invariant: per-token `balance ≥ reserved`; Σprincipal = totalStaked = Σbalances; `paid + Σearned + future ≤ funded`; `Σearned + future (+principal) ≤ reserved`; `afterInvariant` withdraws every actor's full principal and claims every token, then re-checks solvency. Tokens: BZB-as-reward, 6-dec USDC, WPOL, 3% fee-on-transfer token. Deep campaign 128 runs × depth 60 (7,680 calls), 0 reverts.
- Full repo suite: 91 tests green.

## Open questions for the owner

1. Should top-ups of a live run be prevented from lowering the current emission rate (stretching)? Today it is a trust assumption on the owner.
2. Is a permanent 10-token cap acceptable, or should a v2 add retire-and-settle?
3. `minStake` = 0.001 BZB OK?
4. Who is the owner at deploy: operator EOA 0x6F47…dB14 (as the script does) or a Safe?
