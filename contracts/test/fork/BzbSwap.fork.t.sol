// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BlazarFeeRouter} from "../../src/BlazarFeeRouter.sol";
import {BlazarUsdOracle} from "../../src/BlazarUsdOracle.sol";

/// @notice Fork of Polygon PoS. Nothing here is broadcast. State changes die with the test.
contract BzbSwapForkTest is Test {
    address constant BZB = 0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807;
    address constant WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address constant FEE_TO = 0x6F47aa396215ab22647dDB3E86b4663DFe11dB14;
    address constant QUICK_FACTORY = 0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32;
    address constant BLAZAR_FACTORY = 0x8e9663F4b15F3B291B1354e20d1B019d8864830F;
    address constant UNI_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant QUICK_PAIR = 0x6cCD623a2002F5198F7Acd94011af1Be0a193307;
    address constant FEED_POL = 0xAB594600376Ec9fD91F8e885dADF0CE036862dE0;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.createSelectFork("polygon");
    }

    function _router() internal returns (BlazarFeeRouter router) {
        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        uint8[] memory decimals = new uint8[](1);
        tokens[0] = WPOL;
        feeds[0] = FEED_POL;
        decimals[0] = 18;
        BlazarUsdOracle oracle = new BlazarUsdOracle(owner, tokens, feeds, decimals);
        vm.prank(owner);
        oracle.setSpot(BZB, QUICK_PAIR, WPOL);
        router = new BlazarFeeRouter(owner, FEE_TO, WPOL, BLAZAR_FACTORY, address(oracle));
        vm.startPrank(owner);
        router.setV2Factory(QUICK_FACTORY, 30);
        router.setV2Factory(BLAZAR_FACTORY, 30);
        router.setAllowedTarget(UNI_ROUTER, true);
        vm.stopPrank();
    }

    function testFork_swapBzbToWpolOnQuickSwap() public {
        BlazarFeeRouter router = _router();
        uint256 amount = 1_000 ether;

        // Fork-only impersonation of the dev wallet's BZB. This is not a mainnet transaction.
        vm.prank(FEE_TO);
        IERC20(BZB).transfer(alice, amount);

        vm.startPrank(alice);
        IERC20(BZB).approve(address(router), amount);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_V2(),
            target: QUICK_FACTORY,
            spendToken: BZB,
            v2TokenOut: WPOL,
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: router.NO_PATCH(),
            minOffset: router.NO_PATCH(),
            data: ""
        });

        uint256 feeBefore = IERC20(BZB).balanceOf(FEE_TO);
        uint256 out = router.swap(BZB, WPOL, amount, 1, alice, block.timestamp + 2 minutes, false, calls, new address[](0));
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(IERC20(WPOL).balanceOf(alice), out);
        assertEq(IERC20(BZB).balanceOf(FEE_TO) - feeBefore, amount * 5 / 10_000);
        assertEq(IERC20(BZB).balanceOf(address(router)), 0);
        assertEq(IERC20(WPOL).balanceOf(address(router)), 0);
        // 1000 BZB through the ~0.055 WPOL/BZB pool is well above dust.
        assertGt(out, 40 ether);
    }

    function testFork_blazarPoolChargesNoWrapperFee() public {
        BlazarFeeRouter router = _router();
        uint256 amount = 10 ether;
        vm.prank(FEE_TO);
        IERC20(BZB).transfer(alice, amount);
        vm.startPrank(alice);
        IERC20(BZB).approve(address(router), amount);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_V2(),
            target: BLAZAR_FACTORY,
            spendToken: BZB,
            v2TokenOut: WPOL,
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: router.NO_PATCH(),
            minOffset: router.NO_PATCH(),
            data: ""
        });
        uint256 feeBefore = IERC20(BZB).balanceOf(FEE_TO);
        uint256 out = router.swap(BZB, WPOL, amount, 1, alice, block.timestamp + 2 minutes, false, calls, new address[](0));
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(IERC20(BZB).balanceOf(FEE_TO), feeBefore);
    }

    function testFork_swapWpolToUsdcOnUniswapV3() public {
        BlazarFeeRouter router = _router();
        uint256 amount = 100 ether;
        vm.deal(alice, amount);
        vm.prank(alice);
        (bool deposited,) = WPOL.call{value: amount}(abi.encodeWithSignature("deposit()"));
        assertTrue(deposited);

        bytes memory data = abi.encodeWithSelector(
            bytes4(0x04e45aaf),
            WPOL,
            USDC,
            uint24(500),
            address(router),
            uint256(0),
            uint256(0),
            uint160(0)
        );
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_TARGET(),
            target: UNI_ROUTER,
            spendToken: WPOL,
            v2TokenOut: USDC,
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: 132,
            minOffset: 164,
            data: data
        });

        uint256 feeBefore = IERC20(WPOL).balanceOf(FEE_TO);
        vm.startPrank(alice);
        IERC20(WPOL).approve(address(router), amount);
        uint256 out = router.swap(WPOL, USDC, amount, 1, alice, block.timestamp + 2 minutes, false, calls, new address[](0));
        vm.stopPrank();

        assertGt(out, 1e6); // more than 1 USDC for 100 POL
        assertEq(IERC20(USDC).balanceOf(alice), out);
        assertEq(IERC20(WPOL).balanceOf(FEE_TO) - feeBefore, amount * 5 / 10_000);
        assertEq(IERC20(WPOL).balanceOf(address(router)), 0);
    }
}
