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
        _expectDeployRevert(address(bzb), 0, M.ZeroAmount.selector);
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
        for (uint256 i; i < 7; ++i) {
            s.addRewardToken(address(new MockERC20("X", "X", 18)));
        }
        assertEq(s.rewardTokensLength(), 10);
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
        assertEq(s.runEnd(address(wpol)), c.startTime + 1 days);
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

    function test_topUpMidRunRollsOverExactly() public {
        _stake(alice, 5 ether);
        _fund(address(wpol), 100 ether, 10 days, 1, 1);
        _warp(4 days);
        _fund(address(wpol), 50 ether, 5 days, 3, 1); // 60 left + 50 new over 5 days, decreasing
        M.Run memory r = s.getRun(address(wpol));
        assertApproxEqAbs(uint256(r.amount), 110 ether, 1);
        _warp(5 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 150 ether, 1e3);
        assertLe(s.earned(alice, address(wpol)), 150 ether);
    }

    function test_topUpOfScheduledRunRollsAll() public {
        _stake(alice, 5 ether);
        wpol.mint(owner, 10 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 10 ether);
        M.RunConfig memory c = _cfg(address(wpol), 10 ether, 1 days, 1, 1);
        c.startTime = uint64(block.timestamp + 1 days);
        s.notifyRewardAmount(c);
        vm.stopPrank();
        _fund(address(wpol), 5 ether, 1 days, 1, 1);
        assertEq(s.getRun(address(wpol)).amount, 15 ether);
        _warp(1 days);
        assertApproxEqAbs(s.earned(alice, address(wpol)), 15 ether, 1e3);
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
        assertEq(s.getRun(address(tax)).amount, 90 ether);
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
        s.emergencyWithdraw(); // forfeits ~5 accrued since checkpoint
        assertEq(bzb.balanceOf(alice), 10 ether);
        assertEq(s.balanceOf(alice), 0);
        assertEq(s.earned(alice, address(wpol)), 0);
        _warp(4 days);
        uint256 bobEarned = s.earned(bob, address(wpol));
        // bob gets his 25 + 5 (day 5-6, alone after alice's exit) + 40.
        assertApproxEqAbs(bobEarned, 75 ether, 1e3);
        assertLe(wpol.balanceOf(alice) + bobEarned, 100 ether);
        // alice can restake cleanly.
        vm.startPrank(alice);
        bzb.approve(address(s), 10 ether);
        s.stake(10 ether);
        vm.stopPrank();
        assertEq(s.earned(alice, address(wpol)), 0);
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

    function test_noDelayedStartWhenRemainderExists() public {
        _stake(alice, 1 ether);
        _fund(address(wpol), 10 ether, 2 days, 1, 1);
        _warp(1 days);
        wpol.mint(owner, 1 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 1 ether);
        M.RunConfig memory c = _cfg(address(wpol), 1 ether, 2 days, 1, 1);
        c.startTime = uint64(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(M.BadStart.selector);
        s.notifyRewardAmount(c);
        vm.stopPrank();
        // After the run ends (nothing left to roll over), a delayed start is allowed again.
        _warp(1 days);
        wpol.mint(owner, 1 ether);
        vm.startPrank(owner);
        wpol.approve(address(s), 1 ether);
        c.startTime = uint64(vm.getBlockTimestamp() + 1 days);
        s.notifyRewardAmount(c);
        vm.stopPrank();
    }

    function test_emergencyWithdrawZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(M.ZeroAmount.selector);
        s.emergencyWithdraw();
    }

    function test_gasWorstCaseWithdrawAndClaimAllTenTokens() public {
        vm.startPrank(owner);
        s.addRewardToken(address(bzb));
        address[] memory extra = new address[](7);
        for (uint256 i; i < 7; ++i) {
            extra[i] = address(new MockERC20("X", "X", 18));
        }
        s.addRewardTokens(extra);
        vm.stopPrank();
        _stake(alice, 10 ether);
        _stake(bob, 10 ether);
        address[] memory all = s.rewardTokens();
        for (uint256 i; i < all.length; ++i) {
            _fund(all[i], 100 ether, 30 days, 1, 2);
        }
        _warp(3 days);
        vm.prank(alice);
        uint256 g = gasleft();
        s.withdraw(1 ether);
        uint256 used = g - gasleft();
        emit log_named_uint("withdraw gas, 10 live reward tokens, first checkpoint", used);
        assertLt(used, 1_500_000);
        _warp(1 hours);
        vm.prank(alice);
        g = gasleft();
        s.withdraw(1 ether);
        used = g - gasleft();
        emit log_named_uint("withdraw gas, 10 live reward tokens, steady state", used);
        assertLt(used, 1_000_000);
        _warp(1 days);
        vm.prank(alice);
        g = gasleft();
        s.claimAll();
        used = g - gasleft();
        emit log_named_uint("claimAll gas, 10 tokens", used);
        assertLt(used, 1_500_000);
        vm.prank(bob);
        g = gasleft();
        s.emergencyWithdraw();
        assertLt(g - gasleft(), 100_000);
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
