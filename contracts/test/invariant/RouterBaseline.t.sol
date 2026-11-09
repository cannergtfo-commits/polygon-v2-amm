// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarFeeRouter} from "../../src/BlazarFeeRouter.sol";
import {BlazarUsdOracle} from "../../src/BlazarUsdOracle.sol";
import {MockERC20, MockFactory, MockFeed, MockPair, MockWETH} from "../Mocks.sol";

contract RouterHandler is Test {
    BlazarFeeRouter public router;
    MockERC20 public bzb;
    MockERC20 public usdc;
    MockFactory public factory;
    address public feeTo;
    address public actor;
    uint256 public formulaFee;

    constructor(
        BlazarFeeRouter router_,
        MockERC20 bzb_,
        MockERC20 usdc_,
        MockFactory factory_,
        address feeTo_,
        address actor_
    ) {
        router = router_;
        bzb = bzb_;
        usdc = usdc_;
        factory = factory_;
        feeTo = feeTo_;
        actor = actor_;
    }

    function swap(uint256 amount) external {
        amount = bound(amount, 1 ether, 50 ether);
        bzb.mint(actor, amount);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_V2(),
            target: address(factory),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: router.NO_PATCH(),
            minOffset: router.NO_PATCH(),
            data: ""
        });
        vm.startPrank(actor);
        bzb.approve(address(router), amount);
        try router.swap(address(bzb), address(usdc), amount, 1, actor, block.timestamp + 60, false, calls, new address[](0)) {
            formulaFee += amount * 5 / 10_000;
        } catch {}
        vm.stopPrank();
    }
}

contract RouterBaselineInvariant is Test {
    RouterHandler internal handler;
    BlazarFeeRouter internal router;
    MockERC20 internal bzb;
    MockERC20 internal usdc;

    function setUp() public {
        MockWETH wpol = new MockWETH();
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        MockFactory factory = new MockFactory();
        MockPair pair = new MockPair(address(bzb), address(usdc));
        factory.setPair(address(bzb), address(usdc), address(pair));
        bzb.mint(address(pair), 1_000_000 ether);
        usdc.mint(address(pair), 1_000_000e6);
        pair.sync();

        address owner = makeAddr("owner");
        address feeTo = makeAddr("feeTo");
        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        uint8[] memory decimals = new uint8[](1);
        tokens[0] = address(usdc);
        feeds[0] = address(new MockFeed(1e8, 8));
        decimals[0] = 6;
        BlazarUsdOracle oracle = new BlazarUsdOracle(owner, tokens, feeds, decimals);
        router = new BlazarFeeRouter(owner, feeTo, address(wpol), address(0), address(oracle));
        vm.prank(owner);
        router.setV2Factory(address(factory), 30);

        bzb.mint(address(router), 7 ether);
        usdc.mint(address(router), 7e6);

        handler = new RouterHandler(router, bzb, usdc, factory, feeTo, makeAddr("trader"));
        targetContract(address(handler));
    }

    function invariant_donationsStayAndFeeMatchesExternalSpend() public view {
        assertEq(bzb.balanceOf(address(router)), 7 ether);
        assertEq(usdc.balanceOf(address(router)), 7e6);
        assertEq(bzb.balanceOf(handler.feeTo()), handler.formulaFee());
    }
}
