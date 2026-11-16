# BlazarMultiRewardStaking self-review

Scope: `contracts/src/BlazarMultiRewardStaking.sol` (one file, not upgradeable, OZ 5.1, solc 0.8.26, via_ir).
Tests: `test/BlazarMultiRewardStaking.t.sol`, `test/agent/*` (bot/agent features), `test/review/*` (head-of-security suites), `test/invariant/MultiRewardSolvency.t.sol` and `test/invariant/MultiRewardSkipping.t.sol` (256 runs × depth 128, fail_on_revert), `test/fork/MultiRewardPermit2.fork.t.sol` (Polygon fork, nothing broadcast).
Deploy script: `script/DeployMultiRewardStaking.s.sol`. It has never been broadcast, only simulated.
Slither output: `audits/slither-multireward.txt`.

This is the authoring bot's own review. It is not an independent audit. The first version was reviewed at 9c74471; this revision is the current branch head.

---

## Changelog since 7a82a23: bot/agent features (Grok Bot review C1–C8, approved by the owner)

Branch `multireward-agent`. Source review: `/workspace/blazarforce-agents/STAKING_V2_BOT_REVIEW.md`. **Needs a full head-of-security re-review before deploy** (principal accounting changed: `stakeFor`, `compound`; new external call on the stake path: Permit2; new self-CALL pattern: skipping exits).

| ID | Change | Where |
|----|--------|-------|
| C1 | `totalSupply()`: view alias of `totalStaked` (Synthetix-style readers, TVL adapters). | views |
| C2 | `getPosition(account)` returns `Position{staked, totalStaked, minStake, paused, timestamp, tokens[], earned[], ratePerSecond[], rewardsEnd[]}` in one `eth_call` (~287k gas worst case, view only). | views |
| C3 | `rewardsEnd(token)`: new packed field `RewardState.latestEnd` = max(start+duration) over every run ever created; written only in `_notify`, never decreases, survives pruning. `emissionBetween(token,t0,t1)`: Σ over stored runs of `E(t1) − E(t0)` with the same `_emittedAt` math as accrual (fuzz-tested to be additive and to equal a sole staker's accrual within 2 wei). Excludes already-pruned runs, so it is meant for windows from now on. `t0 > t1` reverts `BadWindow`. | views |
| C4 | Events: `Staked(user, payer, amount, balanceAfter, totalStakedAfter)` (payer indexed: the user, the `stakeFor` caller, or the contract itself for `compound`), `Withdrawn(user, amount, balanceAfter, totalStakedAfter)`, `EmergencyWithdrawn(user, amount, 0, totalStakedAfter)`. New `Compounded(user, amount)` and `RewardSkipped(user, token, amount)`. **ABI change: UI, indexer and the agent kit fixture (7a82a23) must be updated.** | events |
| C5 | `stakeFor(beneficiary, amount)`: payer = msg.sender; `_updateAll(beneficiary)` first; pause and minStake apply; beneficiary ≠ 0 and ≠ this. A deposit for someone else must itself be ≥ `minStake` (blocks the front-run grief where a 1-wei gift makes the beneficiary's partial `withdraw` leave a sub-minStake remainder). No `withdrawFor`: only the beneficiary can reduce the position. | user |
| C6 | `compound()`: own position only; requires BZB to be a listed reward (`NotListed`); `whenNotPaused` (like `stake`); `_updateAll(sender)`, then `rewards[sender][BZB] → 0`, `owed(BZB) −= x`, `balanceOf += x`, `totalStaked += x`. No transfer. `reserved(BZB) = owed + unemitted + totalStaked` is unchanged exactly (asserted per call in both invariant suites). New position must be ≥ `minStake`. | user |
| C7 | `stakeWithPermit2(owner, permit, signature)`: canonical Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` (`constant`, no setter), SignatureTransfer only. Token must be BZB (`WrongToken`); the staked amount is exactly `permit.permitted.amount` (a relayer can't shrink it and burn the nonce); the signer is always the beneficiary (a relayer can't redirect it); relayed deposits must be ≥ `minStake`; pause applies; balance-delta measured. **Polygon fork test** shows real BZB works with Permit2 after a normal `approve(PERMIT2)`, and that this approve can itself be gasless via BZB's `executeMetaTransaction` (NativeMetaTransaction, domain from `getDomainSeperator()`, nonce `getNonce`). BZB has no EIP-2612 `permit`. | user |
| C8 | `claimAllSkipping()` / `exitSkipping()` return `address[] skipped`. Each payment runs in a gas-capped self-CALL (`payRewardSelf`, callable only by `address(this)`, CALL never delegatecall) with `SKIP_PAY_GAS = 200_000`. If anything fails (revert, false return, OOG, lying "transfer then false"), the whole inner frame rolls back, so the credit and `owed` are untouched and `RewardSkipped` is emitted. Returnbomb-safe: the outer CALL copies 0 bytes. 63/64 rule: before every try, `gasleft() ≥ SKIP_PAY_GAS·64/63 + 10k` or the tx reverts `InsufficientGas`, so a skip is never caused by the caller sending too little gas (fuzzed over gas limits 100k–1.5M). `exitSkipping` withdraws principal first via the staking token only. | user |
| Don't | No OZ `Multicall`, no delegatecall. `test_noDelegatecallOrSelfdestruct` still passes on the new bytecode. | — |
| Doc | Fixed the stale text saying `emergencyWithdraw` skips the run math (it runs `_updateAll` since L-1). | this file |

### Gas, agent paths (cold, `test/agent/AgentGas.t.sol`, RvGas method: `vm.cool` on contract, all tokens and Permit2, +21k; 5 tokens × 5 runs, never-touched user)

| Action | Gas | Cap in test |
|---|---|---|
| `stakeFor` (never-touched beneficiary) | ~787k | 1M |
| `stakeWithPermit2` (relayed) | ~823k | 1M |
| `compound` | ~769k | 1M |
| `claimAllSkipping`, 5 paid | ~950k (plain `claimAll` same scenario: ~944k) | 1.2M |
| `exitSkipping`, 5 paid | ~961k | 1.2M |
| `exitSkipping`, 25 runs finishing in the tx | ~1.054M (plain `exit` same scenario: ~1.048M) | 1.2M |
| `exitSkipping`, 4 tokens burn all forwarded gas | ~1.60M | 2M |
| `getPosition` (eth_call) | ~287k | — |
| `withdraw` / `emergencyWithdraw` (RvGas, unchanged) | ~793k / ~794k mid-flight, ~886k finishing | 1M |

The skipping overhead is ~5–7k over the plain versions. **UI/agent rule:** send `claimAllSkipping`/`exitSkipping` with `estimateGas` + 25% or a fixed **≥ 2.2M** (covers 5 × SKIP_PAY_GAS burned plus settlement; unused gas is not charged). Too little gas reverts `InsufficientGas`; it never skips.

### Review pass #1 (agent diff, author)

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| G-1 | Low (fixed in design) | `stakeFor` of 1 wei onto someone's position could front-run their `withdraw(x)` so it leaves `0 < left < minStake` and reverts. | Third-party deposits (`stakeFor` for someone else, relayed `stakeWithPermit2`) must be ≥ `minStake`. Fuzz: `testFuzz_stakeForCannotBlockBeneficiaryWithdraw`. |
| G-2 | Low (fixed in design) | Permit2 SignatureTransfer lets the submitter choose `requestedAmount ≤ permitted.amount`; a relayer could stake 1 wei and burn the user's nonce. | `requestedAmount` is always `permit.permitted.amount`; no amount parameter. |
| G-3 | Low (fixed in design) | A "transfer then return false" token in a try/catch-style skip would pay the user and keep the credit (double pay). | Payment runs in its own frame via self-CALL; any failure reverts the transfer too. Test `test_claimAllSkippingEveryHostileMode` (mode 5) and the skip invariant assert the user balance is unchanged on skip. |
| G-4 | Info | Every new entry point can only add to a position. Paths that move the staking token out are still only `_withdraw` (own balance: `withdraw`, `exit`, `exitSkipping`), `emergencyWithdraw` (own), `_pay` of BZB rewards (covered by `owed`, also via `payRewardSelf`), and `recover` (≤ surplus). | OK. Unit `test_stakeForCreditsBeneficiaryNotPayer`; handler `stakeFor` asserts the payer's position is unchanged. |
| G-5 | Info | `payRewardSelf` is a public ABI entry. It reverts unless `msg.sender == address(this)`, it only pays `account`'s own credit to `account`, and the only caller is `_tryPay` with fixed calldata. Token callbacks during it still hit the `nonReentrant` lock on every state-changing user function. | OK. `test_payRewardSelfOnlySelf`, `test_reentryFromSkippedTokenBlocked`. |
| G-6 | Info | `stakeWithPermit2` is a new external call (Permit2, immutable, audited third-party) on the stake path only. It is never on an exit path. Same balance-delta pattern as `stake`, `nonReentrant`. | Accepted. Slither reentrancy-balance/no-eth on it are false positives. |
| G-7 | Info | `compound` is blocked by pause (it is a stake). `claim(BZB)` stays open while paused. | By design, documented. |
| G-8 | Info | `stakeFor` lets anyone gift ≥ `minStake` into any address, including one that can't call `withdraw` (a contract without the call): those funds are stuck for that beneficiary, by the payer's choice. Unsolicited gifts are possible (dusting). | Documented in SECURITY.md. |
| G-9 | Info | `totalSupply()` + `balanceOf()` may make generic tools treat the contract as an ERC20; it has no `transfer`. | Documented. |
| G-10 | Info | `emissionBetween` omits runs already pruned at a checkpoint, so past windows can undercount. | NatSpec + SECURITY.md. |

### Review pass #2 (agent diff, fresh eyes, principal-first and gas-first)

| # | Sev | Check | Result |
|---|-----|-------|--------|
| H-1 | — | `compound` accounting: after `_updateAll`, `owed` includes the user's credit, so `owed −= x` can't underflow; `totalStaked += x` keeps every position 0 or ≥ minStake (`_credit` check), so the accumulator bound (RV-04) still holds. | OK. Mutation "drop `owed −= x`" is caught by both invariant suites. |
| H-2 | — | `stakeFor` order: `_updateAll(beneficiary)` before the balance changes. | OK. Mutation "skip it" fails `test_stakeForCheckpointsBeneficiaryFirst` and three solvency invariants. |
| H-3 | — | 63/64: removing the gas guard lets a legitimately cheap token be skipped at some gas limits. | Mutation caught by `testFuzz_gasLimitNeverCausesSkip` and `test_insufficientGasRevertsInsteadOfSkipping`. |
| H-4 | — | The skip invariant really exercises skips (mutation `assert skips == 0` fails) across modes revert, false, gas burn, returnbomb, lying and too-hungry, mixed with stake/stakeFor/compound/emergency/pause, with 0 reverts at 256 × 128. | OK |
| H-5 | — | `exitSkipping` principal: `_withdraw` (BZB only) runs before any reward try. An `InsufficientGas` revert undoes the whole tx (nothing lost; `withdraw`/`emergencyWithdraw` are unaffected). | OK |
| H-6 | — | Storage: `latestEnd` packs into the slot of `listed`/`nextRunId`; `uint64(start) + duration` ≤ now + 395 days, so no overflow. No run is written outside `_notify`/`_checkpoint` (B-5 still holds). | OK |
| H-7 | — | Bytecode: no DELEGATECALL/CALLCODE/SELFDESTRUCT (`test_noDelegatecallOrSelfdestruct`). Runtime size 15,821 B (was 12,657 B), 8,755 B under the 24,576 B limit. | OK |
| H-8 | Info | Permit2 front-running: anyone who sees the signature can submit it first; the result is identical (same signer, same amount); the original tx reverts on the used nonce. | Accepted, documented. |
| H-9 | Info | A plain `exit` with 5 cold, non-trivial reward tokens and 25 runs finishing measures ~1.05M, above the RV-01 1M cap for withdraw/emergency. This is pre-existing (not new code); `exit` is not the principal-critical path. | Documented; UI uses ≥ 2.2M for exit-type calls. |

No Critical, High or Medium findings in either pass.

---

## Changelog since 984a927 (head-of-security re-verification: L-1, checkpoint(), I-1 and RewardPaid.to closed; nothing above Info)

| ID | Change |
|----|--------|
| RV-01 | Adopted `test/review/reverify/RvGas.t.sol` (cold `vm.cool` measurements, with 21k intrinsic included). Every user-path scenario is capped at **1,000,000 gas**. Worst-case `emergencyWithdraw`: **~792k cold** (never-touched user, 5 tokens × 25 runs mid-flight) and **~885k gross** when all 25 runs finish inside the exit transaction. **UI requirement:** send `emergencyWithdraw`, `checkpoint` and `withdraw` with `estimateGas` + 25%, or a fixed gas limit of at least **1.1M**. This is also recorded in SECURITY.md. |
| RV-02 | Invariant handlers (`MultiRewardSolvency`, `Pass1PrincipalInvariant`) now call `checkpoint()` with random lists: listed tokens, unlisted addresses, duplicates and empty lists. They assert `checkpoint` never changes `earned()`, and that after every `emergencyWithdraw`, `rewards(user, token) == earned()` from just before the exit, with exact principal returned. |
| RV-03 | SECURITY.md corrected. Rounding dust stays inside `owed` and is **not** owner surplus. The section now references the 984a927 fix verification and the gas-limit note. |
| RV-04 | Added `SAFETY BOUND` comments at `MIN_STAKE_FLOOR`, `MAX_RUN_AMOUNT` and `MIN_DURATION`, plus a SECURITY.md note: any change to them requires re-proving that `withdraw`/`emergencyWithdraw` cannot revert. They are compile-time constants with no setter. |
| RV-05 | New `CannotListSelf()` error for self-listing; this is the only contract logic change. Renamed the stale tests: `test_P2_emergencyStaleWindowCreditedToUser`, `test_P2_listSelfRejected`, `test_P1_listingSelfRejected` (stale "only wastes a permanent slot" comment removed), plus `test_P1_emergencyStaleWindowKeptByUser`. |

---

## Changelog since 9b56694 (head-of-security full review, pass1 + pass2: no Critical/High/Medium)

| ID | Sev | Change |
|----|-----|--------|
| L-1 (P1-01 / P2-01) | Low | `emergencyWithdraw` now runs `_updateAll(msg.sender)` before zeroing the balance. That settles every listed token (all runs) with pure storage math, so the user keeps their full share up to the exit block. Before this, only the share up to each token's last *global* checkpoint was credited, so a stale window was forfeited, and became owner-recoverable if it was the last staker. Added a public `checkpoint(address[] tokens)` that settles globally and for the caller with no transfer (unlisted entries are ignored). Adopted regression tests `test_P2_emergencyStaleWindowCreditedToUser (renamed from `…ForfeitedToOwner` in RV-05)` (now asserts the full window is credited and nothing is recoverable) and `test_P2_emergencyAfterAnyCheckpointKeepsShare`. Inverted to the fixed behavior: `test_P1_emergencyStaleWindowKeptByUser`, `test_P1_01_emergencyNoLongerForfeitsStaleTokenShare`. Own tests: `test_L1_lastEmergencyExitKeepsFullShare`, `test_checkpointWithoutTransfer` (a frozen reward token can block neither checkpoint nor emergencyWithdraw). This supersedes the P-2 and B-6 notes below: the only remaining zero-stake surplus is emission *after* the last staker has left. |
| I-1 (P2-03) | Info | `_addRewardToken` rejects `address(this)` (`CannotListSelf`, since RV-05). BZB as a reward is still allowed. Tests: `test_I1_cannotListSelf`, inverted and renamed `test_P2_listSelfRejected` and `test_P1_listingSelfRejected`. |
| I-2, I-5/P-6, I-6, I-7 | Info | Added a `BlazarMultiRewardStaking` section to `SECURITY.md`. It covers the BZB proxy-admin risk, `recover` taking all surplus, the EOA owner at launch (the user's choice, Safe later), the `claimTo` destination notes, reward-token behavior, and UI requirements. |
| P1-06 | Info | `RewardPaid.to` is now `indexed`; the event is `RewardPaid(user, token, to, amount)`. |
| Tests | — | Adopted the reviewer's adversarial suites in `test/review/pass1` (hostile, lying, gas-bomb, false-returning and re-entering tokens; BZB sender-fee upgrade; principal invariant with claimTo, claimMany, exit and blacklisting handlers) and `test/review/pass2` (hostile/slashable tokens, a partial-claim differential fuzz, accumulator headroom, solvency and ghost invariants, gas table). All three invariant suites now run at 256 runs × depth 128 with fail_on_revert. Slither output regenerated. |

### UI note (for later, site not touched)
`withdraw` should be the default exit. The emergency button should be secondary and carry a warning ("use only if a normal withdraw fails"). After L-1 the two pay out identically, but `emergencyWithdraw` always takes the full balance. The indexer needs the new `RewardPaid` signature.

### Gas after L-1 (cold, per transaction: `forge test --isolate`, reviewer harnesses, 5 tokens × 5 live runs)

| Action | Gas |
|---|---|
| `stake`, first checkpoint, 25 live runs | ~763k–787k (max user path) |
| `withdraw`, steady state | ~450k–599k |
| `withdraw` full, all 25 runs need SSTORE | ~770k |
| `emergencyWithdraw` | ~412k–519k typical. **Worst: ~792k cold** (never-touched user, 25 runs mid-flight) and **~885k gross** when all 25 runs finish in the exit tx (RV-01 correction; earlier ~621k figure was understated) |
| `claim(one token)` | ~159k–172k |
| `claimAll` / `claimMany(5)` | ~569k–762k |
| `exit`, pruning 25 finished runs | ~695k |
| `notify` | ~129k–189k |

Everything is under 0.8M gas, far below Polygon's block limit. `emergencyWithdraw` still makes no reward-token call. Its only external call is the final BZB transfer, so a reward token cannot make it revert.

### Quick self-review of the 9b56694 → this diff
- `emergencyWithdraw` → `_updateAll`: this is the same settlement `withdraw` already runs. It makes no external calls and has the same bounds (5 tokens × 5 runs, run ≤ 2^128, `totalStaked` 0 or ≥ 1e15), so it can't overflow or revert. The balance is zeroed after settlement, so the user's credit uses the pre-exit balance, which is correct. No new reentrancy surface (`nonReentrant`, CEI).
- `checkpoint(tokens)`: `nonReentrant`, no transfers, the balance doesn't change, so per-token settlement is exact (same argument as B-4). A long array only costs the caller. Duplicates are harmless.
- `address(this)` guard: owner-only path, so there is no user impact.
- `RewardPaid` indexing: an ABI/event-topic change only.
- No findings.

---

## Changelog since 9c74471 (finding ID → fix)

| ID | Source | Change |
|----|--------|--------|
| User #1 | owner | `MAX_REWARD_TOKENS` is now 5 (was 10). Listing is still permanent, with no removal. |
| User #2 / D-1 | owner + reviewer (prelim, Medium) | **Rollover removed.** Each `notifyRewardAmount` now creates a new, independent run in a free slot of that token (max `MAX_RUNS_PER_TOKEN = 5` unfinished runs). Existing runs' `amount/start/duration/weights/id` are never written after creation. The only field that moves is `emitted`, which is the settlement checkpoint. Fully emitted runs are settled and their slot is deleted, emitting `RunFinished`. Delayed starts (up to 30 days) are allowed again because they can no longer affect other runs. Tests: `test_topUpCreatesIndependentRunAndLeavesExistingUntouched`, `test_scheduledRunUntouchedByLaterRun`, `test_overlappingRunsDifferentCurvesSum`, `test_maxRunsPerTokenAndFinishedRunsFreeSlots`, `test_delayedRunAlongsideLiveRunAllowed`, fuzz `testFuzz_overlappingRunsSumToFunded`. |
| User #3 / P-8 | owner + reviewer | The deploy script's owner is now a parameter (`OWNER`). The default is the user's wallet 0x6F47…dB14, which **the user explicitly accepted** for launch; they plan to move ownership to a Safe later with Ownable2Step. The 137-only refusal of non-operator owners was removed, so a Safe can be passed directly. |
| Owner hard req. | owner | **Principal cannot be drained by anyone, including the owner.** Verified and tested; see "Principal protection" below. New tests: `test_ownerCannotDrainOrFreezePrincipal`, `test_newOwnerHasSameLimits`, `test_noDelegatecallOrSelfdestruct`, fuzz `testFuzz_ownerActionsNeverReducePrincipal`. New invariant: `invariant_principalUndrainable`. New owner-hostile handler actions: `ownerTogglePause`, `ownerTryOverRecover`, plus `probeWithdrawAll`, which snapshots, withdraws or emergency-withdraws an actor's full principal at any step, then rolls back. |
| P-1 | reviewer (Low) | `emergencyWithdraw` now credits the user's already-settled share, `mulDiv(bal, rewardPerTokenStored − paid, 1e36)`, into `rewards[user]` for every listed token. This was storage-only math at the time (superseded by L-1: `emergencyWithdraw` now runs the full `_updateAll`). Before the fix, that share stayed in `owed` forever and made `recover` revert. The NatSpec is corrected. Regression tests: `test_P1_emergencyWithdrawCreditsCheckpointedShare`, and the new invariant `invariant_owedMatchesEarned` (owed − Σearned ≤ dust), which catches over-reservation. |
| P-2 | reviewer (Info) | *(Superseded by L-1: the exit now settles first, so nothing is forfeited.)* Documented in the `emergencyWithdraw` NatSpec. If the **last** staker emergency-exits, emission since the token's last global checkpoint had no recipient and becomes recoverable surplus. Their settled share is still credited (P-1). Test: `test_P2_lastEmergencyExitPendingBecomesSurplus`. |
| P-3 | reviewer (Info/Low) | `claim`, `claimTo`, `claimMany` and `claimManyTo` now settle **only the claimed tokens** (`_updateOne`). This is valid because the balance doesn't change, so other tokens settle exactly on their next touch. `stake`, `withdraw`, `exit` and `claimAll` still settle all tokens. The constructor now enforces `minStake >= MIN_STAKE_FLOOR = 1e15`, reverting `BelowMinStake`. Tests: `test_P3_claimSettlesOnlyThatToken`, `test_constructorRejectsZeroAndEoa`. |
| P-4 | reviewer (Low) | Added `claimTo(token, to)` and `claimManyTo(tokens, to)`. They pay only `msg.sender`'s rewards, and `to` can't be zero or the contract itself. The `RewardPaid` event now includes `to`. Test: `test_P4_claimToRedirectsBlacklistedUser`. |
| P-5 | reviewer (Info) | Dust is accepted. It is now bounded by `invariant_owedMatchesEarned`. |
| P-6 | reviewer (Info) | Contract NatSpec now states that BZB is an upgradeable PoS-bridge proxy controlled by Polygon's multisig. A hostile future implementation (sender fee, rebase or blacklist) could break withdrawals, and this contract cannot defend against that. |
| P-7 | reviewer (Info) | With the 5-token cap, gas is re-measured (below) and asserted in `test_gasWorstCaseFiveTokensFiveRunsEach`. |

---

## Design: multi-run accounting

- **Per token:** `listed`, `nextRunId`, `rewardPerTokenStored` (1e36 scale), `owed`, and `Run[5] runs`. Each `Run` is `{amount, emitted, start, duration, startWeight, endWeight, id}`, packed into 2 slots. `amount == 0` means the slot is empty.
- **Curve per run:** `E(x) = amount·(wS·x·(2D−x) + wE·x²)/(D²·(wS+wE))`, rounded down. E(0)=0 and E(D)=amount, and E never decreases. A run's checkpoint deltas sum to exactly its amount, and E(x) < amount for x < D.
- **`_checkpoint(token)`** loops over the 5 slots. For each run it adds `E(now) − emitted` to delta. A finished run (E(now) = amount) is deleted. Otherwise `emitted` is updated. The summed delta goes into the token's single accumulator, plus `owed`, when `totalStaked > 0`. With nobody staked it goes to nobody and becomes surplus.
- **Why one accumulator per token, not per run:** every staker shares every run in proportion to stake. Per-run per-user accounting would give each user the identical total, at 5× the user storage and gas. Users claim per token. Per-run views (`getRuns`, `getRun`, `activeRunCount`, `unemitted`, `rewardRate`) let the UI show each run separately: schedule, amount emitted so far, and current rate.
- **Reserved per token:** `owed + Σ(amount − emitted)` across runs, plus `totalStaked` when the token is the staking token. Funding a run checks `balance ≥ reserved`. `recover` takes at most `balance − reserved`.
- **Bounds:** at most 5 tokens × 5 unfinished runs = 25 runs settled per full checkpoint. Each run is ≤ 2^128−1. With `totalStaked` either 0 or ≥ 1e15, the accumulator grows by at most about 2^201 per checkpoint, so overflow is unreachable.

## Principal protection (the owner's hard requirement)

Every path that moves the staking token out:
1. `_withdraw`: only `msg.sender`'s own balance. Called from `withdraw`, `exit` and `exitSkipping`.
2. `emergencyWithdraw`: only `msg.sender`'s own balance.
3. `_pay` when BZB is also a reward token: only `rewards[user]`, which is covered by `owed`. Both `owed` and the balance drop by the same amount. Also reached via `payRewardSelf` (self-only) from the skipping exits.
5. `compound` moves no tokens: it reclassifies the caller's own BZB credit from `owed` to `totalStaked`.
4. `recover`: requires `balance ≥ totalStaked + owed + unemitted + amount` after a checkpoint.

What the owner can and can't do:
- **Owner functions:** `pause`/`unpause` (blocks only `stake` and `notify*`), `addRewardToken(s)`, `notifyRewardAmount(s)` (only adds tokens and creates runs), `recover` (limited as above), `transferOwnership`/`acceptOwnership`. `renounceOwnership` reverts.
- **No setters:** there is no setter for `stakingToken` or `minStake`; both are `immutable`. There is no proxy, no `delegatecall`, no `selfdestruct` and no `callcode`. `test_noDelegatecallOrSelfdestruct` walks the runtime bytecode to confirm this.
- **The owner can't block exits:**
  - `withdraw` has no pause or owner gate. Its checkpoint is pure math that never calls a token, and its bounds come from run limits the owner can't exceed.
  - `emergencyWithdraw` runs the same settlement as `withdraw` (`_updateAll`, since L-1): pure storage math with no token calls and the same proven bounds (RV-04), then returns the full balance. It never calls a reward token. *(Earlier versions of this note said it skipped the run math; that has not been true since the L-1 fix.)*
  - `exitSkipping` withdraws principal through the staking token before any guarded reward payment.
  - Listing a hostile reward token can only break that token's own claims.

Tested by:
- `test_ownerCannotDrainOrFreezePrincipal`
- `test_newOwnerHasSameLimits`
- `testFuzz_ownerActionsNeverReducePrincipal`
- `invariant_principalUndrainable` and the `probeWithdrawAll` handler, which checks full withdrawability at every step of every sequence, including while paused
- `afterInvariant`, which drains everything without unpausing

The remaining trust dependency is the BZB token itself (P-6).

## Gas at 9b56694 (historical, warm; see the agent-path and RV-01 tables above for current cold figures)

| Action | Gas |
|---|---|
| `withdraw`, the user's first checkpoint (fresh user slots) | ~771k |
| `withdraw`, steady state | ~412k |
| `claimAll` | ~552k |
| `withdraw` that prunes all 25 finished runs | ~590k |
| `emergencyWithdraw`, a user's first credit across 5 tokens | ~322k |
| `claim(token)` | settles only that token, roughly 1/5 of `claimAll` |

At 10 tokens with no run cap, 9c74471 cost ~1.09M for the same first-checkpoint withdraw.

---

## Review pass #1 (changed code)

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| A-1 | Info | `claimTo` could send rewards to the staking contract itself, where they would become owner-recoverable surplus. | Fixed: `to == address(this)` now reverts. Covered in the test. |
| A-2 | Info | Slither `uninitialized-local` flagged `delta`, `n` and `tmp`. | All were intentional zero defaults; they are now explicit. |
| A-3 | Info | The owner can fill a token's 5 run slots with long or delayed runs, so no new run for that token can start until one finishes (up to 395 days). Other tokens are unaffected, and users lose nothing. | Accepted as an owner-only operational limit, documented. |
| A-4 | Info | A finished run stays in its slot until the next checkpoint of that token. `activeRunCount` and `getRuns` hide finished runs, and `notify` checkpoints before looking for a free slot, so a finished run never blocks a new one. | Verified by `test_maxRunsPerTokenAndFinishedRunsFreeSlots`. |
| A-5 | Info | `MIN_STAKE_FLOOR = 1e15` assumes an 18-decimal staking token. BZB has 18 decimals (checked on chain). | Documented. |
| A-6 | Info | The `RewardPaid` event signature changed (it adds `to`). | The UI and indexer need to be updated before launch. |

## Review pass #2 (fresh eyes, principal-first)

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| B-1 | — | Listed every code path that sends the staking token (see "Principal protection"). None can reach principal except the owner's own withdrawal. | OK |
| B-2 | — | Could the owner make `withdraw` revert? `_checkpoint` makes no external calls. Its inputs are bounded (amount ≤ 2^128, 5 runs, weights ≤ 1e4, D ≤ 365 days, totalStaked ≥ 1e15), so `mulDiv` and `+=` can't overflow. A hostile listed token is never called in a checkpoint. | OK |
| B-3 | — | Could `emergencyWithdraw` revert after the P-1 change? It loops over ≤ 5 tokens with `mulDiv(bal, rptStored − paid, 1e36)`, and the result is ≤ the user's share of `owed`. It makes no external calls except the final BZB transfer. *(Since L-1 it runs the full `_updateAll`; same no-revert argument as B-2.)* | OK |
| B-4 | — | `_updateOne` correctness: it is used only where `balanceOf` doesn't change (claims). Any balance change goes through `_updateAll` first (`stake`/`stakeFor`/`stakeWithPermit2`/`compound`/`withdraw`/`exit`/`exitSkipping`/`emergencyWithdraw`). | OK |
| B-5 | — | Run independence: storage writes to `runs[i]` happen only in `_notify` (into an empty slot) and in `_checkpoint` (`emitted`, or `delete` once fully emitted). There are no other writers. | OK |
| B-6 | Info | *(Superseded by L-1: `emergencyWithdraw` now does run the checkpoint, so this residual is gone.)* P-2 residual: the last emergency exit turned that token's uncheckpointed emission into surplus. | Closed by L-1 |
| B-7 | Info | Dust: `owed − Σearned` is kept below `8·calls + 8` wei per token by the invariant. In practice it is a few wei. | Accepted |
| B-8 | Info | Trust: BZB proxy upgrade (P-6). Reward tokens must be vetted (no rebasing). Single-wallet owner at launch (user-accepted, P-8). | Documented |

## Static analysis (multireward-agent)

`slither src/BlazarMultiRewardStaking.sol --filter-paths "lib/"` (0.11.6): **23 results, all informational or false positives** (17 at 7a82a23). The 6 new ones: `reentrancy-balance` and `reentrancy-no-eth` on `stakeWithPermit2` (the function is `nonReentrant` and uses the same measured balance-delta pattern as `stake`), two `incorrect-equality` zero checks (`received == 0` in `_pullStake` and `stakeWithPermit2`), two `assembly` items (the array-length shrink in `_payAllSkipping` and the gas-capped zero-copy self-CALL in `_tryPay`, both intended), and `naming-convention` on Permit2's `DOMAIN_SEPARATOR`. No arbitrary-send, access-control, delegatecall or uninitialized-storage findings. Full output: `audits/slither-multireward.txt`.

Aderyn (`aderyn . --src src/BlazarMultiRewardStaking.sol`): **no High**. The 7a82a23-era `stake` High false positive no longer appears. Lows are centralization (owner functions), costly ops/requires in loops (bounded at 5×5), large literals, struct fields named like state variables (`Position.totalStaked`/`minStake`), the intentionally ignored return of `_checkpoint` in `_notify`, uninitialized-local `tmp`, and public-not-used-internally. Report: `audits/aderyn-multireward.md`.

## Tests (multireward-agent)

- `forge test`: **193 pass, 0 fail** (186 non-fork + 7 fork; the 7a82a23 baseline was 146 non-fork + 4 fork).
- New unit and fuzz tests, `test/agent/MultiRewardAgent.t.sol`: 29 (5 fuzz). They cover views (getPosition parity, rewardsEnd persistence, emissionBetween vs curve, additive and equal to accrual), events, stakeFor (credit, checkpoint first, guards, grief-proof withdraw fuzz, fee-on-transfer), compound (exact accounting, guards, minStake, fuzz), Permit2 (relayer, replay, redirect/shrink/wrong-spender, wrong token, expiry, relayed min, pause, canonical address; uses the **real Polygon Permit2 runtime** from `test/fixtures/permit2.polygon.runtime.hex` via `vm.etch`), and skipping (all 6 hostile modes, all-hostile exit, returnbomb gas, InsufficientGas, 63/64 fuzz, only-self, nothing owed, paused, reentry).
- Gas: `test/agent/AgentGas.t.sol` has 10 cold scenarios (table above).
- Fork: `test/fork/MultiRewardPermit2.fork.t.sol` has 3 tests (Permit2 live; real BZB via Permit2; gasless approve via `executeMetaTransaction` and then a relayed Permit2 stake).
- Invariants at **256 runs × depth 128, fail_on_revert, 0 reverts**:
  - `MultiRewardSolvency`: 7 invariants plus afterInvariant. New handlers `stakeFor` (beneficiary settled exactly first, payer unchanged), `compound` (reserved and BZB balance exactly unchanged, other tokens settled exactly), `stakePermit2` (relayed or self), `claimAllSkipping` and `exitSkipping` (never skip well-behaved tokens, pay exactly `earned`, exact principal).
  - New `MultiRewardSkipping`: a hostile token switched at random between ok, revert, false, gas burn, returnbomb, lying and too-hungry. Handlers: stake, stakeFor, withdraw, emergency, compound, notify, warp, pause, and both skipping exits, with per-call checks that the skipped credit is kept exactly, nothing moved, and paid exactly otherwise. Invariants: principal, solvency, conservation and `owed ≈ Σearned`; afterInvariant drains everything.
- Mutation spot-checks (each reverted after): drop `owed −= x` in compound; skip `_updateAll(beneficiary)` in stakeFor; remove the 63/64 guard; assert no skips. All caught.
- Historical: 47 unit tests and 6 invariants at 9b56694; 102 repo tests at that time.
