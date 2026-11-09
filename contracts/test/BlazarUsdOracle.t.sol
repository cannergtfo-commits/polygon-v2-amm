// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarUsdOracle} from "../src/BlazarUsdOracle.sol";
import {MockERC20, MockFeed, MockPair} from "./Mocks.sol";

contract BlazarUsdOracleTest is Test {
    address internal owner = makeAddr("owner");
    MockERC20 internal wpol;
    MockERC20 internal bzb;
    MockFeed internal feed;
    BlazarUsdOracle internal oracle;

    function setUp() public {
        wpol = new MockERC20("WPOL", "WPOL", 18);
        bzb = new MockERC20("BZB", "BZB", 18);
        feed = new MockFeed(9_000_000, 8); // $0.09
        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        uint8[] memory decimals = new uint8[](1);
        tokens[0] = address(wpol);
        feeds[0] = address(feed);
        decimals[0] = 18;
        oracle = new BlazarUsdOracle(owner, tokens, feeds, decimals);
    }

    function test_chainlinkQuoteIsTrusted() public {
        (uint256 usd, bool trusted) = oracle.quote(address(wpol), 1 ether);
        assertEq(usd, 9_000_000);
        assertTrue(trusted);
    }

    function test_staleFeedIsUntrustedZero() public {
        vm.warp(3 days);
        feed.set(9_000_000, block.timestamp - 2 days);
        (uint256 usd, bool trusted) = oracle.quote(address(wpol), 1 ether);
        assertEq(usd, 0);
        assertFalse(trusted);
    }

    function test_spotIsUntrusted() public {
        MockPair pair = new MockPair(address(bzb), address(wpol));
        // 1 BZB = 0.05 WPOL. 1e18 BZB and 0.05e18 WPOL in the pair reserves scaled up.
        wpol.mint(address(pair), 50_000 ether);
        bzb.mint(address(pair), 1_000_000 ether);
        pair.sync();
        vm.prank(owner);
        oracle.setSpot(address(bzb), address(pair), address(wpol));
        (uint256 usd, bool trusted) = oracle.quote(address(bzb), 1 ether);
        // 0.05 WPOL * $0.09 = $0.0045 = 450_000 in 8 decimals
        assertEq(usd, 450_000);
        assertFalse(trusted);
    }

    function test_spotRejectsWrongPair() public {
        MockERC20 other = new MockERC20("OTHER", "OTH", 18);
        MockPair pair = new MockPair(address(other), address(wpol));
        vm.prank(owner);
        vm.expectRevert(BlazarUsdOracle.BadPair.selector);
        oracle.setSpot(address(bzb), address(pair), address(wpol));
    }
}
