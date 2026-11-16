// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BlazarMultiRewardStaking as M} from "../../src/BlazarMultiRewardStaking.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {MockERC20, TaxToken} from "../Mocks.sol";
import {FlakyToken} from "../MultiRewardMocks.sol";
import {Permit2Helper} from "./Permit2Helper.sol";

/// Bot/agent features added on top of 7a82a23: views, richer events, stakeFor, compound, stakeWithPermit2,
/// claimAllSkipping / exitSkipping.
contract MultiRewardAgentTest is Permit2Helper {
    event Staked(
        address indexed user, address indexed payer, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter
    );
    event Withdrawn(address indexed user, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter);
    event EmergencyWithdrawn(address indexed user, uint256 amount, uint256 balanceAfter, uint256 totalStakedAfter);
    event Compounded(address indexed user, uint256 amount);
    event RewardSkipped(address indexed user, address indexed token, uint256 amount);

    uint256 internal constant MIN = 1e15;
    uint256 internal constant INSUFFICIENT_GAS = 260_000;
    M internal s;
    MockERC20 internal bzb;
    MockERC20 internal usdc;
    FlakyToken internal flk;
    address internal owner = makeAddr("owner");
    address internal alice;
    uint256 internal alicePk;
    address internal bob = makeAddr("bob");
    address internal zap = makeAddr("zap");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.warp(1_700_000_000);
        (alice, alicePk) = makeAddrAndKey("alice");
        _etchPermit2();
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        flk = new FlakyToken();
        s = new M(owner, address(bzb), MIN);
        vm.startPrank(owner);
        s.addRewardToken(address(usdc));
        s.addRewardToken(address(flk));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _warp(uint256 dt) internal {
        vm.warp(_now() + dt);
    }

    function _cfg(address token, uint256 amount, uint64 duration, uint16 wS, uint16 wE)
        internal
        pure
        returns (M.RunConfig memory)
    {
        return M.RunConfig({
            token: token, amount: amount, duration: duration, startTime: 0, startWeight: wS, endWeight: wE
        });
    }

    function _fund(address token, uint256 amount, uint64 duration, uint16 wS, uint16 wE) internal {
        MockERC20(token).mint(owner, amount);
        vm.startPrank(owner);
        MockERC20(token).approve(address(s), amount);
        s.notifyRewardAmount(_cfg(token, amount, duration, wS, wE));
        vm.stopPrank();
    }

    function _stake(address who, uint256 amount) internal {
        bzb.mint(who, amount);
        vm.startPrank(who);
        bzb.approve(address(s), amount);
        s.stake(amount);
        vm.stopPrank();
    }

    function _stakeFor(address payer, address who, uint256 amount) internal {
        bzb.mint(payer, amount);
        vm.startPrank(payer);
        bzb.approve(address(s), amount);
        s.stakeFor(who, amount);
        vm.stopPrank();
    }

    function _listBzb() internal {
        vm.prank(owner);
        s.addRewardToken(address(bzb));
    }

    // ================================================================ 1. views

    function test_totalSupplyAlias() public {
        assertEq(s.totalSupply(), 0);
        _stake(alice, 3 ether);
        _stakeFor(zap, bob, 2 ether);
        assertEq(s.totalSupply(), 5 ether);
        assertEq(s.totalSupply(), s.totalStaked());
    }

    function test_getPositionMatchesIndividualViews() public {
        _stake(alice, 10 ether);
        _stake(bob, 30 ether);
        _fund(address(usdc), 1000e6, 10 days, 1, 3);
        _fund(address(flk), 50 ether, 20 days, 5, 0);
        _warp(3 days);
        vm.prank(owner);
        s.pause();
        M.Position memory p = s.getPosition(alice);
        assertEq(p.staked, 10 ether);
        assertEq(p.totalStaked, 40 ether);
        assertEq(p.minStake, MIN);
        assertTrue(p.paused);
        assertEq(p.timestamp, _now());
        assertEq(p.tokens.length, 2);
        for (uint256 i; i < 2; ++i) {
            assertEq(p.tokens[i], s.rewardTokens()[i]);
            assertEq(p.earned[i], s.earned(alice, p.tokens[i]));
            assertEq(p.ratePerSecond[i], s.rewardRate(p.tokens[i]));
            assertEq(p.rewardsEnd[i], s.rewardsEnd(p.tokens[i]));
            assertGt(p.earned[i], 0);
        }
        // Unknown account: zeros but same global data.
        M.Position memory q = s.getPosition(makeAddr("nobody"));
        assertEq(q.staked, 0);
        assertEq(q.earned[0], 0);
        assertEq(q.ratePerSecond[1], p.ratePerSecond[1]);
    }

    function test_rewardsEndTracksLatestRunAndSurvivesPruning() public {
        assertEq(s.rewardsEnd(address(usdc)), 0);
        uint256 t0 = _now();
        _fund(address(usdc), 100e6, 10 days, 1, 1);
        assertEq(s.rewardsEnd(address(usdc)), t0 + 10 days);
        _fund(address(usdc), 100e6, 5 days, 1, 1); // ends earlier: latest end unchanged
        assertEq(s.rewardsEnd(address(usdc)), t0 + 10 days);
        // Scheduled run that ends later moves it.
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(s), 1e6);
        M.RunConfig memory c = _cfg(address(usdc), 1e6, 2 days, 1, 1);
        c.startTime = uint64(t0 + 30 days);
        s.notifyRewardAmount(c);
        vm.stopPrank();
        assertEq(s.rewardsEnd(address(usdc)), t0 + 32 days);
        // After everything finished and was pruned, the value stays.
        _stake(alice, 1 ether);
        _warp(40 days);
        vm.prank(alice);
        s.claim(address(usdc));
        assertEq(s.activeRunCount(address(usdc)), 0);
        assertEq(s.rewardsEnd(address(usdc)), t0 + 32 days);
        assertEq(s.rewardsEnd(address(flk)), 0);
    }

    function test_emissionBetweenMatchesCurve() public {
        uint256 t0 = _now();
        _fund(address(usdc), 1000e6, 10 days, 0, 7);
        _fund(address(usdc), 300e6, 4 days, 9, 2);
        uint256 a = s.emissionBetween(address(usdc), t0, t0 + 1 days);
        uint256 e1 = s.curveEmitted(1000e6, 10 days, 0, 7, 1 days);
        uint256 e2 = s.curveEmitted(300e6, 4 days, 9, 2, 1 days);
        assertEq(a, e1 + e2);
        assertEq(s.emissionBetween(address(usdc), t0, t0 + 365 days), 1300e6);
        assertEq(s.emissionBetween(address(usdc), t0 + 5 days, t0 + 5 days), 0);
        assertEq(s.emissionBetween(address(usdc), 0, t0), 0); // nothing before start
        vm.expectRevert(M.BadWindow.selector);
        s.emissionBetween(address(usdc), t0 + 1, t0);
    }

    function testFuzz_emissionBetweenAdditiveAndMatchesAccrual(
        uint256 amount,
        uint256 dur,
        uint256 wS,
        uint256 wE,
        uint256 d1,
        uint256 d2
    ) public {
        amount = bound(amount, 1e6, 1e30);
        dur = bound(dur, 1 days, 365 days);
        wS = bound(wS, 0, 10_000);
        wE = bound(wE, 0, 10_000);
        if (wS + wE == 0) wE = 1;
        d1 = bound(d1, 0, dur + 10 days);
        d2 = bound(d2, 0, dur + 10 days);
        _stake(alice, 7 ether);
        uint256 t0 = _now();
        MockERC20 r = new MockERC20("R", "R", 18);
        vm.prank(owner);
        s.addRewardToken(address(r));
        _fund(address(r), amount, uint64(dur), uint16(wS), uint16(wE));
        uint256 a = s.emissionBetween(address(r), t0, t0 + d1);
        uint256 b = s.emissionBetween(address(r), t0 + d1, t0 + d1 + d2);
        assertEq(a + b, s.emissionBetween(address(r), t0, t0 + d1 + d2), "additive");
        _warp(d1);
        // Sole staker earns exactly the window's emission, up to 1e36-flooring dust.
        assertApproxEqAbs(s.earned(alice, address(r)), a, 2, "matches accrual");
    }

    // ================================================================ 2. events

    function test_eventsCarryBalanceAfterAndTotal() public {
        bzb.mint(alice, 10 ether);
        vm.startPrank(alice);
        bzb.approve(address(s), 10 ether);
        vm.expectEmit(address(s));
        emit Staked(alice, alice, 4 ether, 4 ether, 4 ether);
        s.stake(4 ether);
        vm.expectEmit(address(s));
        emit Staked(bob, alice, 6 ether, 6 ether, 10 ether);
        s.stakeFor(bob, 6 ether);
        vm.expectEmit(address(s));
        emit Withdrawn(alice, 1 ether, 3 ether, 9 ether);
        s.withdraw(1 ether);
        vm.stopPrank();
        vm.expectEmit(address(s));
        emit EmergencyWithdrawn(bob, 6 ether, 0, 3 ether);
        vm.prank(bob);
        s.emergencyWithdraw();
        vm.expectEmit(address(s));
        emit Withdrawn(alice, 3 ether, 0, 0);
        vm.prank(alice);
        s.exit();
    }

    // ================================================================ 3. stakeFor

    function test_stakeForCreditsBeneficiaryNotPayer() public {
        _stakeFor(zap, alice, 5 ether);
        assertEq(s.balanceOf(alice), 5 ether);
        assertEq(s.balanceOf(zap), 0);
        assertEq(bzb.balanceOf(zap), 0);
        // Payer has no way to take it: every reducing path is msg.sender-only.
        vm.startPrank(zap);
        vm.expectRevert(M.InsufficientBalance.selector);
        s.withdraw(1);
        vm.expectRevert(M.ZeroAmount.selector);
        s.emergencyWithdraw();
        s.exit(); // no-op for zap
        s.exitSkipping();
        vm.stopPrank();
        assertEq(s.balanceOf(alice), 5 ether);
        assertEq(bzb.balanceOf(zap), 0);
        vm.prank(alice);
        s.withdraw(5 ether);
        assertEq(bzb.balanceOf(alice), 5 ether);
    }

    function test_stakeForCheckpointsBeneficiaryFirst() public {
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _fund(address(usdc), 1000e6, 10 days, 1, 1);
        _warp(5 days);
        uint256 before = s.earned(alice, address(usdc)); // 250e6 at 50% share
        _stakeFor(zap, alice, 20 ether);
        assertEq(s.rewards(alice, address(usdc)), before, "settled at old balance");
        _warp(5 days);
        // Second half at 30/40 share: 500e6 * 0.75 = 375e6.
        assertApproxEqAbs(s.earned(alice, address(usdc)), before + 375e6, 2);
    }

    function test_stakeForGuards() public {
        bzb.mint(zap, 10 ether);
        vm.startPrank(zap);
        bzb.approve(address(s), 10 ether);
        vm.expectRevert(M.ZeroAddress.selector);
        s.stakeFor(address(0), 1 ether);
        vm.expectRevert(M.ZeroAddress.selector);
        s.stakeFor(address(s), 1 ether);
        vm.expectRevert(M.ZeroAmount.selector);
        s.stakeFor(alice, 0);
        vm.expectRevert(M.BelowMinStake.selector);
        s.stakeFor(alice, MIN - 1); // third-party deposit below minStake
        vm.stopPrank();
        _stake(alice, 1 ether);
        vm.prank(zap);
        vm.expectRevert(M.BelowMinStake.selector);
        s.stakeFor(alice, 1); // even onto an existing position
        // Self stakeFor is just stake: a small top-up of an existing position is fine.
        bzb.mint(alice, 1);
        vm.startPrank(alice);
        bzb.approve(address(s), 1);
        s.stakeFor(alice, 1);
        vm.stopPrank();
        assertEq(s.balanceOf(alice), 1 ether + 1);
        vm.prank(owner);
        s.pause();
        vm.prank(zap);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s.stakeFor(alice, 1 ether);
    }

    /// A third-party deposit can never make the beneficiary's own valid partial withdraw revert.
    function testFuzz_stakeForCannotBlockBeneficiaryWithdraw(uint256 initial, uint256 gift, uint256 w) public {
        initial = bound(initial, MIN, 1e27);
        w = bound(w, 1, initial);
        if (initial - w != 0 && initial - w < MIN) w = initial; // valid before the gift
        gift = bound(gift, 1, 1e27);
        _stake(alice, initial);
        bzb.mint(zap, gift);
        vm.startPrank(zap);
        bzb.approve(address(s), gift);
        if (gift < MIN) {
            vm.expectRevert(M.BelowMinStake.selector);
            s.stakeFor(alice, gift);
            gift = 0;
        } else {
            s.stakeFor(alice, gift);
        }
        vm.stopPrank();
        vm.prank(alice);
        s.withdraw(w);
        assertEq(bzb.balanceOf(alice), w);
        assertEq(s.balanceOf(alice), initial + gift - w);
        uint256 rest = s.balanceOf(alice);
        vm.prank(alice);
        if (rest > 0) s.withdraw(rest);
        assertEq(bzb.balanceOf(alice), initial + gift);
    }

    function test_stakeForFeeOnTransferCreditsReceived() public {
        TaxToken t = new TaxToken(500, makeAddr("sink"));
        M x = new M(owner, address(t), MIN);
        t.mint(zap, 100 ether);
        vm.startPrank(zap);
        t.approve(address(x), 100 ether);
        x.stakeFor(alice, 100 ether);
        vm.stopPrank();
        assertEq(x.balanceOf(alice), 95 ether);
        assertEq(x.totalStaked(), 95 ether);
    }

    // ================================================================ 4. compound

    function test_compoundRequiresBzbListed() public {
        _stake(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(M.NotListed.selector);
        s.compound();
    }

    function test_compoundMovesOwedIntoStakeExactly() public {
        _listBzb();
        _stake(alice, 10 ether);
        _stake(bob, 30 ether);
        _fund(address(bzb), 400 ether, 10 days, 2, 1);
        _fund(address(usdc), 100e6, 10 days, 1, 1);
        _warp(4 days);
        uint256 e = s.earned(alice, address(bzb));
        uint256 eBob = s.earned(bob, address(bzb));
        uint256 eUsdc = s.earned(alice, address(usdc));
        uint256 res = s.reserved(address(bzb));
        uint256 bal = bzb.balanceOf(address(s));
        vm.expectEmit(address(s));
        emit Compounded(alice, e);
        vm.expectEmit(address(s));
        emit Staked(alice, address(s), e, 10 ether + e, 40 ether + e);
        vm.prank(alice);
        assertEq(s.compound(), e);
        assertGt(e, 0);
        assertEq(s.balanceOf(alice), 10 ether + e);
        assertEq(s.totalStaked(), 40 ether + e);
        assertEq(s.rewards(alice, address(bzb)), 0);
        assertEq(s.earned(alice, address(bzb)), 0);
        assertEq(s.reserved(address(bzb)), res, "reserved unchanged");
        assertEq(bzb.balanceOf(address(s)), bal, "no transfer");
        assertEq(s.earned(bob, address(bzb)), eBob, "others unaffected");
        assertEq(s.earned(alice, address(usdc)), eUsdc, "other tokens unaffected");
        // Compounded amount is withdrawable principal.
        _warp(10 days);
        vm.prank(alice);
        s.exit();
        vm.prank(bob);
        s.exit();
        assertEq(s.totalStaked(), 0);
        assertGe(bzb.balanceOf(address(s)), s.reserved(address(bzb)));
        assertGe(bzb.balanceOf(alice), 10 ether + e);
    }

    function test_compoundGuards() public {
        _listBzb();
        _stake(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(M.ZeroAmount.selector);
        s.compound();
        _fund(address(bzb), 10 ether, 1 days, 1, 1);
        _warp(1 hours);
        vm.prank(owner);
        s.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s.compound();
        vm.prank(alice);
        s.claim(address(bzb)); // claiming stays open while paused
    }

    function test_compoundAfterEmergencyExitRespectsMinStake() public {
        _listBzb();
        _stake(alice, 1 ether);
        _stake(bob, 1e24);
        _fund(address(bzb), 1e12, 1 days, 1, 1); // alice's share (~1e6 wei) is far below minStake
        _warp(2 days);
        vm.prank(alice);
        s.emergencyWithdraw();
        assertGt(s.rewards(alice, address(bzb)), 0);
        vm.prank(alice);
        vm.expectRevert(M.BelowMinStake.selector);
        s.compound();
        // Large enough credit re-opens a position from rewards alone.
        _fund(address(bzb), 1e33, 1 days, 1, 1);
        _stake(alice, 1 ether);
        _warp(2 days);
        vm.prank(alice);
        s.emergencyWithdraw();
        uint256 r = s.rewards(alice, address(bzb));
        vm.prank(alice);
        s.compound();
        assertEq(s.balanceOf(alice), r);
    }

    function testFuzz_compoundKeepsAccounting(uint256 a, uint256 b, uint256 amt, uint256 dt, uint256 dt2) public {
        _listBzb();
        a = bound(a, MIN, 1e27);
        b = bound(b, MIN, 1e27);
        amt = bound(amt, 1 ether, 1e30);
        dt = bound(dt, 1 hours, 40 days);
        dt2 = bound(dt2, 0, 40 days);
        _stake(alice, a);
        _stake(bob, b);
        _fund(address(bzb), amt, 30 days, 3, 1);
        _warp(dt);
        uint256 e = s.earned(alice, address(bzb));
        uint256 res = s.reserved(address(bzb));
        if (a + e < MIN || e == 0) return;
        vm.prank(alice);
        s.compound();
        assertEq(s.reserved(address(bzb)), res);
        assertEq(s.balanceOf(alice), a + e);
        _warp(dt2);
        vm.prank(bob);
        s.exit();
        vm.prank(alice);
        s.exit();
        assertEq(bzb.balanceOf(bob) >= b, true);
        assertGe(bzb.balanceOf(alice), a + e);
        assertGe(bzb.balanceOf(address(s)), s.reserved(address(bzb)));
        assertEq(s.totalStaked(), 0);
    }

    // ================================================================ 5. stakeWithPermit2

    function _approvePermit2(address who, uint256 amount) internal {
        bzb.mint(who, amount);
        vm.prank(who);
        bzb.approve(PERMIT2, type(uint256).max);
    }

    function test_permit2StakeByRelayer() public {
        _approvePermit2(alice, 10 ether);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(address(bzb), 4 ether, 7, _now() + 1 hours);
        bytes memory sig = _sign(alicePk, p, address(s));
        vm.expectEmit(address(s));
        emit Staked(alice, alice, 4 ether, 4 ether, 4 ether);
        vm.prank(relayer);
        s.stakeWithPermit2(alice, p, sig);
        assertEq(s.balanceOf(alice), 4 ether);
        assertEq(s.balanceOf(relayer), 0);
        assertEq(bzb.balanceOf(alice), 6 ether);
        // Replay is rejected by Permit2's nonce bitmap.
        vm.prank(relayer);
        vm.expectRevert();
        s.stakeWithPermit2(alice, p, sig);
        // The signer can also submit directly.
        p = _permit(address(bzb), 6 ether, 8, _now() + 1 hours);
        sig = _sign(alicePk, p, address(s));
        vm.prank(alice);
        s.stakeWithPermit2(alice, p, sig);
        assertEq(s.balanceOf(alice), 10 ether);
        vm.prank(alice);
        s.withdraw(10 ether);
        assertEq(bzb.balanceOf(alice), 10 ether);
    }

    function test_permit2CannotRedirectOrShrink() public {
        _approvePermit2(alice, 10 ether);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(address(bzb), 4 ether, 1, _now() + 1 hours);
        bytes memory sig = _sign(alicePk, p, address(s));
        // Claiming to be the owner with someone else's signature fails signature verification.
        vm.prank(relayer);
        vm.expectRevert();
        s.stakeWithPermit2(relayer, p, sig);
        // Changing the amount breaks the signature.
        p.permitted.amount = 1 ether;
        vm.prank(relayer);
        vm.expectRevert();
        s.stakeWithPermit2(alice, p, sig);
        // A permit signed for another spender is useless here.
        p.permitted.amount = 4 ether;
        bytes memory other = _sign(alicePk, p, relayer);
        vm.prank(relayer);
        vm.expectRevert();
        s.stakeWithPermit2(alice, p, other);
        assertEq(s.balanceOf(alice), 0);
        assertEq(bzb.balanceOf(alice), 10 ether);
    }

    function test_permit2Guards() public {
        _approvePermit2(alice, 10 ether);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(address(usdc), 4 ether, 1, _now() + 1 hours);
        bytes memory sig = _sign(alicePk, p, address(s));
        vm.expectRevert(M.WrongToken.selector);
        s.stakeWithPermit2(alice, p, sig);
        p = _permit(address(bzb), 0, 1, _now() + 1 hours);
        sig = _sign(alicePk, p, address(s));
        vm.expectRevert(M.ZeroAmount.selector);
        s.stakeWithPermit2(alice, p, sig);
        vm.expectRevert(M.ZeroAddress.selector);
        s.stakeWithPermit2(address(0), p, sig);
        // Expired.
        p = _permit(address(bzb), 1 ether, 2, _now() - 1);
        sig = _sign(alicePk, p, address(s));
        vm.expectRevert();
        s.stakeWithPermit2(alice, p, sig);
        // Relayed deposit below minStake rejected; the signer's own small top-up is fine.
        _stake(alice, 1 ether);
        p = _permit(address(bzb), 1, 3, _now() + 1 hours);
        sig = _sign(alicePk, p, address(s));
        vm.prank(relayer);
        vm.expectRevert(M.BelowMinStake.selector);
        s.stakeWithPermit2(alice, p, sig);
        vm.prank(alice);
        s.stakeWithPermit2(alice, p, sig);
        assertEq(s.balanceOf(alice), 1 ether + 1);
        // Paused.
        vm.prank(owner);
        s.pause();
        p = _permit(address(bzb), 1 ether, 4, _now() + 1 hours);
        sig = _sign(alicePk, p, address(s));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s.stakeWithPermit2(alice, p, sig);
    }

    function test_permit2ConstantIsCanonical() public view {
        assertEq(address(s.PERMIT2()), 0x000000000022D473030F116dDEE9F6B43aC78BA3);
    }

    // ================================================================ 6. skipping exits

    function _setupSkip() internal {
        _stake(alice, 10 ether);
        _fund(address(usdc), 100e6, 1 days, 1, 1);
        _fund(address(flk), 100 ether, 1 days, 1, 1);
        _warp(2 days);
    }

    function test_claimAllSkippingEveryHostileMode() public {
        _setupSkip();
        for (uint8 m = 1; m <= 6; ++m) {
            if (m == 6) flk.setHungry(250_000); // legit but needs more than SKIP_PAY_GAS
            flk.setMode(m);
            uint256 credit = s.earned(alice, address(flk));
            uint256 flkBefore = flk.balanceOf(alice);
            vm.expectEmit(address(s));
            emit RewardSkipped(alice, address(flk), credit);
            vm.prank(alice);
            address[] memory sk = s.claimAllSkipping{gas: 3_000_000}();
            assertEq(sk.length, 1, "skipped");
            assertEq(sk[0], address(flk));
            assertEq(s.rewards(alice, address(flk)), credit, "credit kept");
            assertEq(flk.balanceOf(alice), flkBefore, "nothing moved (lying token rolled back too)");
            assertEq(s.owedStored(address(flk)), credit, "owed kept");
        }
        assertEq(usdc.balanceOf(alice), 100e6, "good token paid on the first call");
        flk.setMode(0);
        vm.prank(alice);
        address[] memory none = s.claimAllSkipping();
        assertEq(none.length, 0);
        assertEq(flk.balanceOf(alice), 100 ether);
        assertEq(s.rewards(alice, address(flk)), 0);
    }

    function test_exitSkippingReturnsPrincipalWhenEveryRewardHostile() public {
        FlakyToken[] memory f = new FlakyToken[](3);
        vm.startPrank(owner);
        for (uint256 i; i < 3; ++i) {
            f[i] = new FlakyToken();
            s.addRewardToken(address(f[i]));
        }
        vm.stopPrank();
        _stake(alice, 10 ether);
        _fund(address(usdc), 100e6, 1 days, 1, 1);
        _fund(address(flk), 1 ether, 1 days, 1, 1);
        for (uint256 i; i < 3; ++i) {
            f[i].mint(owner, 1 ether);
            vm.startPrank(owner);
            f[i].approve(address(s), 1 ether);
            s.notifyRewardAmount(_cfg(address(f[i]), 1 ether, 1 days, 1, 1));
            vm.stopPrank();
            f[i].setMode(uint8(3 + i)); // gas burner, returnbomb, lying
        }
        flk.setMode(1);
        usdc.mint(address(1), 0);
        _warp(2 days);
        vm.prank(alice);
        uint256 g = gasleft();
        address[] memory sk = s.exitSkipping{gas: 3_000_000}();
        emit log_named_uint("exitSkipping gas, 4 hostile tokens", g - gasleft());
        assertEq(sk.length, 4);
        assertEq(bzb.balanceOf(alice), 10 ether, "principal back");
        assertEq(s.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), 100e6);
        for (uint256 i; i < 3; ++i) {
            assertApproxEqAbs(s.rewards(alice, address(f[i])), 1 ether, 1e3);
            f[i].setMode(0);
            vm.prank(alice);
            s.claim(address(f[i]));
            assertApproxEqAbs(f[i].balanceOf(alice), 1 ether, 1e3);
        }
    }

    function test_returnbombDoesNotCostCaller() public {
        _setupSkip();
        flk.setMode(4);
        vm.prank(alice);
        uint256 g = gasleft();
        s.claimAllSkipping{gas: 3_000_000}();
        uint256 used = g - gasleft();
        emit log_named_uint("claimAllSkipping gas with a returnbomb token", used);
        assertLt(used, 600_000);
    }

    function test_insufficientGasRevertsInsteadOfSkipping() public {
        _setupSkip();
        flk.setMode(0);
        uint256 credit = s.earned(alice, address(flk));
        vm.prank(alice);
        try s.claimAllSkipping{gas: INSUFFICIENT_GAS}() {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), M.InsufficientGas.selector);
        }
        assertEq(s.earned(alice, address(flk)), credit);
        assertEq(flk.balanceOf(alice), 0);
    }

    /// 63/64 griefing: whatever gas the caller sends, a token that fits in SKIP_PAY_GAS is never skipped.
    /// The call either pays it or reverts as a whole.
    function testFuzz_gasLimitNeverCausesSkip(uint256 gl) public {
        _setupSkip();
        flk.setMode(6);
        flk.setHungry(150_000);
        gl = bound(gl, 100_000, 1_500_000);
        uint256 credit = s.earned(alice, address(flk));
        vm.prank(alice);
        try s.claimAllSkipping{gas: gl}() returns (address[] memory sk) {
            assertEq(sk.length, 0, "never skipped for lack of caller gas");
            assertEq(flk.balanceOf(alice), credit);
        } catch {
            assertEq(flk.balanceOf(alice), 0);
            assertEq(s.earned(alice, address(flk)), credit);
        }
    }

    function test_payRewardSelfOnlySelf() public {
        _setupSkip();
        vm.prank(alice);
        vm.expectRevert(M.OnlySelf.selector);
        s.payRewardSelf(alice, address(usdc));
        vm.expectRevert(M.OnlySelf.selector);
        s.payRewardSelf(alice, address(usdc));
    }

    function test_skippingWithNothingOwed() public {
        vm.prank(alice);
        assertEq(s.claimAllSkipping().length, 0);
        vm.prank(alice);
        assertEq(s.exitSkipping().length, 0);
    }

    function test_skippingWorksWhilePaused() public {
        _setupSkip();
        vm.prank(owner);
        s.pause();
        vm.prank(alice);
        s.exitSkipping();
        assertEq(bzb.balanceOf(alice), 10 ether);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    /// A reentrant token inside the guarded frame still hits the reentrancy lock (and is then just skipped).
    function test_reentryFromSkippedTokenBlocked() public {
        _setupSkip();
        flk.setMode(0);
        // Replace flk transfer with a reentry attempt: use ReentrantToken from the main mocks.
        vm.etch(address(flk), address(new ReentryProbe(address(s))).code);
        vm.prank(alice);
        address[] memory sk = s.claimAllSkipping{gas: 3_000_000}();
        assertEq(sk.length, 1);
    }
}

/// Minimal token code: every transfer tries to reenter the staking contract.
contract ReentryProbe {
    address immutable target;

    constructor(address t) {
        target = t;
    }

    function transfer(address, uint256) external returns (bool) {
        M(target).claimAllSkipping();
        return true;
    }
}
