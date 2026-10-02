// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Markarian421} from "./Markarian421.sol";

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

interface ISwapRouter {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

/// @title MarkarianVault
/// @notice Holds BzB, WBTC, and WETH. The first deposit must be equal dollar value.
///         Later deposits match that basket. M421 is a pro-rata claim. Anyone can
///         withdraw their share of all three, or zap in and out through QuickSwap.
contract MarkarianVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable bzb;
    IERC20 public immutable wbtc;
    IERC20 public immutable weth;
    Markarian421 public immutable share;
    ISwapRouter public immutable router;
    address public immutable wmatic;
    address public immutable usdc;
    IAggregatorV3 public immutable btcUsd;
    IAggregatorV3 public immutable ethUsd;
    uint8 public immutable btcDecimals;
    uint8 public immutable ethDecimals;

    uint256 public reserveBzb;
    uint256 public reserveWbtc;
    uint256 public reserveWeth;

    uint256 public constant MIN_SEED_USD = 10e8;
    uint256 public constant MAX_DEVIATION_BPS = 2_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;

    event Deposit(address indexed user, uint256 bzbAmount, uint256 wbtcAmount, uint256 wethAmount, uint256 shares);
    event Withdraw(address indexed user, uint256 shares, uint256 bzbAmount, uint256 wbtcAmount, uint256 wethAmount);
    event Skim(address indexed to, uint256 bzbAmount, uint256 wbtcAmount, uint256 wethAmount);

    constructor(
        address bzb_,
        address wbtc_,
        address weth_,
        address router_,
        address wmatic_,
        address usdc_,
        address btcUsd_,
        address ethUsd_,
        string memory description_
    ) {
        bzb = IERC20(bzb_);
        wbtc = IERC20(wbtc_);
        weth = IERC20(weth_);
        router = ISwapRouter(router_);
        wmatic = wmatic_;
        usdc = usdc_;
        btcUsd = IAggregatorV3(btcUsd_);
        ethUsd = IAggregatorV3(ethUsd_);
        btcDecimals = btcUsd.decimals();
        ethDecimals = ethUsd.decimals();
        share = new Markarian421(description_);
        bzb.forceApprove(router_, type(uint256).max);
        wbtc.forceApprove(router_, type(uint256).max);
        weth.forceApprove(router_, type(uint256).max);
    }

    function values(uint256 bzbAmount, uint256 wbtcAmount, uint256 wethAmount)
        public
        view
        returns (uint256 bzbUsd, uint256 wbtcUsd, uint256 wethUsd)
    {
        bzbUsd = _bzbUsd(bzbAmount);
        wbtcUsd = _wbtcUsd(wbtcAmount);
        wethUsd = _wethUsd(wethAmount);
    }

    function route(address tokenIn, address tokenOut) public view returns (address[] memory path) {
        bool throughMatic = (tokenIn == address(wbtc) && tokenOut == address(bzb))
            || (tokenIn == address(bzb) && tokenOut == address(wbtc));
        if (throughMatic) {
            path = new address[](3);
            path[0] = tokenIn;
            path[1] = wmatic;
            path[2] = tokenOut;
        } else {
            path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
        }
    }

    function deposit(uint256 bzbAmount, uint256 wbtcAmount, uint256 wethAmount, uint256 minShares, uint256 deviationBps)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(deviationBps <= MAX_DEVIATION_BPS, "deviation");
        if (bzbAmount > 0) bzb.safeTransferFrom(msg.sender, address(this), bzbAmount);
        if (wbtcAmount > 0) wbtc.safeTransferFrom(msg.sender, address(this), wbtcAmount);
        if (wethAmount > 0) weth.safeTransferFrom(msg.sender, address(this), wethAmount);
        shares = _mintShares(msg.sender, bzbAmount, wbtcAmount, wethAmount, minShares, deviationBps);
    }

    function withdraw(uint256 shares, uint256 minBzb, uint256 minWbtc, uint256 minWeth)
        external
        nonReentrant
        returns (uint256 bzbOut, uint256 wbtcOut, uint256 wethOut)
    {
        (bzbOut, wbtcOut, wethOut) = _burnShares(msg.sender, shares);
        require(bzbOut >= minBzb && wbtcOut >= minWbtc && wethOut >= minWeth, "slippage");
        if (bzbOut > 0) bzb.safeTransfer(msg.sender, bzbOut);
        if (wbtcOut > 0) wbtc.safeTransfer(msg.sender, wbtcOut);
        if (wethOut > 0) weth.safeTransfer(msg.sender, wethOut);
    }

    /// @notice Split one basket token into the other two, then deposit.
    ///         An empty basket sells equal thirds. A live basket swaps toward its current mix.
    function zapIn(address tokenIn, uint256 amountIn, uint256 minShares, uint256 slippageBps, uint256 deviationBps)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(_isBasket(tokenIn), "token");
        require(amountIn >= 3 && slippageBps <= MAX_SLIPPAGE_BPS && deviationBps <= MAX_DEVIATION_BPS, "params");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        (address otherA, address otherB) = _others(tokenIn);
        uint256 beforeA = IERC20(otherA).balanceOf(address(this));
        uint256 beforeB = IERC20(otherB).balanceOf(address(this));

        uint256 sellA;
        uint256 sellB;
        if (share.totalSupply() == 0) {
            sellA = amountIn / 3;
            sellB = amountIn / 3;
        } else {
            (sellA, sellB) = _salesForRatio(tokenIn, otherA, otherB, amountIn);
        }
        if (sellA > 0) _swap(tokenIn, otherA, sellA, slippageBps);
        if (sellB > 0) _swap(tokenIn, otherB, sellB, slippageBps);

        uint256 gotA = IERC20(otherA).balanceOf(address(this)) - beforeA;
        uint256 gotB = IERC20(otherB).balanceOf(address(this)) - beforeB;
        uint256 gotIn = amountIn - sellA - sellB;
        (uint256 bzbGot, uint256 wbtcGot, uint256 wethGot) = _triad(tokenIn, gotIn, otherA, gotA, otherB, gotB);
        shares = _mintShares(msg.sender, bzbGot, wbtcGot, wethGot, minShares, deviationBps);
    }

    /// @notice Burn M421 and sell the other two basket tokens into `tokenOut`.
    function zapOut(uint256 shares, address tokenOut, uint256 minOut, uint256 slippageBps) external nonReentrant {
        require(_isBasket(tokenOut), "token");
        require(slippageBps <= MAX_SLIPPAGE_BPS, "slippage");
        (uint256 bzbOut, uint256 wbtcOut, uint256 wethOut) = _burnShares(msg.sender, shares);
        uint256 got = tokenOut == address(bzb) ? bzbOut : tokenOut == address(wbtc) ? wbtcOut : wethOut;
        if (tokenOut != address(bzb) && bzbOut > 0) got += _swap(address(bzb), tokenOut, bzbOut, slippageBps);
        if (tokenOut != address(wbtc) && wbtcOut > 0) got += _swap(address(wbtc), tokenOut, wbtcOut, slippageBps);
        if (tokenOut != address(weth) && wethOut > 0) got += _swap(address(weth), tokenOut, wethOut, slippageBps);
        require(got >= minOut && got > 0, "slippage");
        IERC20(tokenOut).safeTransfer(msg.sender, got);
    }

    /// @notice Send tokens that were transferred in without a deposit back to the caller.
    function skim() external nonReentrant {
        uint256 a = _excess(bzb, reserveBzb);
        uint256 b = _excess(wbtc, reserveWbtc);
        uint256 c = _excess(weth, reserveWeth);
        if (a > 0) bzb.safeTransfer(msg.sender, a);
        if (b > 0) wbtc.safeTransfer(msg.sender, b);
        if (c > 0) weth.safeTransfer(msg.sender, c);
        emit Skim(msg.sender, a, b, c);
    }

    function _mintShares(
        address to,
        uint256 bzbAmount,
        uint256 wbtcAmount,
        uint256 wethAmount,
        uint256 minShares,
        uint256 deviationBps
    ) internal returns (uint256 shares) {
        uint256 supply = share.totalSupply();
        uint256 usedBzb = bzbAmount;
        uint256 usedWbtc = wbtcAmount;
        uint256 usedWeth = wethAmount;
        if (supply == 0) {
            require(reserveBzb == 0 && reserveWbtc == 0 && reserveWeth == 0, "seed");
            (uint256 va, uint256 vb, uint256 vc) = values(bzbAmount, wbtcAmount, wethAmount);
            _checkClose(va, vb, vc, deviationBps);
            uint256 totalUsd = va + vb + vc;
            require(totalUsd >= MIN_SEED_USD, "seed");
            shares = totalUsd * 1e10;
        } else {
            require(reserveBzb > 0 && reserveWbtc > 0 && reserveWeth > 0, "reserves");
            uint256 sb = (bzbAmount * supply) / reserveBzb;
            uint256 st = (wbtcAmount * supply) / reserveWbtc;
            uint256 se = (wethAmount * supply) / reserveWeth;
            shares = _min3(sb, st, se);
            usedBzb = (shares * reserveBzb) / supply;
            usedWbtc = (shares * reserveWbtc) / supply;
            usedWeth = (shares * reserveWeth) / supply;
        }
        require(shares >= minShares && shares > 0, "slippage");
        require(usedBzb > 0 && usedWbtc > 0 && usedWeth > 0, "dust");
        if (bzbAmount > usedBzb) bzb.safeTransfer(to, bzbAmount - usedBzb);
        if (wbtcAmount > usedWbtc) wbtc.safeTransfer(to, wbtcAmount - usedWbtc);
        if (wethAmount > usedWeth) weth.safeTransfer(to, wethAmount - usedWeth);
        reserveBzb += usedBzb;
        reserveWbtc += usedWbtc;
        reserveWeth += usedWeth;
        share.mint(to, shares);
        emit Deposit(to, usedBzb, usedWbtc, usedWeth, shares);
    }

    function _burnShares(address owner, uint256 shares)
        internal
        returns (uint256 bzbOut, uint256 wbtcOut, uint256 wethOut)
    {
        require(shares > 0 && share.balanceOf(owner) >= shares, "shares");
        uint256 supply = share.totalSupply();
        bzbOut = (reserveBzb * shares) / supply;
        wbtcOut = (reserveWbtc * shares) / supply;
        wethOut = (reserveWeth * shares) / supply;
        require(bzbOut > 0 && wbtcOut > 0 && wethOut > 0, "dust");
        reserveBzb -= bzbOut;
        reserveWbtc -= wbtcOut;
        reserveWeth -= wethOut;
        share.burn(owner, shares);
        emit Withdraw(owner, shares, bzbOut, wbtcOut, wethOut);
    }

    function _salesForRatio(address tokenIn, address otherA, address otherB, uint256 amountIn)
        internal
        view
        returns (uint256 sellA, uint256 sellB)
    {
        uint256 rIn = _reserveOf(tokenIn);
        uint256 rA = _reserveOf(otherA);
        uint256 rB = _reserveOf(otherB);
        uint256 probe = amountIn / 20;
        if (probe == 0) probe = amountIn;
        uint256 perA = Math.mulDiv(
            router.getAmountsOut(probe, route(tokenIn, otherA))[route(tokenIn, otherA).length - 1], 1e18, probe
        );
        uint256 perB = Math.mulDiv(
            router.getAmountsOut(probe, route(tokenIn, otherB))[route(tokenIn, otherB).length - 1], 1e18, probe
        );
        require(perA > 0 && perB > 0 && rIn > 0, "quote");
        uint256 denom = rIn + Math.mulDiv(rA, 1e18, perA) + Math.mulDiv(rB, 1e18, perB);
        uint256 k = Math.mulDiv(amountIn, rIn, denom);
        sellA = Math.mulDiv(Math.mulDiv(amountIn, rA, denom), 1e18, perA);
        sellB = amountIn > k + sellA ? amountIn - k - sellA : 0;
    }

    function _triad(
        address tokenIn,
        uint256 gotIn,
        address otherA,
        uint256 gotA,
        address otherB,
        uint256 gotB
    ) internal view returns (uint256 bzbGot, uint256 wbtcGot, uint256 wethGot) {
        bzbGot = _pick(address(bzb), tokenIn, gotIn, otherA, gotA, otherB, gotB);
        wbtcGot = _pick(address(wbtc), tokenIn, gotIn, otherA, gotA, otherB, gotB);
        wethGot = _pick(address(weth), tokenIn, gotIn, otherA, gotA, otherB, gotB);
    }

    function _pick(
        address want,
        address tokenIn,
        uint256 gotIn,
        address otherA,
        uint256 gotA,
        address otherB,
        uint256 gotB
    ) internal pure returns (uint256) {
        if (want == tokenIn) return gotIn;
        if (want == otherA) return gotA;
        return gotB;
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 slippageBps) internal returns (uint256 out) {
        address[] memory path = route(tokenIn, tokenOut);
        uint256 quoted = router.getAmountsOut(amountIn, path)[path.length - 1];
        uint256 minOut = (quoted * (10_000 - slippageBps)) / 10_000;
        uint256[] memory amounts = router.swapExactTokensForTokens(amountIn, minOut, path, address(this), block.timestamp);
        out = amounts[amounts.length - 1];
    }

    function _checkClose(uint256 a, uint256 b, uint256 c, uint256 deviationBps) internal pure {
        uint256 hi = _max3(a, b, c);
        uint256 lo = _min3(a, b, c);
        require(lo > 0, "value");
        require(((hi - lo) * 10_000) / hi <= deviationBps, "value");
    }

    function _bzbUsd(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        address[] memory path = new address[](2);
        path[0] = address(bzb);
        path[1] = usdc;
        uint256 out = router.getAmountsOut(amount, path)[1];
        return out * 100;
    }

    function _wbtcUsd(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        return (amount * _feed(btcUsd, btcDecimals)) / 1e8;
    }

    function _wethUsd(uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        return (amount * _feed(ethUsd, ethDecimals)) / 1e18;
    }

    function _feed(IAggregatorV3 feed, uint8 decimals_) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        require(answer > 0 && updatedAt != 0 && block.timestamp - updatedAt <= 1 days, "oracle");
        uint256 px = uint256(answer);
        if (decimals_ < 8) return px * 10 ** (8 - decimals_);
        if (decimals_ > 8) return px / 10 ** (decimals_ - 8);
        return px;
    }

    function _reserveOf(address token) internal view returns (uint256) {
        if (token == address(bzb)) return reserveBzb;
        if (token == address(wbtc)) return reserveWbtc;
        return reserveWeth;
    }

    function _others(address tokenIn) internal view returns (address a, address b) {
        if (tokenIn == address(bzb)) return (address(wbtc), address(weth));
        if (tokenIn == address(wbtc)) return (address(bzb), address(weth));
        return (address(bzb), address(wbtc));
    }

    function _isBasket(address token) internal view returns (bool) {
        return token == address(bzb) || token == address(wbtc) || token == address(weth);
    }

    function _excess(IERC20 token, uint256 reserve) internal view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > reserve ? bal - reserve : 0;
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 m = a < b ? a : b;
        return m < c ? m : c;
    }

    function _max3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 m = a > b ? a : b;
        return m > c ? m : c;
    }
}
