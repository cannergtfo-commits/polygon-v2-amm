// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BlazarMultiRewardStaking as M} from "../src/BlazarMultiRewardStaking.sol";
import {MockERC20, TaxToken} from "./Mocks.sol";
import {BlacklistToken, ReentrantToken} from "./MultiRewardMocks.sol";

contract BlazarMultiRewardStakingTest is Test {
    uint256 internal constant MIN = 1e15;
    M internal s;
    MockERC20 internal bzb;
    MockERC20 internal usdc;
    MockERC20 internal wpol;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        wpol = new MockERC20("Wrapped POL", "WPOL", 18);
        s = new M(owner, address(bzb), MIN);
        vm.startPrank(owner);
        s.addRewardToken(address(usdc));
        s.addRewardToken(address(wpol));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    /// @dev via_ir can cache `block.timestamp` across vm.warp; read the real clock instead.
    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
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

    // ---------------------------------------------------------------- construction & admin

    /// @dev try/catch instead of expectRevert: via_ir + deployCode made a reverting `new` end the test early.
    function _expectDeployRevert(address stakeTok, uint256 min_, bytes4 sel) internal {
        try new M(owner, stakeTok, min_) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), sel);
        }
    }

    function test_constructorRejectsZeroAndEoa() public {
        _expectDeployRevert(address(0), MIN, M.ZeroAddress.selector);
        _expectDeployRevert(makeAddr("eoa"), MIN, M.NotContract.selector);
        _expectDeployRevert(address(bzb), 0, M.BelowMinStake.selector);
        _expectDeployRevert(address(bzb), 1e15 - 1, M.BelowMinStake.selector);
        M ok = new M(owner, address(bzb), MIN);
        assertEq(address(ok.stakingToken()), address(bzb));
        assertEq(ok.minStake(), MIN);
        assertEq(ok.owner(), owner);
    }

    function test_renounceDisabled() public {
        vm.prank(owner);
        vm.expectRevert(M.RenounceDisabled.selector);
        s.renounceOwnership();
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        s.transferOwnership(alice);
        assertEq(s.owner(), owner);
        vm.prank(alice);
        s.acceptOwnership();
        assertEq(s.owner(), alice);
    }

    function test_addRewardTokenGuards() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        s.addRewardToken(address(bzb));
        vm.startPrank(owner);
        vm.expectRevert(M.ZeroAddress.selector);
        s.addRewardToken(address(0));
        vm.expectRevert(M.NotContract.selector);
        s.addRewardToken(makeAddr("eoa"));
        vm.expectRevert(M.AlreadyListed.selector);
        s.addRewardToken(address(usdc));
        s.addRewardToken(address(bzb));
        for (uint256 i; i < 2; ++i) {
            s.addRewardToken(address(new MockERC20("X", "X", 18)));
        }
        assertEq(s.rewardTokensLength(), 5);
        assertEq(s.MAX_REWARD_TOKENS(), 5);
        address extra = address(new MockERC20("Y", "Y", 18));
        vm.expectRevert(M.TooManyRewardTokens.selector);
        s.addRewardToken(extra);
        vm.stopPrank();
    }

    function test_notifyGuards() public {
        usdc.mint(owner, 1e12);
        vm.startPrank(owner);
        usdc.approve(address(s), type(uint256).max);
        vm.expectRevert(M.NotListed.selector);
        s.notifyRewardAmount(_cfg(address(bzb), 1e6, 7 days, 1, 1));
        vm.expectRevert(M.ZeroAmount.selector);
        s.notifyRewardAmount(_cfg(address(usdc), 0, 7 days, 1, 1));
        vm.expectRevert(M.BadDuration.selector);
        s.notifyRewardAmount(_cfg(address(usdc), 1e6, 1 days - 1, 1, 1));
        vm.expectRevert(M.BadDuration.selector);
        s.notifyRewardAmount(_cfg(address(usdc), 1e6, 365 days + 1, 1, 1));
        vm.expectRevert(M.BadWeights.selector);
        s.notifyRewardAmount(_cfg(address(usdc), 1e6, 7 days, 0, 0));
        vm.expectRevert(M.BadWeights.selector);
        s.notifyRewardAmount(_cfg(address(usdc), 1e6, 7 days, 10_001, 1));
        M.RunConfig memory c = _cfg(address(usdc), 1e6, 7 days, 1, 1);
        c.startTime = uint64(block.timestamp - 1);
        vm.expectRevert(M.BadStart.selector);
        s.notifyRewardAmount(c);
        c.startTime = uint64(block.timestamp + 30 days + 1);
        vm.expectRevert(M.BadStart.selector);
        s.notifyRewardAmount(c);
        M.RunConfig[] memory none = new M.RunConfig[](0);
        vm.expectRevert(M.ZeroAmount.selector);
        s.notifyRewardAmounts(none);
        s.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s.notifyRewardAmount(_cfg(address(usdc), 1e6, 7 days, 1, 1));
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        s.notifyRewardAmount(_cfg(address(usdc), 1e6, 7 days, 1, 1));
    }

    function test_amountTooLarge() public {
        uint256 big = uint256(type(uint128).max) + 1;
        _stake(alice, 1 ether);
        wpol.mint(owner, big);
        vm.startPrank(owner);
        wpol.approve(address(s), big);
        vm.expectRevert(M.AmountTooLarge.selector);
        s.notifyRewardAmount(_cfg(address(wpol), big, 7 days, 1, 1));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- emission

    function test_flatSingleStakerGetsEverything() public {
        _stake(alice, 100 ether);
        _fund(address(usdc), 7000e6, 7 days, 5000, 5000);
        assertEq(s.rewardRate(address(usdc)), 7000e6 / uint256(7 days));
        _warp(3.5 days);
        assertApproxEqAbs(s.earned(alice, address(usdc)), 3500e6, 1);
        _warp(10 days);
        assertApproxEqAbs(s.earned(alice, address(usdc)), 7000e6, 1);
        vm.prank(alice);
        s.claimAll();
        assertApproxEqAbs(usdc.balanceOf(alice), 7000e6, 1);
        assertEq(s.rewardRate(address(usdc)), 0);
    }

    function test_twoStakersProportional() public {
        _stake(alice, 300 ether);
        _stake(bob, 100 ether);
        _fund(address(wpol), 400 ether, 10 days, 1, 1);
        _warp(10 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 300 ether, 1e3);
        assertApproxEqAbs(s.earned(bob, address(wpol)), 100 ether, 1e3);
        assertLe(s.earned(alice, address(wpol)) + s.earned(bob, address(wpol)), 400 ether);
    }

    function test_increasingCurveFromZero() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 100 ether, 10 days, 0, 10_000);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 25 ether, 1e3);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 100 ether, 1e3);
    }

    function test_decreasingCurveToZero() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 100 ether, 10 days, 10_000, 0);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 75 ether, 1e3);
        assertEq(
            s.rewardRate(address(wpol)),
            (100 ether * 2 * 10_000 * uint256(5 days)) / (uint256(10 days) * 10 days * 10_000)
        );
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 100 ether, 1e3);
    }

    function test_ratioCurve1to3() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 3);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 37.5 ether, 1e3);
    }

    function test_scheduledStartEmitsNothingBefore() public {
        _stake(alice, 1 ether);
        wpol.mint(owner, 10 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 10 ether);
        M.RunConfig memory c = _cfg(address(wpol), 10 ether, 1 days, 1, 1);
        c.startTime = uint64(block.timestamp + 2 days);
        s.notifyRewardAmount(c);
        vm.stopPrank();
        _warp(2 days);
        assertEq(s.earned(alice, address(wpol)), 0);
        assertEq(s.rewardRate(address(wpol)), 10 ether / uint256(1 days));
        _warp(1 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 10 ether, 1e3);
    }

    function test_flashStakeEarnsNothing() public {
        _stake(alice, 100 ether);
        _fund(address(wpol), 100 ether, 1 days, 1, 1);
        _warp(1 hours);
        _stake(bob, 1_000_000 ether);
        vm.prank(bob);
        s.exit();
        assertEq(wpol.balanceOf(bob), 0);
        assertEq(bzb.balanceOf(bob), 1_000_000 ether);
    }

    function test_independentRunsPerToken() public {
        _stake(alice, 10 ether);
        _fund(address(usdc), 1000e6, 2 days, 1, 1);
        _fund(address(wpol), 50 ether, 20 days, 0, 1);
        _warp(2 days);
        assertApproxEqAbs(s.earned(alice, address(usdc)), 1000e6, 1);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 50 ether / 100, 1e3); // (2/20)^2 = 1%
        vm.prank(alice);
        s.claim(address(usdc));
        assertApproxEqAbs(usdc.balanceOf(alice), 1000e6, 1);
        assertEq(wpol.balanceOf(alice), 0);
    }

    function test_batchNotify() public {
        _stake(alice, 1 ether);
        usdc.mint(owner, 100e6);
        wpol.mint(owner, 100 ether);
        M.RunConfig[] memory cfgs = new M.RunConfig[](2);
        cfgs[0] = _cfg(address(usdc), 100e6, 1 days, 1, 1);
        cfgs[1] = _cfg(address(wpol), 100 ether, 3 days, 2, 1);
        vm.startPrank(owner);
        usdc.approve(address(s), 100e6);
        wpol.approve(address(s), 100 ether);
        s.notifyRewardAmounts(cfgs);
        vm.stopPrank();
        _warp(3 days);
        (address[] memory toks, uint256[] memory amts) = s.earnedAll(alice);
        assertEq(toks.length, 2);
        assertApproxEqAbs(amts[0], 100e6, 1);
        assertApproxEqAbs(amts[1], 100 ether, 1e3);
    }

    // ---------------------------------------------------------------- runs, top-ups, unclaimed

    function test_unclaimedSurvivesNewRunAndNewToken() public {
        _stake(alice, 10 ether);
        _fund(address(wpol), 70 ether, 7 days, 1, 1);
        _warp(7 days);
        vm.prank(alice);
        s.withdraw(10 ether); // alice leaves with rewards unclaimed
        uint256 owedAlice = s.earned(alice, address(wpol));
        assertApproxEqAbs(owedAlice, 70 ether, 1e3);

        _stake(bob, 10 ether);
        _fund(address(wpol), 30 ether, 3 days, 0, 1);
        vm.startPrank(owner);
        s.addRewardToken(address(bzb));
        s.pause();
        vm.stopPrank();
        _warp(3 days);
        assertEq(s.earned(alice, address(wpol)), owedAlice);
        vm.prank(alice);
        s.claim(address(wpol));
        assertEq(wpol.balanceOf(alice), owedAlice);
        assertApproxEqAbs(s.earned(bob, address(wpol)), 30 ether, 1e3);
    }

    function _assertRunEq(M.Run memory a, M.Run memory b) internal pure {
        assertEq(a.amount, b.amount, "amount");
        assertEq(a.start, b.start, "start");
        assertEq(a.duration, b.duration, "duration");
        assertEq(a.startWeight, b.startWeight, "wS");
        assertEq(a.endWeight, b.endWeight, "wE");
        assertEq(a.id, b.id, "id");
    }

    function test_topUpCreatesIndependentRunAndLeavesExistingUntouched() public {
        _stake(alice, 5 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        M.Run memory before = s.getRun(address(wpol), 0);
        _warp(4 days);
        uint256 earnedBefore = s.earned(alice, address(wpol));
        _fund(address(wpol), 50 ether, 5 days, 3, 1); // new run, decreasing curve
        M.Run memory after_ = s.getRun(address(wpol), 0);
        _assertRunEq(before, after_); // schedule identical (emitted is just the settled checkpoint)
        assertApproxEqAbs(uint256(after_.emitted), 40 ether, 1);
        M.Run memory second = s.getRun(address(wpol), 1);
        assertEq(second.amount, 50 ether);
        assertEq(second.id, 2);
        assertEq(second.start, vm.getBlockTimestamp());
        assertEq(s.activeRunCount(address(wpol)), 2);
        assertEq(s.earned(alice, address(wpol)), earnedBefore); // top-up does not change accrued
        // Run 1 alone would have paid 60 more over 6 days; run 2 pays 50 over its first 5.
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 40 ether + 50 ether + 50 ether, 1e3);
        _warp(1 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 150 ether, 1e3);
        assertLe(s.earned(alice, address(wpol)), 150 ether);
    }

    function test_scheduledRunUntouchedByLaterRun() public {
        _stake(alice, 5 ether);
        wpol.mint(owner, 10 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 10 ether);
        M.RunConfig memory c = _cfg(address(wpol), 10 ether, 1 days, 1, 1);
        c.startTime = uint64(vm.getBlockTimestamp() + 1 days);
        s.notifyRewardAmount(c);
        vm.stopPrank();
        M.Run memory sched = s.getRun(address(wpol), 0);
        _fund(address(wpol), 5 ether, 1 days, 1, 1);
        _assertRunEq(sched, s.getRun(address(wpol), 0));
        _warp(1 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 5 ether, 1e3); // only the immediate run so far
        _warp(1 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 15 ether, 1e3);
    }

    function test_overlappingRunsDifferentCurvesSum() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 100 ether, 10 days, 0, 10_000); // increasing
        _fund(address(wpol), 100 ether, 10 days, 10_000, 0); // decreasing
        _warp(5 days);
        // 25% + 75% of 100 each
        assertApproxEqAbs(s.earned(alice, address(wpol)), 100 ether, 1e3);
        assertApproxEqAbs(s.rewardRate(address(wpol)), 2 * 100 ether / uint256(10 days), 2);
        M.RunView[] memory v = s.getRuns(address(wpol));
        assertEq(v.length, 2);
        assertApproxEqAbs(v[0].emittedNow, 25 ether, 1);
        assertApproxEqAbs(v[1].emittedNow, 75 ether, 1);
        assertEq(v[0].end, v[0].start + 10 days);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 200 ether, 1e3);
    }

    function test_maxRunsPerTokenAndFinishedRunsFreeSlots() public {
        _stake(alice, 1 ether);
        for (uint256 i; i < 5; ++i) {
            _fund(address(wpol), 1 ether, uint64(1 days + i * 1 days), 1, 1);
        }
        assertEq(s.activeRunCount(address(wpol)), 5);
        wpol.mint(owner, 1 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 1 ether);
        vm.expectRevert(M.TooManyRuns.selector);
        s.notifyRewardAmount(_cfg(address(wpol), 1 ether, 1 days, 1, 1));
        vm.stopPrank();
        // other tokens are unaffected by wpol's run cap
        _fund(address(usdc), 1e6, 1 days, 1, 1);
        _warp(1 days); // run id 1 is finished
        assertEq(s.activeRunCount(address(wpol)), 4);
        vm.startPrank(owner);
        s.notifyRewardAmount(_cfg(address(wpol), 1 ether, 1 days, 1, 1)); // reuses the freed slot 0
        vm.stopPrank();
        M.Run memory r0 = s.getRun(address(wpol), 0);
        assertEq(r0.id, 6);
        assertEq(r0.emitted, 0);
        _warp(10 days);
        vm.prank(alice);
        s.claim(address(wpol));
        assertApproxEqAbs(wpol.balanceOf(alice), 6 ether, 1e3);
        assertLe(wpol.balanceOf(alice), 6 ether);
        assertEq(s.activeRunCount(address(wpol)), 0);
        for (uint256 i; i < 5; ++i) {
            assertEq(s.getRun(address(wpol), i).amount, 0); // all pruned after the claim checkpoint
        }
        assertEq(s.unemitted(address(wpol)), 0);
    }

    // ---------------------------------------------------------------- zero supply, recover

    function test_zeroSupplyEmissionIsRecoverable() public {
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        _warp(5 days);
        assertApproxEqAbs(s.recoverable(address(wpol)), 50 ether, 1);
        _stake(alice, 1 ether);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 50 ether, 1e3);
        uint256 free = s.recoverable(address(wpol));
        vm.startPrank(owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(wpol), free + 1, owner);
        s.recover(address(wpol), free, owner);
        vm.stopPrank();
        vm.prank(alice);
        s.claim(address(wpol));
        assertApproxEqAbs(wpol.balanceOf(alice), 50 ether, 1e3);
    }

    function test_recoverCannotTouchFutureOrOwed() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        wpol.mint(address(s), 7 ether); // donation
        _warp(3 days);
        assertApproxEqAbs(s.recoverable(address(wpol)), 7 ether, 1e3);
        vm.startPrank(owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(wpol), 7 ether + 1e3, owner);
        s.recover(address(wpol), 7 ether - 1e3, owner);
        vm.expectRevert(M.ZeroAddress.selector);
        s.recover(address(wpol), 1, address(0));
        vm.expectRevert(M.ZeroAmount.selector);
        s.recover(address(wpol), 0, owner);
        vm.stopPrank();
        _warp(7 days);
        vm.prank(alice);
        s.claim(address(wpol));
        assertApproxEqAbs(wpol.balanceOf(alice), 100 ether, 1e3);
    }

    function test_recoverUnlistedToken() public {
        MockERC20 junk = new MockERC20("J", "J", 18);
        junk.mint(address(s), 5 ether);
        vm.prank(owner);
        s.recover(address(junk), 5 ether, owner);
        assertEq(junk.balanceOf(owner), 5 ether);
    }

    function test_recoverNeverTakesPrincipal() public {
        _stake(alice, 10 ether);
        bzb.mint(address(s), 1 ether);
        vm.startPrank(owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), 1 ether + 1, owner);
        s.recover(address(bzb), 1 ether, owner);
        vm.stopPrank();
        vm.prank(alice);
        s.withdraw(10 ether);
        assertEq(bzb.balanceOf(alice), 10 ether);
    }

    // ---------------------------------------------------------------- BZB as reward

    function test_bzbAsRewardKeepsPrincipalSeparate() public {
        vm.prank(owner);
        s.addRewardToken(address(bzb));
        _stake(alice, 100 ether);
        _stake(bob, 100 ether);
        _fund(address(bzb), 20 ether, 2 days, 1, 1);
        assertEq(s.reserved(address(bzb)), 220 ether);
        assertEq(s.recoverable(address(bzb)), 0);
        _warp(2 days);
        vm.prank(alice);
        s.exit();
        assertApproxEqAbs(bzb.balanceOf(alice), 110 ether, 1e3);
        vm.prank(bob);
        s.withdraw(100 ether);
        assertEq(bzb.balanceOf(bob), 100 ether);
        vm.prank(bob);
        s.claim(address(bzb));
        assertApproxEqAbs(bzb.balanceOf(bob), 110 ether, 1e3);
        assertLe(bzb.balanceOf(alice) + bzb.balanceOf(bob), 220 ether);
    }

    // ---------------------------------------------------------------- weird tokens

    function test_feeOnTransferRewardCreditsReceived() public {
        TaxToken tax = new TaxToken(1000, makeAddr("sink")); // 10%
        vm.prank(owner);
        s.addRewardToken(address(tax));
        _stake(alice, 1 ether);
        tax.mint(owner, 100 ether);
        vm.startPrank(owner);
        tax.approve(address(s), 100 ether);
        s.notifyRewardAmount(_cfg(address(tax), 100 ether, 1 days, 1, 1));
        vm.stopPrank();
        assertEq(s.getRun(address(tax), 0).amount, 90 ether);
        _warp(1 days);
        vm.prank(alice);
        s.claim(address(tax));
        assertGe(tax.balanceOf(address(s)), s.reserved(address(tax)));
    }

    function test_feeOnTransferStakeCreditsReceived() public {
        TaxToken tax = new TaxToken(500, makeAddr("sink"));
        M t = new M(owner, address(tax), MIN);
        tax.mint(alice, 100 ether);
        vm.startPrank(alice);
        tax.approve(address(t), 100 ether);
        t.stake(100 ether);
        assertEq(t.balanceOf(alice), 95 ether);
        assertEq(t.totalStaked(), 95 ether);
        t.withdraw(95 ether);
        vm.stopPrank();
        assertEq(t.totalStaked(), 0);
    }

    function test_blacklistedRewardDoesNotBlockWithdrawOrOtherClaims() public {
        BlacklistToken blk = new BlacklistToken();
        vm.prank(owner);
        s.addRewardToken(address(blk));
        _stake(alice, 10 ether);
        _fund(address(wpol), 10 ether, 1 days, 1, 1);
        blk.mint(owner, 10 ether);
        vm.startPrank(owner);
        blk.approve(address(s), 10 ether);
        s.notifyRewardAmount(_cfg(address(blk), 10 ether, 1 days, 1, 1));
        vm.stopPrank();
        _warp(1 days);
        blk.setFrozen(true);

        vm.startPrank(alice);
        vm.expectRevert(bytes("frozen"));
        s.claimAll();
        vm.expectRevert(bytes("frozen"));
        s.exit();
        s.claim(address(wpol));
        s.withdraw(10 ether);
        vm.stopPrank();
        assertApproxEqAbs(wpol.balanceOf(alice), 10 ether, 1e3);
        assertEq(bzb.balanceOf(alice), 10 ether);
        // BLK stays owed and is claimable once the token works again.
        uint256 owedBlk = s.earned(alice, address(blk));
        assertApproxEqAbs(owedBlk, 10 ether, 1e3);
        blk.setFrozen(false);
        address[] memory list = new address[](1);
        list[0] = address(blk);
        vm.prank(alice);
        s.claimMany(list);
        assertEq(blk.balanceOf(alice), owedBlk);
    }

    function test_reentrantRewardTokenCannotReenter() public {
        ReentrantToken re = new ReentrantToken();
        vm.prank(owner);
        s.addRewardToken(address(re));
        _stake(alice, 10 ether);
        re.mint(owner, 10 ether);
        vm.startPrank(owner);
        re.approve(address(s), 10 ether);
        s.notifyRewardAmount(_cfg(address(re), 10 ether, 1 days, 1, 1));
        vm.stopPrank();
        _warp(1 days);
        re.arm(address(s), 2);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        s.claim(address(re));
        re.arm(address(s), 1);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        s.claim(address(re));
        re.arm(address(0), 0);
        vm.prank(alice);
        s.claim(address(re));
        assertApproxEqAbs(re.balanceOf(alice), 10 ether, 1e3);
    }

    // ---------------------------------------------------------------- pause & emergency

    function test_pauseBlocksStakeOnly() public {
        _stake(alice, 10 ether);
        _fund(address(wpol), 10 ether, 1 days, 1, 1);
        vm.prank(owner);
        s.pause();
        bzb.mint(bob, 1 ether);
        vm.startPrank(bob);
        bzb.approve(address(s), 1 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        s.stake(1 ether);
        vm.stopPrank();
        _warp(1 days);
        vm.startPrank(alice);
        s.claim(address(wpol));
        s.withdraw(5 ether);
        s.emergencyWithdraw();
        vm.stopPrank();
        assertEq(bzb.balanceOf(alice), 10 ether);
        assertApproxEqAbs(wpol.balanceOf(alice), 10 ether, 1e3);
        vm.prank(owner);
        s.unpause();
        vm.prank(bob);
        s.stake(1 ether);
    }

    function test_emergencyWithdrawKeepsCreditedRewards() public {
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        _warp(5 days);
        vm.prank(alice);
        s.claim(address(wpol)); // checkpoint + pay ~25
        _warp(1 days);
        vm.prank(alice);
        s.emergencyWithdraw(); // L-1: settles first, keeps the ~5 accrued since her last claim
        assertEq(bzb.balanceOf(alice), 10 ether);
        assertEq(s.balanceOf(alice), 0);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 5 ether, 1e3);
        _warp(4 days);
        uint256 bobEarned = s.earned(bob, address(wpol));
        // bob: 30 for days 0-6 (half) + 40 for days 6-10 (alone).
        assertApproxEqAbs(bobEarned, 70 ether, 1e3);
        assertLe(wpol.balanceOf(alice) + s.earned(alice, address(wpol)) + bobEarned, 100 ether);
        // alice can restake cleanly.
        vm.startPrank(alice);
        bzb.approve(address(s), 10 ether);
        s.stake(10 ether);
        vm.stopPrank();
        assertApproxEqAbs(s.earned(alice, address(wpol)), 5 ether, 1e3); // credited share kept, no new accrual yet
        vm.prank(alice);
        vm.expectRevert(M.ZeroAmount.selector);
        s.withdraw(0);
        vm.prank(bob);
        vm.expectRevert(M.InsufficientBalance.selector);
        s.withdraw(11 ether);
    }

    function test_minStakeEnforced() public {
        bzb.mint(alice, 10 ether);
        vm.startPrank(alice);
        bzb.approve(address(s), type(uint256).max);
        vm.expectRevert(M.BelowMinStake.selector);
        s.stake(MIN - 1);
        s.stake(MIN);
        s.stake(1); // topping up an existing position is fine
        vm.expectRevert(M.BelowMinStake.selector);
        s.withdraw(2); // would leave MIN - 1
        s.withdraw(MIN + 1); // full exit always allowed
        vm.stopPrank();
        assertEq(s.balanceOf(alice), 0);
    }

    function test_delayedRunAlongsideLiveRunAllowed() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 10 ether, 2 days, 1, 1);
        _warp(1 days);
        wpol.mint(owner, 1 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 1 ether);
        M.RunConfig memory c = _cfg(address(wpol), 1 ether, 2 days, 1, 1);
        c.startTime = uint64(vm.getBlockTimestamp() + 1 days); // starts when run 1 ends
        s.notifyRewardAmount(c);
        vm.stopPrank();
        _warp(1 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 10 ether, 1e3);
        _warp(2 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 11 ether, 1e3);
    }

    function test_emergencyWithdrawZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(M.ZeroAmount.selector);
        s.emergencyWithdraw();
    }

    function test_gasWorstCaseFiveTokensFiveRunsEach() public {
        vm.startPrank(owner);
        s.addRewardToken(address(bzb));
        address[] memory extra = new address[](2);
        for (uint256 i; i < 2; ++i) {
            extra[i] = address(new MockERC20("X", "X", 18));
        }
        s.addRewardTokens(extra);
        vm.stopPrank();
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        address[] memory all = s.rewardTokens();
        assertEq(all.length, 5);
        for (uint256 i; i < all.length; ++i) {
            for (uint256 j; j < 5; ++j) {
                _fund(all[i], 100 ether, uint64(30 days + j * 1 days), uint16(1 + j), uint16(5 - j));
            }
        }
        _warp(3 days);
        vm.prank(alice);
        uint256 g = gasleft();
        s.withdraw(1 ether);
        uint256 used = g - gasleft();
        emit log_named_uint("withdraw gas, 5 tokens x 5 live runs, first checkpoint", used);
        assertLt(used, 1_000_000);
        _warp(1 hours);
        vm.prank(alice);
        g = gasleft();
        s.withdraw(1 ether);
        used = g - gasleft();
        emit log_named_uint("withdraw gas, 5 tokens x 5 live runs, steady state", used);
        assertLt(used, 700_000);
        _warp(1 days);
        vm.prank(alice);
        g = gasleft();
        s.claimAll();
        used = g - gasleft();
        emit log_named_uint("claimAll gas, 5 tokens x 5 runs", used);
        assertLt(used, 900_000);
        _warp(40 days); // all 25 runs finish; next checkpoint prunes them all
        vm.prank(alice);
        g = gasleft();
        s.withdraw(1 ether);
        used = g - gasleft();
        emit log_named_uint("withdraw gas, pruning 25 finished runs", used);
        assertLt(used, 700_000);
        vm.prank(bob);
        g = gasleft();
        s.emergencyWithdraw();
        used = g - gasleft();
        // L-1: settles all 5 tokens x 5 runs first (bob never checkpointed, so 10 fresh user slots).
        emit log_named_uint("emergencyWithdraw gas, 5 tokens x 5 runs, first credit", used);
        assertLt(used, 900_000);
    }

    // ---------------------------------------------------------------- reviewer findings (prelim 9c74471)

    /// P-1 regression: emergencyWithdraw credits the user's already-settled share instead of stranding it in `owed`.
    function test_P1_emergencyWithdrawCreditsCheckpointedShare() public {
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        _warp(10 days);
        vm.prank(bob);
        s.claim(address(wpol)); // global checkpoint; alice's 50 is settled into rpt but not credited to her
        vm.prank(alice);
        s.emergencyWithdraw();
        assertApproxEqAbs(s.rewards(alice, address(wpol)), 50 ether, 1e3);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 50 ether, 1e3);
        vm.prank(bob);
        s.withdraw(10 ether);
        vm.prank(alice);
        s.claim(address(wpol));
        assertApproxEqAbs(wpol.balanceOf(alice), 50 ether, 1e3);
        assertLe(s.owedStored(address(wpol)), 10); // only rounding dust remains reserved
        wpol.mint(address(s), 1 ether);
        vm.prank(owner);
        s.recover(address(wpol), 1 ether, owner); // no longer Underfunded
    }

    /// L-1: the LAST staker's emergency exit now settles first, so they keep the full share; nothing becomes
    /// owner surplus except emission after they left.
    function test_L1_lastEmergencyExitKeepsFullShare() public {
        _stake(alice, 10 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        _warp(4 days);
        vm.prank(alice);
        s.claim(address(wpol)); // pays 40
        _warp(1 days); // 10 pending, never checkpointed
        vm.prank(alice);
        s.emergencyWithdraw();
        assertApproxEqAbs(s.earned(alice, address(wpol)), 10 ether, 1e3);
        assertLe(s.recoverable(address(wpol)), 1);
        _warp(1 days); // nobody staked now: this day's 10 is surplus
        assertApproxEqAbs(s.recoverable(address(wpol)), 10 ether, 1e3);
        assertApproxEqAbs(s.unemitted(address(wpol)), 40 ether, 1);
    }

    /// checkpoint(tokens) settles globally and for the caller without transferring, even if transfers fail.
    function test_checkpointWithoutTransfer() public {
        BlacklistToken blk = new BlacklistToken();
        vm.prank(owner);
        s.addRewardToken(address(blk));
        _stake(alice, 10 ether);
        blk.mint(owner, 10 ether);
        vm.startPrank(owner);
        blk.approve(address(s), 10 ether);
        s.notifyRewardAmount(_cfg(address(blk), 10 ether, 2 days, 1, 1));
        vm.stopPrank();
        _warp(1 days);
        blk.setFrozen(true);
        address[] memory list = new address[](2);
        list[0] = address(blk);
        list[1] = address(0xdead); // unlisted: ignored
        vm.prank(alice);
        s.checkpoint(list);
        assertApproxEqAbs(s.rewards(alice, address(blk)), 5 ether, 1e3);
        assertApproxEqAbs(s.getRun(address(blk), 0).emitted, 5 ether, 1);
        assertEq(blk.balanceOf(alice), 0);
        vm.prank(alice);
        s.emergencyWithdraw(); // frozen reward token cannot block the exit
        assertEq(bzb.balanceOf(alice), 10 ether);
    }

    function test_I1_cannotListSelf() public {
        vm.prank(owner);
        vm.expectRevert(M.CannotListSelf.selector);
        s.addRewardToken(address(s));
    }

    /// P-3: claim(token) settles only that token.
    function test_P3_claimSettlesOnlyThatToken() public {
        _stake(alice, 10 ether);
        _fund(address(wpol), 10 ether, 1 days, 1, 1);
        _fund(address(usdc), 10e6, 1 days, 1, 1);
        _warp(1 days);
        vm.prank(alice);
        s.claim(address(usdc));
        assertEq(s.userRewardPerTokenPaid(alice, address(wpol)), 0);
        assertGt(s.userRewardPerTokenPaid(alice, address(usdc)), 0);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 10 ether, 1e3); // still exact
        vm.prank(alice);
        s.claim(address(wpol));
        assertApproxEqAbs(wpol.balanceOf(alice), 10 ether, 1e3);
        // unlisted token: no-op, no revert
        vm.prank(alice);
        s.claim(address(0xdead));
    }

    /// P-4: a blacklisted user can redirect a payout.
    function test_P4_claimToRedirectsBlacklistedUser() public {
        BlacklistToken blk = new BlacklistToken();
        vm.prank(owner);
        s.addRewardToken(address(blk));
        _stake(alice, 10 ether);
        blk.mint(owner, 10 ether);
        vm.startPrank(owner);
        blk.approve(address(s), 10 ether);
        s.notifyRewardAmount(_cfg(address(blk), 10 ether, 1 days, 1, 1));
        vm.stopPrank();
        _fund(address(wpol), 4 ether, 1 days, 1, 1);
        _warp(1 days);
        blk.setBlocked(alice, true);
        address carol = makeAddr("carol");
        vm.startPrank(alice);
        vm.expectRevert(bytes("blocked"));
        s.claim(address(blk));
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimTo(address(blk), address(0));
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimTo(address(blk), address(s));
        s.claimTo(address(blk), carol);
        address[] memory list = new address[](2);
        list[0] = address(wpol);
        list[1] = address(blk); // already paid -> zero, skipped
        s.claimManyTo(list, carol);
        vm.expectRevert(M.ZeroAddress.selector);
        s.claimManyTo(list, address(0));
        vm.stopPrank();
        assertApproxEqAbs(blk.balanceOf(carol), 10 ether, 1e3);
        assertApproxEqAbs(wpol.balanceOf(carol), 4 ether, 1e3);
        assertEq(s.earned(alice, address(blk)), 0);
    }

    // ---------------------------------------------------------------- principal is owner-proof

    function test_ownerCannotDrainOrFreezePrincipal() public {
        vm.prank(owner);
        s.addRewardToken(address(bzb));
        _stake(alice, 100 ether);
        _stake(bob, 100 ether);
        _fund(address(bzb), 10 ether, 2 days, 1, 1);
        bzb.mint(address(s), 3 ether); // donation = the only surplus
        _warp(1 days);

        vm.startPrank(owner);
        uint256 free = s.recoverable(address(bzb));
        assertApproxEqAbs(free, 3 ether, 1);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), free + 1, owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), 200 ether, owner);
        s.recover(address(bzb), free, owner);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), 1, owner);
        s.pause();
        vm.stopPrank();

        assertGe(bzb.balanceOf(address(s)), s.totalStaked() + s.owedStored(address(bzb)) + s.unemitted(address(bzb)));
        // Paused: both exits still work and return exact principal.
        vm.prank(alice);
        s.withdraw(100 ether);
        assertEq(bzb.balanceOf(alice), 100 ether);
        vm.prank(bob);
        s.emergencyWithdraw();
        assertEq(bzb.balanceOf(bob), 100 ether);
        // Rewards also still claimable while paused.
        vm.prank(alice);
        s.claim(address(bzb));
        assertGt(bzb.balanceOf(alice), 100 ether);
    }

    function test_newOwnerHasSameLimits() public {
        _stake(alice, 50 ether);
        vm.prank(owner);
        s.transferOwnership(bob);
        vm.prank(bob);
        s.acceptOwnership();
        vm.prank(bob);
        vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), 1, bob);
        vm.prank(alice);
        s.withdraw(50 ether);
        assertEq(bzb.balanceOf(alice), 50 ether);
    }

    /// Runtime bytecode has no DELEGATECALL, CALLCODE or SELFDESTRUCT (opcode walk skips PUSH data and
    /// the trailing CBOR metadata). There is also no setter for the staking token: it is `immutable`.
    function test_noDelegatecallOrSelfdestruct() public view {
        bytes memory code = address(s).code;
        uint256 metaLen = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        uint256 end = code.length - metaLen - 2;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xf4 && op != 0xf2 && op != 0xff, "forbidden opcode");
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
    }

    /// Any owner action sequence leaves every staker able to withdraw exact principal.
    function testFuzz_ownerActionsNeverReducePrincipal(
        uint256 stakeA,
        uint256 stakeB,
        uint256 fundAmt,
        uint256 donation,
        uint256 recoverAmt,
        uint256 dt,
        bool pauseIt
    ) public {
        stakeA = bound(stakeA, MIN, 1e27);
        stakeB = bound(stakeB, MIN, 1e27);
        fundAmt = bound(fundAmt, 1, 1e27);
        donation = bound(donation, 0, 1e24);
        dt = bound(dt, 0, 40 days);
        vm.prank(owner);
        s.addRewardToken(address(bzb));
        _stake(alice, stakeA);
        _stake(bob, stakeB);
        _fund(address(bzb), fundAmt, 30 days, 1, 3);
        if (donation > 0) bzb.mint(address(s), donation);
        _warp(dt);
        recoverAmt = bound(recoverAmt, 1, bzb.balanceOf(address(s)));
        uint256 free = s.recoverable(address(bzb));
        vm.startPrank(owner);
        if (recoverAmt > free) vm.expectRevert(M.Underfunded.selector);
        s.recover(address(bzb), recoverAmt, owner);
        if (pauseIt) s.pause();
        vm.stopPrank();
        assertGe(
            bzb.balanceOf(address(s)), s.totalStaked() + s.earned(alice, address(bzb)) + s.earned(bob, address(bzb))
        );
        vm.prank(alice);
        s.withdraw(stakeA);
        vm.prank(bob);
        s.emergencyWithdraw();
        assertEq(bzb.balanceOf(alice), stakeA);
        assertEq(bzb.balanceOf(bob), stakeB);
        vm.prank(alice);
        s.claim(address(bzb));
    }

    /// Up to five overlapping runs with random curves, starts and durations: payouts never exceed funding and
    /// match it (minus dust) when someone is staked the whole time.
    function testFuzz_overlappingRunsSumToFunded(
        uint96[5] memory amounts,
        uint64[5] memory durations,
        uint16[5] memory wS,
        uint16[5] memory wE,
        uint64[5] memory delays,
        uint256[6] memory steps,
        uint256 stakeA,
        uint256 stakeB
    ) public {
        stakeA = bound(stakeA, MIN, 1e30);
        stakeB = bound(stakeB, MIN, 1e30);
        _stake(alice, stakeA);
        _stake(bob, stakeB);
        uint256 funded;
        for (uint256 i; i < 5; ++i) {
            uint256 amt = bound(amounts[i], 1, type(uint96).max);
            uint16 a = uint16(bound(wS[i], 0, 10_000));
            uint16 b = uint16(bound(wE[i], 0, 10_000));
            if (uint256(a) + b == 0) b = 1;
            M.RunConfig memory c = _cfg(address(wpol), amt, uint64(bound(durations[i], 1 days, 365 days)), a, b);
            uint256 d = bound(delays[i], 0, 30 days);
            if (d > 0) c.startTime = uint64(vm.getBlockTimestamp() + d);
            wpol.mint(owner, amt);
            vm.startPrank(owner);
            wpol.approve(address(s), amt);
            s.notifyRewardAmount(c);
            vm.stopPrank();
            funded += amt;
        }
        for (uint256 i; i < steps.length; ++i) {
            _warp(bound(steps[i], 0, 60 days));
            vm.prank(alice);
            s.claim(address(wpol));
            assertLe(wpol.balanceOf(alice) + s.earned(bob, address(wpol)), funded);
            assertGe(wpol.balanceOf(address(s)), s.reserved(address(wpol)));
        }
        _warp(400 days);
        vm.prank(alice);
        s.claim(address(wpol));
        vm.prank(bob);
        s.claim(address(wpol));
        uint256 paid = wpol.balanceOf(alice) + wpol.balanceOf(bob);
        assertLe(paid, funded);
        assertGe(paid + 40, funded);
        assertEq(s.activeRunCount(address(wpol)), 0);
        assertEq(s.unemitted(address(wpol)), 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// The curve integrates exactly: monotone, ends at `amount`, and any checkpoint sequence telescopes.
    function testFuzz_curveIntegratesToAmount(
        uint128 amount,
        uint64 duration,
        uint16 wS,
        uint16 wE,
        uint256[8] memory cuts
    ) public view {
        duration = uint64(bound(duration, 1 days, 365 days));
        wS = uint16(bound(wS, 0, 10_000));
        wE = uint16(bound(wE, 0, 10_000));
        vm.assume(uint256(wS) + wE > 0);
        uint256 last;
        uint256 prevE;
        uint256 sum;
        for (uint256 i; i < cuts.length; ++i) {
            uint256 t = bound(cuts[i], last, uint256(duration) + 1);
            uint256 e = s.curveEmitted(amount, duration, wS, wE, t);
            assertGe(e, prevE, "monotone");
            assertLe(e, amount, "capped");
            sum += e - prevE;
            prevE = e;
            last = t;
        }
        uint256 fin = s.curveEmitted(amount, duration, wS, wE, duration);
        sum += fin - prevE;
        assertEq(fin, amount);
        assertEq(sum, amount);
        assertEq(s.curveEmitted(amount, duration, wS, wE, 0), 0);
    }

    /// Checkpoint frequency never changes payout beyond dust and never exceeds the funded amount.
    function testFuzz_checkpointFrequencyNoExploit(
        uint96 amount,
        uint256 stakeA,
        uint256 stakeB,
        uint16 wS,
        uint16 wE,
        uint256[10] memory steps
    ) public {
        amount = uint96(bound(amount, 1e6, type(uint96).max));
        stakeA = bound(stakeA, MIN, 1e30);
        stakeB = bound(stakeB, MIN, 1e30);
        wS = uint16(bound(wS, 0, 10_000));
        wE = uint16(bound(wE, 0, 10_000));
        vm.assume(uint256(wS) + wE > 0);
        _stake(alice, stakeA);
        _stake(bob, stakeB);
        _fund(address(usdc), amount, 30 days, wS, wE);
        for (uint256 i; i < steps.length; ++i) {
            _warp(bound(steps[i], 0, 4 days));
            vm.prank(alice);
            s.claim(address(usdc)); // alice checkpoints constantly; bob never does
        }
        _warp(30 days);
        vm.prank(alice);
        s.claim(address(usdc));
        vm.prank(bob);
        s.claim(address(usdc));
        uint256 a = usdc.balanceOf(alice);
        uint256 b = usdc.balanceOf(bob);
        assertLe(a + b, amount);
        // Dust bound: < 1 wei per checkpoint per user plus 1e36-scale truncation.
        assertGe(a + b + 30, amount);
        uint256 expectedA = uint256(amount) * stakeA / (stakeA + stakeB);
        assertApproxEqAbs(a, expectedA, 30);
        assertGe(usdc.balanceOf(address(s)), s.reserved(address(usdc)));
    }

    function testFuzz_lowDecimalRewardWithHugeStakeKeepsPrecision(uint256 total) public {
        total = bound(total, 1e24, 1e30); // 1M .. 1T BZB staked
        _stake(alice, total / 2);
        _stake(bob, total - total / 2);
        _fund(address(usdc), 100e6, 365 days, 1, 1); // 100 USDC over a year
        _warp(1 hours);
        vm.prank(alice);
        s.claim(address(usdc));
        // ~100e6 * 3600 / 31536000 / 2 ≈ 5707 wei
        assertApproxEqAbs(usdc.balanceOf(alice), uint256(100e6) * 3600 / 365 days / 2, 2);
    }
}
