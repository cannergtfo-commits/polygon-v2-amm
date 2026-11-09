// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarDailyRewards} from "../src/BlazarDailyRewards.sol";
import {MockERC20} from "./Mocks.sol";

contract BlazarDailyRewardsTest is Test {
    address internal owner = makeAddr("owner");
    address internal poster = makeAddr("poster");
    MockERC20 internal bzb;
    BlazarDailyRewards internal rewards;

    address internal a = makeAddr("a");
    address internal b = makeAddr("b");
    address internal c = makeAddr("c");

    function setUp() public {
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        rewards = new BlazarDailyRewards(owner, address(bzb), poster);
        bzb.mint(owner, 10_000 ether);
        vm.prank(owner);
        bzb.approve(address(rewards), type(uint256).max);
        vm.prank(owner);
        rewards.fund(1_000 ether);
    }

    function _blank() internal pure returns (address[25] memory traders, uint256[25] memory amounts) {}

    function test_shareTableSumsTo100PercentAndDescends() public view {
        uint256 sum;
        uint256 prev = type(uint256).max;
        for (uint256 i; i < 25; ++i) {
            uint256 bps = rewards.shareBps(i);
            sum += bps;
            assertLt(bps, prev);
            prev = bps;
        }
        assertEq(sum, 10_000);
        assertEq(rewards.INITIAL_POSTER(), 0x55BA739Ba386D634CF81bd53d974dAF95241952C);
        assertEq(rewards.shareBps(0), 1_500);
        assertEq(rewards.shareBps(1), 1_000);
        assertEq(rewards.shareBps(2), 500);
    }

    function test_posterPaysExactSharesAndUnfilledRanksStayInThePot() public {
        vm.warp(3 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        traders[1] = b;
        amounts[0] = 150 ether;
        amounts[1] = 100 ether;
        vm.prank(poster);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);
        assertEq(rewards.reserved(), 250 ether);
        assertEq(rewards.claimable(block.timestamp / 1 days - 1, a), 150 ether);

        vm.prank(a);
        rewards.claim(block.timestamp / 1 days - 1);
        assertEq(bzb.balanceOf(a), 150 ether);
        vm.prank(a);
        vm.expectRevert(BlazarDailyRewards.NothingToClaim.selector);
        rewards.claim(block.timestamp / 1 days - 1);
        vm.prank(b);
        rewards.claim(block.timestamp / 1 days - 1);
        vm.prank(c);
        vm.expectRevert(BlazarDailyRewards.NothingToClaim.selector);
        rewards.claim(block.timestamp / 1 days - 1);
    }

    function test_ownerCannotPostAndPosterCannotChangeSchedule() public {
        vm.warp(3 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        amounts[0] = 150 ether;
        vm.prank(owner);
        vm.expectRevert(BlazarDailyRewards.NotPoster.selector);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);

        vm.prank(poster);
        vm.expectRevert();
        rewards.setSchedule(100 ether, 30 days);

        address next = makeAddr("next");
        vm.prank(owner);
        rewards.setPoster(next);
        vm.prank(next);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);
        (address trader, uint256 amount) = rewards.winner(block.timestamp / 1 days - 1, 0);
        assertEq(trader, a);
        assertEq(amount, 150 ether);
    }

    function test_wrongShareCapAndOpenDayRevert() public {
        vm.warp(3 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        amounts[0] = 149 ether;
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(BlazarDailyRewards.WrongShare.selector, uint256(0), uint256(150 ether), uint256(149 ether)));
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);

        vm.prank(owner);
        vm.expectRevert(BlazarDailyRewards.Cap.selector);
        rewards.setSchedule(1000 ether + 1, 30 days);

        amounts[0] = 150 ether;
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(BlazarDailyRewards.DayStillOpen.selector, uint256(3)));
        rewards.postWinners(3, traders, amounts);
    }

    function test_pauseBlocksClaimAndEmergencyRespectsReserve() public {
        vm.warp(3 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        amounts[0] = 150 ether;
        vm.prank(poster);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);

        uint256 free = bzb.balanceOf(address(rewards)) - rewards.reserved();
        vm.startPrank(owner);
        rewards.emergencyWithdraw(address(bzb), free, owner);
        vm.expectRevert(BlazarDailyRewards.Reserved.selector);
        rewards.emergencyWithdraw(address(bzb), 1, owner);
        rewards.pause();
        uint256 locked = rewards.reserved();
        vm.expectRevert(BlazarDailyRewards.Reserved.selector);
        rewards.emergencyWithdraw(address(bzb), locked, owner);
        vm.stopPrank();
        vm.prank(a);
        vm.expectRevert();
        rewards.claim(block.timestamp / 1 days - 1);
        vm.prank(owner);
        rewards.unpause();
        vm.prank(a);
        rewards.claim(block.timestamp / 1 days - 1);
        assertEq(bzb.balanceOf(a), 150 ether);
        assertEq(rewards.reserved(), 0);
    }

    function test_secondFullDayIsInsolventAndADayCannotBePostedTwice() public {
        vm.warp(4 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        for (uint256 i; i < 25; ++i) {
            traders[i] = address(uint160(0x1000 + i));
            amounts[i] = rewards.dailyCap() * rewards.shareBps(i) / 10_000;
        }
        vm.startPrank(poster);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);
        vm.expectRevert(abi.encodeWithSelector(BlazarDailyRewards.AlreadyPosted.selector, block.timestamp / 1 days - 1));
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);
        vm.expectRevert(abi.encodeWithSelector(BlazarDailyRewards.StaleDay.selector, uint256(1)));
        rewards.postWinners(1, traders, amounts);
        vm.stopPrank();
        assertEq(rewards.reserved(), 1_000 ether);
        assertEq(rewards.postedThisDay(), 1_000 ether);
    }

    function test_claimManySameDayDoesNotPayTwice() public {
        vm.warp(3 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        amounts[0] = 150 ether;
        vm.prank(poster);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);
        uint256[] memory days_ = new uint256[](2);
        days_[0] = block.timestamp / 1 days - 1;
        days_[1] = block.timestamp / 1 days - 1;
        vm.prank(a);
        vm.expectRevert(BlazarDailyRewards.NothingToClaim.selector);
        rewards.claimMany(days_);
        assertEq(bzb.balanceOf(a), 0);
        assertEq(rewards.reserved(), 150 ether);
    }

    function test_raisingTheCapDoesNotPayABacklog() public {
        vm.warp(30 days);
        vm.prank(owner);
        rewards.setSchedule(100 ether, 7 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        amounts[0] = 15 ether;
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(BlazarDailyRewards.StaleDay.selector, uint256(1)));
        rewards.postWinners(1, traders, amounts);
        uint256 yesterday = block.timestamp / 1 days - 1;
        vm.prank(poster);
        rewards.postWinners(yesterday, traders, amounts);
        assertEq(rewards.postedThisDay(), 15 ether);
        assertEq(rewards.reserved(), 15 ether);
        vm.prank(owner);
        rewards.setSchedule(1_000 ether, 7 days);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(BlazarDailyRewards.AlreadyPosted.selector, yesterday));
        rewards.postWinners(yesterday, traders, amounts);
        assertEq(rewards.reserved(), 15 ether);
    }

    function test_duplicateTraderReverts() public {
        vm.warp(3 days);
        (address[25] memory traders, uint256[25] memory amounts) = _blank();
        traders[0] = a;
        traders[1] = a;
        amounts[0] = 150 ether;
        amounts[1] = 100 ether;
        vm.prank(poster);
        vm.expectRevert(BlazarDailyRewards.DuplicateTrader.selector);
        rewards.postWinners(block.timestamp / 1 days - 1, traders, amounts);
    }
}
