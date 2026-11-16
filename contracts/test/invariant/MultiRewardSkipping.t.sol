// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlazarMultiRewardStaking as M} from "../../src/BlazarMultiRewardStaking.sol";
import {MockERC20} from "../Mocks.sol";
import {FlakyToken} from "../MultiRewardMocks.sol";

/// Hostile reward token (revert / false / gas burn / returnbomb / lying / too hungry) switched at random while
/// users stake, stakeFor, compound, and leave through the skipping exits. Checks that a skipped token's credit
/// is kept exactly, that principal always comes back exactly, and that no value is created or lost.
contract SkipHandler is Test {
    uint256 internal constant MIN = 1e15;
    M public s;
    MockERC20 public bzb;
    FlakyToken public flk;
    address public owner;
    address[] public actors;
    address[] public tokens; // bzb, usdc, flk
    mapping(address => uint256) public principal;
    mapping(address => uint256) public funded;
    mapping(address => uint256) public paid;
    uint256 public calls;
    uint256 public skips;

    constructor(M s_, MockERC20 bzb_, FlakyToken flk_, address owner_, address[] memory tokens_) {
        s = s_;
        bzb = bzb_;
        flk = flk_;
        owner = owner_;
        tokens = tokens_;
        for (uint256 i; i < 3; ++i) {
            actors.push(makeAddr(string(abi.encodePacked("sk", vm.toString(i)))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _earnedAll(address a) internal view returns (uint256[] memory e) {
        e = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            e[i] = s.earned(a, tokens[i]);
        }
    }

    /// true when the current flk mode must make a guarded transfer fail
    function _flkHostile() internal view returns (bool) {
        uint8 m = flk.mode();
        return (m >= 1 && m <= 5) || (m == 6 && flk.hungry() > s.SKIP_PAY_GAS());
    }

    function setMode(uint8 m, bool tooHungry) external {
        calls++;
        m = uint8(bound(m, 0, 6));
        flk.setMode(m);
        flk.setHungry(tooHungry ? 260_000 : 120_000);
    }

    function stake(uint256 seed, uint256 amount) external {
        calls++;
        if (s.paused()) return;
        amount = bound(amount, MIN, 1e27);
        address a = _actor(seed);
        bzb.mint(a, amount);
        vm.startPrank(a);
        bzb.approve(address(s), amount);
        s.stake(amount);
        vm.stopPrank();
        principal[a] += amount;
    }

    function stakeFor(uint256 seed, uint256 amount) external {
        calls++;
        if (s.paused()) return;
        amount = bound(amount, MIN, 1e27);
        address a = _actor(seed);
        address zap = makeAddr("zap");
        bzb.mint(zap, amount);
        vm.startPrank(zap);
        bzb.approve(address(s), amount);
        s.stakeFor(a, amount);
        vm.stopPrank();
        principal[a] += amount;
        assertEq(s.balanceOf(zap), 0);
    }

    function withdraw(uint256 seed, uint256 amount) external {
        calls++;
        address a = _actor(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        if (bal - amount != 0 && bal - amount < MIN) amount = bal;
        uint256 before = bzb.balanceOf(a);
        vm.prank(a);
        s.withdraw(amount);
        assertEq(bzb.balanceOf(a) - before, amount);
        principal[a] -= amount;
    }

    function emergencyWithdraw(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        uint256 bal = s.balanceOf(a);
        if (bal == 0) return;
        uint256[] memory e = _earnedAll(a);
        uint256 before = bzb.balanceOf(a);
        vm.prank(a);
        s.emergencyWithdraw(); // never calls flk, whatever its mode
        assertEq(bzb.balanceOf(a) - before, bal);
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(s.rewards(a, tokens[i]), e[i]);
        }
        principal[a] = 0;
    }

    function compound(uint256 seed) external {
        calls++;
        if (s.paused()) return;
        address a = _actor(seed);
        uint256 e = s.earned(a, address(bzb));
        uint256 bal = s.balanceOf(a);
        if (e == 0 || bal + e < MIN) return;
        uint256 res = s.reserved(address(bzb));
        vm.prank(a);
        s.compound();
        assertEq(s.balanceOf(a), bal + e);
        assertEq(s.reserved(address(bzb)), res, "compound keeps reserved exact");
        principal[a] += e;
        paid[address(bzb)] += e;
    }

    function notify(uint256 tseed, uint256 amount, uint256 duration, uint256 wS, uint256 wE) external {
        calls++;
        address t = tokens[tseed % tokens.length];
        amount = bound(amount, 1e6, 1e28);
        duration = bound(duration, 1 days, 60 days);
        wS = bound(wS, 0, 10_000);
        wE = bound(wE, 0, 10_000);
        if (wS + wE == 0) wE = 1;
        if (s.paused() || s.activeRunCount(t) == s.MAX_RUNS_PER_TOKEN()) return;
        MockERC20(t).mint(owner, amount);
        uint256 before = MockERC20(t).balanceOf(address(s));
        vm.startPrank(owner);
        MockERC20(t).approve(address(s), amount);
        s.notifyRewardAmount(
            M.RunConfig({
                token: t,
                amount: amount,
                duration: uint64(duration),
                startTime: 0,
                startWeight: uint16(wS),
                endWeight: uint16(wE)
            })
        );
        vm.stopPrank();
        funded[t] += MockERC20(t).balanceOf(address(s)) - before;
    }

    function warp(uint256 dt) external {
        calls++;
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 10 days));
    }

    function togglePause() external {
        calls++;
        vm.startPrank(owner);
        if (s.paused()) s.unpause();
        else s.pause();
        vm.stopPrank();
    }

    function _checkSkipping(address a, uint256[] memory e, uint256[] memory userBefore, address[] memory sk) internal {
        bool hostile = _flkHostile();
        bool flkSkipped;
        for (uint256 j; j < sk.length; ++j) {
            assertEq(sk[j], address(flk), "only flk may be skipped");
            flkSkipped = true;
        }
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            if (t == address(flk) && flkSkipped) {
                assertTrue(hostile, "flk skipped only when hostile");
                assertEq(s.rewards(a, t), e[i], "skipped credit kept exactly");
                assertEq(flk.balanceOf(a), userBefore[i], "skipped: nothing moved (lying rolled back)");
                skips++;
            } else {
                if (t == address(flk) && e[i] > 0) assertFalse(hostile, "hostile flk must be skipped");
                assertEq(s.rewards(a, t), 0, "paid");
                paid[t] += e[i];
                if (t != address(bzb)) assertEq(MockERC20(t).balanceOf(a) - userBefore[i], e[i], "paid exact");
            }
        }
    }

    function _userBalances(address a) internal view returns (uint256[] memory b) {
        b = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            b[i] = MockERC20(tokens[i]).balanceOf(a);
        }
    }

    function claimAllSkipping(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        uint256[] memory e = _earnedAll(a);
        uint256[] memory ub = _userBalances(a);
        vm.prank(a);
        address[] memory sk = s.claimAllSkipping{gas: 4_000_000}();
        _checkSkipping(a, e, ub, sk);
    }

    function exitSkipping(uint256 seed) external {
        calls++;
        address a = _actor(seed);
        uint256 bal = s.balanceOf(a);
        uint256[] memory e = _earnedAll(a);
        uint256[] memory ub = _userBalances(a);
        vm.prank(a);
        address[] memory sk = s.exitSkipping{gas: 4_000_000}();
        // bzb is index 0: principal + its reward
        assertEq(bzb.balanceOf(a) - ub[0], bal + e[0], "exitSkipping principal exact");
        assertEq(s.balanceOf(a), 0);
        principal[a] = 0;
        _checkSkipping(a, e, ub, sk);
    }

    function sumEarned(address t) public view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += s.earned(actors[i], t);
        }
    }

    function sumPrincipal() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += principal[actors[i]];
        }
    }

    function drainAll() external {
        flk.setMode(0);
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            uint256 bal = s.balanceOf(a);
            uint256[] memory e = _earnedAll(a);
            uint256 before = bzb.balanceOf(a);
            vm.prank(a);
            address[] memory sk = s.exitSkipping();
            assertEq(sk.length, 0);
            assertEq(bzb.balanceOf(a) - before, bal + e[0]);
            for (uint256 j; j < tokens.length; ++j) {
                paid[tokens[j]] += e[j];
                assertEq(s.earned(a, tokens[j]), 0);
            }
            principal[a] = 0;
        }
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 128
/// forge-config: default.invariant.fail_on_revert = true
contract MultiRewardSkippingInvariant is Test {
    SkipHandler internal h;
    M internal s;
    MockERC20 internal bzb;
    FlakyToken internal flk;
    address[] internal tokens;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        bzb = new MockERC20("BlazarBits", "BZB", 18);
        flk = new FlakyToken();
        s = new M(owner, address(bzb), 1e15);
        tokens.push(address(bzb));
        tokens.push(address(new MockERC20("USD Coin", "USDC", 6)));
        tokens.push(address(flk));
        vm.prank(owner);
        s.addRewardTokens(tokens);
        h = new SkipHandler(s, bzb, flk, owner, tokens);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = h.setMode.selector;
        sel[1] = h.stake.selector;
        sel[2] = h.stakeFor.selector;
        sel[3] = h.withdraw.selector;
        sel[4] = h.emergencyWithdraw.selector;
        sel[5] = h.compound.selector;
        sel[6] = h.notify.selector;
        sel[7] = h.warp.selector;
        sel[8] = h.togglePause.selector;
        sel[9] = h.claimAllSkipping.selector;
        sel[10] = h.exitSkipping.selector;
        sel[11] = h.claimAllSkipping.selector;
        sel[12] = h.setMode.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_principal() public view {
        assertEq(h.sumPrincipal(), s.totalStaked());
        assertGe(bzb.balanceOf(address(s)), s.totalStaked() + h.sumEarned(address(bzb)));
    }

    function invariant_solvencyAndConservation() public view {
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            assertGe(MockERC20(t).balanceOf(address(s)), s.reserved(t), "balance >= reserved");
            assertLe(h.paid(t) + h.sumEarned(t) + s.unemitted(t), h.funded(t), "no value created");
            uint256 principalPart = t == address(bzb) ? s.totalStaked() : 0;
            uint256 owedNow = s.reserved(t) - s.unemitted(t) - principalPart;
            assertLe(h.sumEarned(t), owedNow, "earned <= owed");
            assertLe(owedNow - h.sumEarned(t), 8 * h.calls() + 8, "skips lose nothing beyond dust");
        }
    }

    function afterInvariant() public {
        h.drainAll();
        assertEq(s.totalStaked(), 0);
        for (uint256 i; i < tokens.length; ++i) {
            assertGe(MockERC20(tokens[i]).balanceOf(address(s)), s.reserved(tokens[i]));
        }
    }
}
