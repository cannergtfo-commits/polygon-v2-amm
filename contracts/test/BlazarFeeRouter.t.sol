// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {BlazarFeeRouter} from "../src/BlazarFeeRouter.sol";
import {BlazarUsdOracle} from "../src/BlazarUsdOracle.sol";
import {EchoVenue, MockERC20, MockFactory, MockFeed, MockPair, MockWETH, RecipientTax, ReenterVenue, TaxToken} from "./Mocks.sol";

contract BlazarFeeRouterTest is Test {
    uint256 internal constant FEE_TO_START = 1_000 ether;

    address internal owner = makeAddr("owner");
    address internal feeTo = makeAddr("feeTo");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockWETH internal wpol;
    MockERC20 internal bzb;
    MockERC20 internal usdc;
    MockFactory internal factory;
    MockPair internal pair;
    BlazarUsdOracle internal oracle;
    BlazarFeeRouter internal router;

    function setUp() public {
        wpol = new MockWETH();
        vm.deal(address(wpol), 100 ether);
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        factory = new MockFactory();
        pair = new MockPair(address(bzb), address(usdc));
        factory.setPair(address(bzb), address(usdc), address(pair));

        bzb.mint(address(pair), 1_000_000 ether);
        usdc.mint(address(pair), 1_000_000e6);
        pair.sync();

        address[] memory tokens = new address[](1);
        address[] memory feeds = new address[](1);
        uint8[] memory decimals = new uint8[](1);
        tokens[0] = address(usdc);
        feeds[0] = address(new MockFeed(1e8, 8));
        decimals[0] = 6;
        oracle = new BlazarUsdOracle(owner, tokens, feeds, decimals);

        router = new BlazarFeeRouter(owner, feeTo, address(wpol), address(0), address(oracle));
        vm.startPrank(owner);
        router.setV2Factory(address(factory), 30);
        vm.stopPrank();

        bzb.mint(alice, FEE_TO_START);
        vm.prank(alice);
        bzb.approve(address(router), type(uint256).max);
    }

    function _v2(address tokenIn, address tokenOut, uint16 bps, bool useBalance)
        internal
        view
        returns (BlazarFeeRouter.Call memory c)
    {
        c.kind = router.KIND_V2();
        c.target = address(factory);
        c.spendToken = tokenIn;
        c.v2TokenOut = tokenOut;
        c.bps = bps;
        c.useBalance = useBalance;
        c.minBuy = 1;
        c.amountOffset = router.NO_PATCH();
        c.minOffset = router.NO_PATCH();
    }

    function test_feeIsFiveBpsAndOutputArrives() public {
        uint256 amount = 1_000 ether;
        uint256 feeBefore = bzb.balanceOf(feeTo);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(usdc), 10_000, false);

        uint256 quoted = router.quoteV2(amount - (amount * 5 / 10_000), 1_000_000 ether, 1_000_000e6, 30);
        vm.prank(alice);
        uint256 out = router.swap(
            address(bzb), address(usdc), amount, quoted, alice, block.timestamp + 60, false, calls, new address[](0)
        );

        assertEq(out, quoted);
        assertEq(usdc.balanceOf(alice), quoted);
        assertEq(bzb.balanceOf(feeTo) - feeBefore, amount * 5 / 10_000);
        assertEq(bzb.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_feeCapAndOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        router.setFeeBps(1);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BlazarFeeRouter.FeeTooHigh.selector, uint16(26), uint16(25)));
        router.setFeeBps(26);

        vm.prank(owner);
        router.setFeeBps(0);
        assertEq(router.feeBps(), 0);

        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(usdc), 10_000, false);
        uint256 before = bzb.balanceOf(feeTo);
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), 100 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), before);
    }

    function test_feeOnTransferInputUsesAmountReceived() public {
        TaxToken tax = new TaxToken(100, makeAddr("sink")); // 1%
        MockPair taxPair = new MockPair(address(tax), address(usdc));
        factory.setPair(address(tax), address(usdc), address(taxPair));
        tax.mint(address(taxPair), 1_000_000 ether);
        usdc.mint(address(taxPair), 1_000_000e6);
        taxPair.sync();
        tax.mint(alice, 10_000 ether);
        vm.prank(alice);
        tax.approve(address(router), type(uint256).max);

        uint256 amount = 10_000 ether;
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(tax), address(usdc), 10_000, false);

        uint256 feeBefore = tax.balanceOf(feeTo);
        vm.prank(alice);
        uint256 out = router.swap(
            address(tax), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0)
        );
        uint256 received = amount - (amount * 100 / 10_000);
        uint256 fee = received * 5 / 10_000;
        // The fee transfer itself is taxed, so the wallet receives slightly less than `fee`.
        uint256 feeAfterTax = fee - (fee * 100 / 10_000);
        assertEq(tax.balanceOf(feeTo) - feeBefore, feeAfterTax);
        assertGt(out, 0);
        assertEq(tax.balanceOf(address(router)), 0);
    }

    function test_targetCallPatchesAmountAndResetsApproval() public {
        EchoVenue venue = new EchoVenue();
        vm.prank(owner);
        router.setAllowedTarget(address(venue), true);
        usdc.mint(address(venue), 1_000_000 ether);

        bytes memory data =
            abi.encodeWithSelector(EchoVenue.take.selector, uint256(0), address(bzb), address(usdc));
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_TARGET(),
            target: address(venue),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: 4,
            minOffset: router.NO_PATCH(),
            data: data
        });

        uint256 amount = 100 ether;
        uint256 expectedSpend = amount - (amount * 5 / 10_000);
        vm.prank(alice);
        uint256 out = router.swap(
            address(bzb), address(usdc), amount, expectedSpend, bob, block.timestamp + 60, false, calls, new address[](0)
        );
        assertEq(out, expectedSpend);
        assertEq(usdc.balanceOf(bob), expectedSpend);
        assertEq(venue.seen(), expectedSpend);
        assertEq(bzb.allowance(address(router), address(venue)), 0);
    }

    function test_splitAcrossTwoPairs() public {
        MockPair pair2 = new MockPair(address(bzb), address(usdc));
        MockFactory factory2 = new MockFactory();
        factory2.setPair(address(bzb), address(usdc), address(pair2));
        bzb.mint(address(pair2), 1_000_000 ether);
        usdc.mint(address(pair2), 2_000_000e6); // better price
        pair2.sync();
        vm.prank(owner);
        router.setV2Factory(address(factory2), 30);

        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = _v2(address(bzb), address(usdc), 4_000, false);
        calls[1] = BlazarFeeRouter.Call({
            kind: router.KIND_V2(),
            target: address(factory2),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: router.NO_PATCH(),
            minOffset: router.NO_PATCH(),
            data: ""
        });

        vm.prank(alice);
        uint256 out = router.swap(
            address(bzb), address(usdc), 1_000 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0)
        );
        assertGt(out, 0);
        assertEq(bzb.balanceOf(address(router)), 0);
        // Parallel slices are different principal. Together they are one 0.05% of the input, not two.
        assertEq(bzb.balanceOf(feeTo), 1_000 ether * 5 / 10_000);
    }

    function test_nativeInAndRefund() public {
        MockPair polPair = new MockPair(address(wpol), address(usdc));
        factory.setPair(address(wpol), address(usdc), address(polPair));
        // Seed WPOL liquidity by depositing.
        vm.deal(address(this), 50 ether);
        wpol.deposit{value: 50 ether}();
        wpol.transfer(address(polPair), 50 ether);
        usdc.mint(address(polPair), 50e6);
        polPair.sync();

        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(wpol), address(usdc), 5_000, false); // use half, refund the rest

        vm.deal(alice, 10 ether);
        vm.prank(alice);
        uint256 out = router.swap{value: 10 ether}(
            address(0),
            address(usdc),
            10 ether,
            1,
            alice,
            block.timestamp + 60,
            false,
            calls,
            new address[](0)
        );
        assertGt(out, 0);
        // Only the half that actually fills a third-party leg is charged, and the fee is WPOL.
        uint256 spent = 5 ether;
        assertEq(wpol.balanceOf(feeTo), spent * 5 / 10_000);
        assertEq(alice.balance, 5 ether);
        assertEq(wpol.balanceOf(address(router)), 0);
    }

    function test_blazarLegChargesNoWrapperFeeAndMixedSplitFeesTheOtherSide() public {
        MockFactory blazar = new MockFactory();
        MockPair own = new MockPair(address(bzb), address(usdc));
        blazar.setPair(address(bzb), address(usdc), address(own));
        bzb.mint(address(own), 1_000_000 ether);
        usdc.mint(address(own), 1_000_000e6);
        own.sync();

        BlazarFeeRouter ownRouter = new BlazarFeeRouter(owner, feeTo, address(wpol), address(blazar), address(oracle));
        vm.startPrank(owner);
        ownRouter.setV2Factory(address(blazar), 30);
        ownRouter.setV2Factory(address(factory), 30);
        vm.stopPrank();
        vm.prank(alice);
        bzb.approve(address(ownRouter), type(uint256).max);

        BlazarFeeRouter.Call[] memory onlyOwn = new BlazarFeeRouter.Call[](1);
        onlyOwn[0] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(blazar),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        uint256 before = bzb.balanceOf(feeTo);
        vm.prank(alice);
        ownRouter.swap(address(bzb), address(usdc), 100 ether, 1, alice, block.timestamp + 60, false, onlyOwn, new address[](0));
        assertEq(bzb.balanceOf(feeTo), before);

        BlazarFeeRouter.Call[] memory mixed = new BlazarFeeRouter.Call[](2);
        mixed[0] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(factory),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 4_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        mixed[1] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(blazar),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        before = bzb.balanceOf(feeTo);
        vm.prank(alice);
        ownRouter.swap(address(bzb), address(usdc), 100 ether, 1, alice, block.timestamp + 60, false, mixed, new address[](0));
        assertEq(bzb.balanceOf(feeTo) - before, 40 ether * 5 / 10_000);
    }

    function test_rejectsUnknownTargetAndSlippageAndPause() public {
        EchoVenue venue = new EchoVenue();
        bytes memory data = abi.encodeWithSelector(EchoVenue.take.selector, uint256(0), address(bzb), address(usdc));
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_TARGET(),
            target: address(venue),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: 4,
            minOffset: router.NO_PATCH(),
            data: data
        });
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BlazarFeeRouter.TargetNotAllowed.selector, address(venue)));
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));

        calls[0] = _v2(address(bzb), address(usdc), 10_000, false);
        vm.prank(alice);
        vm.expectRevert();
        router.swap(address(bzb), address(usdc), 10 ether, type(uint256).max, alice, block.timestamp + 60, false, calls, new address[](0));

        vm.prank(owner);
        router.pause();
        vm.prank(alice);
        vm.expectRevert();
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
    }

    function test_reentrancyBlocked() public {
        ReenterVenue venue = new ReenterVenue();
        venue.setRouter(address(router));
        vm.prank(owner);
        router.setAllowedTarget(address(venue), true);
        bytes memory data = abi.encodeWithSelector(ReenterVenue.poke.selector, uint256(0));
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_TARGET(),
            target: address(venue),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: 4,
            minOffset: router.NO_PATCH(),
            data: data
        });
        vm.prank(alice);
        vm.expectRevert();
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
    }

    function test_rescueOnlyWhenPaused() public {
        bzb.mint(address(router), 5 ether);
        vm.prank(owner);
        vm.expectRevert();
        router.rescueToken(address(bzb), 5 ether, owner);
        vm.prank(owner);
        router.pause();
        vm.prank(owner);
        router.rescueToken(address(bzb), 5 ether, owner);
        assertEq(bzb.balanceOf(owner), 5 ether);
    }

    function test_twoExternalHopsChargeTheInputOnceAndMatchTheQuote() public {
        (MockERC20 mid, MockPair first, MockPair second) = _twoHop(address(factory));
        uint256 amount = 1_000 ether;
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = _v2(address(bzb), address(mid), 10_000, false);
        calls[1] = _v2(address(mid), address(usdc), 10_000, true);

        uint256 fee = amount * 5 / 10_000;
        uint256 midOut = router.quoteV2(amount - fee, 1_000_000 ether, 1_000_000 ether, 30);
        uint256 expected = router.quoteV2(midOut, 1_000_000 ether, 1_000_000e6, 30);
        vm.prank(alice);
        uint256 out = router.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(out, expected);
        assertEq(bzb.balanceOf(feeTo), fee);
        assertEq(mid.balanceOf(feeTo), 0);
        first;
        second;
    }

    function test_thirdExternalHopDoesNotChargeAgain() public {
        MockERC20 mid = new MockERC20("Mid", "MID", 18);
        MockERC20 alt = new MockERC20("Alt", "ALT", 18);
        MockPair p1 = new MockPair(address(bzb), address(mid));
        MockPair p2 = new MockPair(address(mid), address(alt));
        MockPair p3 = new MockPair(address(alt), address(usdc));
        factory.setPair(address(bzb), address(mid), address(p1));
        factory.setPair(address(mid), address(alt), address(p2));
        factory.setPair(address(alt), address(usdc), address(p3));
        bzb.mint(address(p1), 1_000_000 ether);
        mid.mint(address(p1), 1_000_000 ether);
        p1.sync();
        mid.mint(address(p2), 1_000_000 ether);
        alt.mint(address(p2), 1_000_000 ether);
        p2.sync();
        alt.mint(address(p3), 1_000_000 ether);
        usdc.mint(address(p3), 1_000_000e6);
        p3.sync();

        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](3);
        calls[0] = _v2(address(bzb), address(mid), 10_000, false);
        calls[1] = _v2(address(mid), address(alt), 10_000, true);
        calls[2] = _v2(address(alt), address(usdc), 10_000, true);
        uint256 amount = 100 ether;
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), amount * 5 / 10_000);
        assertEq(mid.balanceOf(feeTo), 0);
        assertEq(alt.balanceOf(feeTo), 0);
    }

    function test_blazarThenExternalChargesOnceOnTheLaterToken() public {
        MockFactory blazar = new MockFactory();
        MockERC20 mid = new MockERC20("Mid", "MID", 18);
        MockPair own = new MockPair(address(bzb), address(mid));
        MockPair ext = new MockPair(address(mid), address(usdc));
        blazar.setPair(address(bzb), address(mid), address(own));
        factory.setPair(address(mid), address(usdc), address(ext));
        bzb.mint(address(own), 1_000_000 ether);
        mid.mint(address(own), 1_000_000 ether);
        own.sync();
        mid.mint(address(ext), 1_000_000 ether);
        usdc.mint(address(ext), 1_000_000e6);
        ext.sync();

        BlazarFeeRouter ownRouter = new BlazarFeeRouter(owner, feeTo, address(wpol), address(blazar), address(oracle));
        vm.startPrank(owner);
        ownRouter.setV2Factory(address(blazar), 30);
        ownRouter.setV2Factory(address(factory), 30);
        vm.stopPrank();
        vm.prank(alice);
        bzb.approve(address(ownRouter), type(uint256).max);

        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](3);
        calls[0] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(blazar),
            spendToken: address(bzb),
            v2TokenOut: address(mid),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        calls[1] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(factory),
            spendToken: address(mid),
            v2TokenOut: address(usdc),
            bps: 5_000,
            useBalance: true,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        // A second external hop of the same USDC would be the final token, so use a fresh alt hop
        // by swapping only half the mid on the first external and the rest on another external pair.
        MockERC20 alt = new MockERC20("Alt", "ALT", 18);
        MockPair ext2 = new MockPair(address(mid), address(alt));
        factory.setPair(address(mid), address(alt), address(ext2));
        mid.mint(address(ext2), 1_000_000 ether);
        alt.mint(address(ext2), 1_000_000 ether);
        ext2.sync();
        calls[2] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(factory),
            spendToken: address(mid),
            v2TokenOut: address(alt),
            bps: 10_000,
            useBalance: true,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });

        uint256 amount = 100 ether;
        uint256 midOut = ownRouter.quoteV2(amount, 1_000_000 ether, 1_000_000 ether, 30);
        vm.prank(alice);
        ownRouter.swap(address(bzb), address(alt), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        // No wrapper fee on the Blazar input. The whole mid output is unpaid, then both external
        // slices charge it once. Nothing is charged a second time because alt/usdc are terminal.
        assertEq(bzb.balanceOf(feeTo), 0);
        assertEq(mid.balanceOf(feeTo), midOut * 5 / 10_000);
    }

    function test_pureBlazarMultihopPaysNoWrapperFee() public {
        MockFactory blazar = new MockFactory();
        MockERC20 mid = new MockERC20("Mid", "MID", 18);
        MockPair a = new MockPair(address(bzb), address(mid));
        MockPair b = new MockPair(address(mid), address(usdc));
        blazar.setPair(address(bzb), address(mid), address(a));
        blazar.setPair(address(mid), address(usdc), address(b));
        bzb.mint(address(a), 1_000_000 ether);
        mid.mint(address(a), 1_000_000 ether);
        a.sync();
        mid.mint(address(b), 1_000_000 ether);
        usdc.mint(address(b), 1_000_000e6);
        b.sync();
        BlazarFeeRouter ownRouter = new BlazarFeeRouter(owner, feeTo, address(wpol), address(blazar), address(oracle));
        vm.prank(owner);
        ownRouter.setV2Factory(address(blazar), 30);
        vm.prank(alice);
        bzb.approve(address(ownRouter), type(uint256).max);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(blazar),
            spendToken: address(bzb),
            v2TokenOut: address(mid),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        calls[1] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(blazar),
            spendToken: address(mid),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: true,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        vm.prank(alice);
        ownRouter.swap(address(bzb), address(usdc), 50 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), 0);
        assertEq(mid.balanceOf(feeTo), 0);
    }

    function test_useBalanceCannotSpendReservedInputWithoutAFee() public {
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(usdc), 10_000, true);
        vm.prank(alice);
        vm.expectRevert(BlazarFeeRouter.BadRoute.selector);
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
    }

    function test_splittingInputAcrossCallsStillChargesEveryUnpaidSlice() public {
        uint256 amount = 10 ether;
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = _v2(address(bzb), address(usdc), 100, false);
        calls[1] = _v2(address(bzb), address(usdc), 10_000, false);
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), amount * 5 / 10_000);
    }

    function test_targetCallIsNotBlazarAndALaterHopIsNotChargedAgain() public {
        EchoVenue venue = new EchoVenue();
        MockERC20 mid = new MockERC20("Mid", "MID", 18);
        mid.mint(address(venue), 1_000 ether);
        vm.prank(owner);
        router.setAllowedTarget(address(venue), true);
        MockPair p2 = new MockPair(address(mid), address(usdc));
        factory.setPair(address(mid), address(usdc), address(p2));
        mid.mint(address(p2), 1_000_000 ether);
        usdc.mint(address(p2), 1_000_000e6);
        p2.sync();

        bytes memory data = abi.encodeWithSelector(EchoVenue.take.selector, uint256(0), address(bzb), address(mid));
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = BlazarFeeRouter.Call({
            kind: router.KIND_TARGET(),
            target: address(venue),
            spendToken: address(bzb),
            v2TokenOut: address(mid),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: 4,
            minOffset: router.NO_PATCH(),
            data: data
        });
        calls[1] = _v2(address(mid), address(usdc), 10_000, true);
        uint256 amount = 100 ether;
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), amount * 5 / 10_000);
        assertEq(mid.balanceOf(feeTo), 0);
        assertEq(bzb.allowance(address(router), address(venue)), 0);
    }

    function test_partialSpendEventRecordsConsumedInput() public {
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(usdc), 5_000, false);
        vm.recordLogs();
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        bytes32 topic = keccak256("AggregatedSwap(address,address,address,address,uint256,uint256,uint256,uint256,bool,uint16,bytes32)");
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != topic) continue;
            (, uint256 amountIn,,) = abi.decode(logs[i].data, (address, uint256, uint256, uint256));
            assertEq(amountIn, 5 ether);
            found = true;
        }
        assertTrue(found);
        assertEq(bzb.balanceOf(alice), FEE_TO_START - 5 ether);
    }

    function test_taxedRecipientReceivesAtLeastTheMinimumOrTheSwapReverts() public {
        RecipientTax tax = new RecipientTax();
        tax.setRouter(address(router));
        MockPair taxPair = new MockPair(address(bzb), address(tax));
        factory.setPair(address(bzb), address(tax), address(taxPair));
        bzb.mint(address(taxPair), 1_000_000 ether);
        tax.mint(address(taxPair), 1_000_000 ether);
        taxPair.sync();
        uint256 amount = 100 ether;
        uint256 quoted = router.quoteV2(amount - (amount * 5 / 10_000), 1_000_000 ether, 1_000_000 ether, 30);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(tax), 10_000, false);
        vm.prank(alice);
        vm.expectRevert();
        router.swap(address(bzb), address(tax), amount, quoted, alice, block.timestamp + 60, false, calls, new address[](0));
    }

    function test_preexistingDonationIsNotSpentOrRefunded() public {
        bzb.mint(address(router), 7 ether);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(usdc), 10_000, false);
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(address(router)), 7 ether);
        assertEq(bzb.balanceOf(alice), FEE_TO_START - 10 ether);
    }

    function test_staleDeadlineAndZeroMinimumsRevert() public {
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        calls[0] = _v2(address(bzb), address(usdc), 10_000, false);
        vm.prank(alice);
        vm.expectRevert(BlazarFeeRouter.StaleQuote.selector);
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 3 minutes + 1, false, calls, new address[](0));
        vm.prank(alice);
        vm.expectRevert(BlazarFeeRouter.BadRoute.selector);
        router.swap(address(bzb), address(usdc), 10 ether, 0, alice, block.timestamp + 60, false, calls, new address[](0));
        calls[0].minBuy = 0;
        vm.prank(alice);
        vm.expectRevert(BlazarFeeRouter.BadRoute.selector);
        router.swap(address(bzb), address(usdc), 10 ether, 1, alice, block.timestamp + 60, false, calls, new address[](0));
    }

    function test_returnedInputIsNotChargedAgain() public {
        MockFactory other = new MockFactory();
        vm.prank(owner);
        router.setV2Factory(address(other), 30);
        MockERC20 mid = new MockERC20("Mid", "MID", 18);
        MockPair go = new MockPair(address(bzb), address(mid));
        MockPair back = new MockPair(address(mid), address(bzb));
        factory.setPair(address(bzb), address(mid), address(go));
        other.setPair(address(mid), address(bzb), address(back));
        bzb.mint(address(go), 1_000_000 ether);
        mid.mint(address(go), 1_000_000 ether);
        go.sync();
        mid.mint(address(back), 1_000_000 ether);
        bzb.mint(address(back), 1_000_000 ether);
        back.sync();
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](3);
        calls[0] = _v2(address(bzb), address(mid), 10_000, false);
        calls[1] = BlazarFeeRouter.Call({
            kind: router.KIND_V2(),
            target: address(other),
            spendToken: address(mid),
            v2TokenOut: address(bzb),
            bps: 10_000,
            useBalance: true,
            minBuy: 1,
            amountOffset: router.NO_PATCH(),
            minOffset: router.NO_PATCH(),
            data: ""
        });
        calls[2] = _v2(address(bzb), address(usdc), 10_000, true);
        uint256 amount = 20 ether;
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), amount * 5 / 10_000);
        assertEq(mid.balanceOf(feeTo), 0);
    }

    function testFuzz_splitChargesOnlyTheExternalSlice(uint16 rawBps) public {
        uint16 extBps = uint16(bound(rawBps, 1, 9_999));
        MockFactory blazar = new MockFactory();
        MockPair own = new MockPair(address(bzb), address(usdc));
        blazar.setPair(address(bzb), address(usdc), address(own));
        bzb.mint(address(own), 1_000_000 ether);
        usdc.mint(address(own), 1_000_000e6);
        own.sync();
        BlazarFeeRouter ownRouter = new BlazarFeeRouter(owner, feeTo, address(wpol), address(blazar), address(oracle));
        vm.startPrank(owner);
        ownRouter.setV2Factory(address(blazar), 30);
        ownRouter.setV2Factory(address(factory), 30);
        vm.stopPrank();
        vm.prank(alice);
        bzb.approve(address(ownRouter), type(uint256).max);
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(factory),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: extBps,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        calls[1] = BlazarFeeRouter.Call({
            kind: ownRouter.KIND_V2(),
            target: address(blazar),
            spendToken: address(bzb),
            v2TokenOut: address(usdc),
            bps: 10_000,
            useBalance: false,
            minBuy: 1,
            amountOffset: ownRouter.NO_PATCH(),
            minOffset: ownRouter.NO_PATCH(),
            data: ""
        });
        uint256 amount = 100 ether;
        vm.prank(alice);
        ownRouter.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), (amount * extBps / 10_000) * 5 / 10_000);
    }

    function testFuzz_sequentialExternalFeeIsOnce(uint96 raw) public {
        uint256 amount = bound(raw, 1 ether, 500 ether);
        (MockERC20 mid,,) = _twoHop(address(factory));
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](2);
        calls[0] = _v2(address(bzb), address(mid), 10_000, false);
        calls[1] = _v2(address(mid), address(usdc), 10_000, true);
        vm.prank(alice);
        router.swap(address(bzb), address(usdc), amount, 1, alice, block.timestamp + 60, false, calls, new address[](0));
        assertEq(bzb.balanceOf(feeTo), amount * 5 / 10_000);
        assertEq(mid.balanceOf(feeTo), 0);
    }

    function _twoHop(address hopFactory)
        internal
        returns (MockERC20 mid, MockPair first, MockPair second)
    {
        mid = new MockERC20("Mid", "MID", 18);
        first = new MockPair(address(bzb), address(mid));
        second = new MockPair(address(mid), address(usdc));
        MockFactory(hopFactory).setPair(address(bzb), address(mid), address(first));
        MockFactory(hopFactory).setPair(address(mid), address(usdc), address(second));
        bzb.mint(address(first), 1_000_000 ether);
        mid.mint(address(first), 1_000_000 ether);
        first.sync();
        mid.mint(address(second), 1_000_000 ether);
        usdc.mint(address(second), 1_000_000e6);
        second.sync();
    }

    function testFuzz_quoteV2Matches997(uint96 amountIn, uint96 reserveIn, uint96 reserveOut) public view {
        vm.assume(amountIn > 0 && reserveIn > 0 && reserveOut > 0);
        uint256 a = router.quoteV2(amountIn, reserveIn, reserveOut, 30);
        uint256 withFee = uint256(amountIn) * 997;
        uint256 b = withFee * reserveOut / (uint256(reserveIn) * 1000 + withFee);
        assertEq(a, b);
    }
}
