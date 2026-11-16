# BlazarMultiRewardStaking self-review

Scope: `contracts/src/BlazarMultiRewardStaking.sol` (one file, not upgradeable, OZ 5.1, solc 0.8.26, via_ir).
Tests: `test/BlazarMultiRewardStaking.t.sol` (47 tests, 5 of them fuzz), `test/invariant/MultiRewardSolvency.t.sol` (6 invariants plus an afterInvariant drain, fail_on_revert on).
Deploy script: `script/DeployMultiRewardStaking.s.sol`. It has never been broadcast, only simulated.
Slither output: `audits/slither-multireward.txt`.

This is the authoring bot's own review. It is not an independent audit. The first version was reviewed at 9c74471; this revision is the current branch head.

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
| P-1 | reviewer (Low) | `emergencyWithdraw` now credits the user's already-settled share, `mulDiv(bal, rewardPerTokenStored − paid, 1e36)`, into `rewards[user]` for every listed token. This is storage-only math: no run math, no token calls, cannot revert. Before the fix, that share stayed in `owed` forever and made `recover` revert. The NatSpec is corrected. Regression tests: `test_P1_emergencyWithdrawCreditsCheckpointedShare`, and the new invariant `invariant_owedMatchesEarned` (owed − Σearned ≤ dust), which catches over-reservation. |
| P-2 | reviewer (Info) | Documented in the `emergencyWithdraw` NatSpec. If the **last** staker emergency-exits, emission since the token's last global checkpoint had no recipient and becomes recoverable surplus. Their settled share is still credited (P-1). Test: `test_P2_lastEmergencyExitPendingBecomesSurplus`. |
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
1. `_withdraw`: only `msg.sender`'s own balance. Called from `withdraw` and `exit`.
2. `emergencyWithdraw`: only `msg.sender`'s own balance.
3. `_pay` when BZB is also a reward token: only `rewards[user]`, which is covered by `owed`. Both `owed` and the balance drop by the same amount.
4. `recover`: requires `balance ≥ totalStaked + owed + unemitted + amount` after a checkpoint.

What the owner can and can't do:
- **Owner functions:** `pause`/`unpause` (blocks only `stake` and `notify*`), `addRewardToken(s)`, `notifyRewardAmount(s)` (only adds tokens and creates runs), `recover` (limited as above), `transferOwnership`/`acceptOwnership`. `renounceOwnership` reverts.
- **No setters:** there is no setter for `stakingToken` or `minStake`; both are `immutable`. There is no proxy, no `delegatecall`, no `selfdestruct` and no `callcode`. `test_noDelegatecallOrSelfdestruct` walks the runtime bytecode to confirm this.
- **The owner can't block exits:**
  - `withdraw` has no pause or owner gate. Its checkpoint is pure math that never calls a token, and its bounds come from run limits the owner can't exceed.
  - `emergencyWithdraw` doesn't use the run math at all.
  - Listing a hostile reward token can only break that token's own claims.

Tested by:
- `test_ownerCannotDrainOrFreezePrincipal`
- `test_newOwnerHasSameLimits`
- `testFuzz_ownerActionsNeverReducePrincipal`
- `invariant_principalUndrainable` and the `probeWithdrawAll` handler, which checks full withdrawability at every step of every sequence, including while paused
- `afterInvariant`, which drains everything without unpausing

The remaining trust dependency is the BZB token itself (P-6).

## Gas (5 tokens × 5 live runs each, the worst case; from `test_gasWorstCaseFiveTokensFiveRunsEach`)

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
| B-3 | — | Could `emergencyWithdraw` revert after the P-1 change? It loops over ≤ 5 tokens with `mulDiv(bal, rptStored − paid, 1e36)`, and the result is ≤ the user's share of `owed`. It makes no external calls except the final BZB transfer. | OK |
| B-4 | — | `_updateOne` correctness: it is used only where `balanceOf` doesn't change (claims). Any balance change goes through `_updateAll` first (`stake`/`withdraw`/`exit`) or the P-1 credit loop (`emergencyWithdraw`). | OK |
| B-5 | — | Run independence: storage writes to `runs[i]` happen only in `_notify` (into an empty slot) and in `_checkpoint` (`emitted`, or `delete` once fully emitted). There are no other writers. | OK |
| B-6 | Info | P-2 residual: the last emergency exit turns that token's uncheckpointed emission into surplus. Running a checkpoint inside `emergencyWithdraw` would remove this, but it would put run math back on the emergency path. Kept as is, on purpose. | Documented |
| B-7 | Info | Dust: `owed − Σearned` is kept below `8·calls + 8` wei per token by the invariant. In practice it is a few wei. | Accepted |
| B-8 | Info | Trust: BZB proxy upgrade (P-6). Reward tokens must be vetted (no rebasing). Single-wallet owner at launch (user-accepted, P-8). | Documented |

## Static analysis

Slither 0.11.6 found 19 results, all informational: strict equality on zero checks, timestamp comparisons, calls-in-loop in the owner-only `notifyRewardAmounts`, `_notify` complexity, and the uninitialized-local items, which are now explicit. There are no reentrancy, access-control, arbitrary-send or delegatecall findings. Full output: `audits/slither-multireward.txt`.

## Tests

- Unit and fuzz: 47 in `BlazarMultiRewardStaking.t.sol`. The 5 fuzz tests are curve integration, checkpoint frequency, low-decimal precision, owner actions vs principal, and overlapping runs. Each ran at 10,000 runs in the deep campaign.
- Invariants (6): per-token solvency; principal accounting; `paid + Σearned + unemitted ≤ funded`; `Σearned + unemitted (+principal) ≤ reserved`; `owed ≈ Σearned` (P-1 guard); principal can't be drained. Handler tokens are BZB-as-reward, 6-decimal USDC, WPOL and a 3% fee-on-transfer token. Actions include overlapping runs with random curves and starts (up to 30 days delay), pause toggling, over-recover attempts and withdraw probes. Default is 128 runs × depth 60 with fail_on_revert; the deep campaign ran 512 × 128.
- Full repo: 102 tests pass.
