// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBlazarUsdOracle, IV2Factory, IV2Pair, IWETH9} from "./interfaces/External.sol";

/// @title BlazarFeeRouter
/// @notice Thin aggregator wrapper. Pulls `tokenIn`, then executes an allowlisted route.
///         The wrapper fee is 0.05% of external-routed principal, taken once. A unit of
///         value is charged the first time it is spent on a leg that is not the BlazarSwap
///         factory. Later hops of that same value, including further external hops, are
///         not charged again. A path that only touches the Blazar factory pays no wrapper
///         fee. A split charges only the slices that enter an external venue. Output is
///         a balance delta.
/// @dev Not deployed. Shipping this source is not a mainnet release.
contract BlazarFeeRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant KIND_TARGET = 0;
    uint8 public constant KIND_V2 = 1;
    uint16 public constant MAX_FEE_BPS = 25;
    uint16 public constant BPS = 10_000;
    uint256 public constant NO_PATCH = type(uint256).max;
    uint256 public constant MAX_CALLS = 8;
    uint256 public constant MAX_SWEEP = 6;
    /// @notice A signed quote cannot be held open longer than this. Wall-clock staleness
    ///         beyond the window is rejected even if the caller sets a later deadline.
    uint256 public constant MAX_DEADLINE_WINDOW = 3 minutes;
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    struct Call {
        uint8 kind;
        address target;
        address spendToken;
        address v2TokenOut;
        uint16 bps;
        bool useBalance;
        /// @notice Minimum tokens this hop must add of `v2TokenOut`. Zero is rejected.
        ///         The router enforces this on the balance delta. A router hop's calldata
        ///         minimum is overwritten from this field when `minOffset` is set, so a
        ///         zero buried in `data` does not weaken the signed hop.
        uint256 minBuy;
        uint256 amountOffset;
        /// @notice Byte offset of amountOutMinimum in `data`, or {NO_PATCH} when the
        ///         target has no such word. V2 hops use {NO_PATCH}.
        uint256 minOffset;
        bytes data;
    }

    /// @notice Fee in basis points. 5 = 0.05%. Owner can set 0..MAX_FEE_BPS and cannot exceed the cap.
    uint16 public feeBps = 5;
    address public immutable feeRecipient;
    address public immutable wpol;
    /// @notice V2 factory whose pools are not charged the wrapper fee.
    address public immutable blazarFactory;
    IBlazarUsdOracle public oracle;

    mapping(address => bool) public allowedTarget;
    /// @notice V2 fee for an allowlisted factory, in bps (30 = 0.30%). Zero means the factory is not allowed.
    mapping(address => uint16) public v2FeeBps;

    event AggregatedSwap(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        address recipient,
        uint256 amountIn,
        uint256 feeAmount,
        uint256 amountOut,
        uint256 usdE8,
        bool usdTrusted,
        uint16 feeBps,
        bytes32 routeId
    );
    event FeeBpsSet(uint16 feeBps);
    event OracleSet(address indexed oracle);
    event TargetSet(address indexed target, bool allowed);
    event V2FactorySet(address indexed factory, uint16 feeBps);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    /// @notice Wrapper fee taken from principal that had not been charged yet in this swap.
    event WrapperFee(address indexed trader, address indexed token, uint256 amount);

    error Expired();
    error StaleQuote();
    error ZeroAddress();
    error SameToken();
    error ValueMismatch();
    error BadRoute();
    error TargetNotAllowed(address target);
    error FactoryNotAllowed(address factory);
    error InsufficientOutput(uint256 got, uint256 min);
    error FeeTooHigh(uint16 requested, uint16 maxFee);

    constructor(address initialOwner, address feeRecipient_, address wpol_, address blazarFactory_, address oracle_)
        Ownable(initialOwner)
    {
        if (feeRecipient_ == address(0) || wpol_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        wpol = wpol_;
        blazarFactory = blazarFactory_;
        if (oracle_ != address(0)) oracle = IBlazarUsdOracle(oracle_);
    }

    receive() external payable {}

    function setFeeBps(uint16 next) external onlyOwner {
        if (next > MAX_FEE_BPS) revert FeeTooHigh(next, MAX_FEE_BPS);
        feeBps = next;
        emit FeeBpsSet(next);
    }

    function setOracle(address next) external onlyOwner {
        oracle = IBlazarUsdOracle(next);
        emit OracleSet(next);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0) || target == address(this)) revert ZeroAddress();
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function setV2Factory(address factory, uint16 feeBps_) external onlyOwner {
        if (factory == address(0)) revert ZeroAddress();
        if (feeBps_ >= 1_000) revert BadRoute();
        v2FeeBps[factory] = feeBps_;
        emit V2FactorySet(factory, feeBps_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Owner recovery for tokens left behind by a reverted-but-funded path or a donation.
    ///         Swaps do not leave user funds here. Rescue works only while paused.
    function rescueToken(address token, uint256 amount, address to) external onlyOwner whenPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    function rescueETH(uint256 amount, address to) external onlyOwner whenPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _sendETH(to, amount);
        emit Rescued(address(0), to, amount);
    }

    /// @notice Swap `tokenIn` for `tokenOut`. Use address(0) or {NATIVE} for POL.
    /// @param unwrapNative When true, `tokenOut` must be WPOL. The wrapper unwraps and sends POL.
    /// @param calls Route built off-chain. V2 legs use KIND_V2. Router legs use KIND_TARGET and must
    ///        deliver `tokenOut` to this contract. `bps` is applied to the remaining input budget,
    ///        or to the spend token's balance when `useBalance` is set (later hops).
    /// @param sweep Intermediate tokens to return to msg.sender after the swap.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline,
        bool unwrapNative,
        Call[] calldata calls,
        address[] calldata sweep
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (deadline > block.timestamp + MAX_DEADLINE_WINDOW) revert StaleQuote();
        if (minAmountOut == 0) revert BadRoute();
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();
        if (amountIn == 0 || calls.length == 0 || calls.length > MAX_CALLS || sweep.length > MAX_SWEEP) {
            revert BadRoute();
        }

        bool nativeIn = _isNative(tokenIn);
        address inToken = nativeIn ? wpol : tokenIn;
        address measure = unwrapNative ? wpol : tokenOut;
        if (_isNative(measure) || measure == address(0)) revert BadRoute();
        if (unwrapNative && tokenOut != wpol && !_isNative(tokenOut)) revert BadRoute();
        if (inToken == measure) revert SameToken();

        uint16 feeNow = feeBps;
        address[16] memory floorToken;
        uint256[16] memory floorAmt;
        _remember(floorToken, floorAmt, inToken);
        _remember(floorToken, floorAmt, measure);
        for (uint256 i; i < calls.length; ++i) {
            _remember(floorToken, floorAmt, calls[i].spendToken);
            _remember(floorToken, floorAmt, calls[i].v2TokenOut);
        }
        for (uint256 i; i < sweep.length; ++i) {
            _remember(floorToken, floorAmt, sweep[i]);
        }
        uint256 inputFloor = _floorOf(floorToken, floorAmt, inToken);
        (uint256 received, uint256 budget) = _pull(nativeIn, inToken, amountIn);

        uint256 outBefore = IERC20(measure).balanceOf(address(this));
        uint256 feeAmount = _run(calls, inToken, budget, feeNow, inputFloor, floorToken, floorAmt);
        uint256 gained = IERC20(measure).balanceOf(address(this)) - outBefore;
        if (gained < minAmountOut) revert InsufficientOutput(gained, minAmountOut);

        uint256 recipientBefore = unwrapNative ? recipient.balance : IERC20(measure).balanceOf(recipient);
        if (unwrapNative) {
            IWETH9(wpol).withdraw(gained);
            _sendETH(recipient, gained);
        } else {
            IERC20(measure).safeTransfer(recipient, gained);
        }
        uint256 recipientAfter = unwrapNative ? recipient.balance : IERC20(measure).balanceOf(recipient);
        if (recipientAfter < recipientBefore) revert InsufficientOutput(0, minAmountOut);
        amountOut = recipientAfter - recipientBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        uint256 inputLeft = IERC20(inToken).balanceOf(address(this));
        uint256 refundable = inputLeft > inputFloor ? inputLeft - inputFloor : 0;
        uint256 consumed = refundable >= received ? 0 : received - refundable;
        _refundAbove(nativeIn, inToken, inputFloor, msg.sender);
        for (uint256 i; i < sweep.length; ++i) {
            if (sweep[i] == inToken || sweep[i] == measure) continue;
            _refundAbove(false, sweep[i], _floorOf(floorToken, floorAmt, sweep[i]), msg.sender);
        }

        (uint256 usdE8, bool trusted) = _price(inToken, consumed);
        address eventOut = unwrapNative ? address(0) : tokenOut;
        emit AggregatedSwap(
            msg.sender,
            nativeIn ? address(0) : tokenIn,
            eventOut,
            recipient,
            consumed,
            feeAmount,
            amountOut,
            usdE8,
            trusted,
            feeNow,
            keccak256(abi.encode(calls))
        );
    }

    /// @notice Constant-product output with a fee taken in bps (30 = 0.30%, identical to 997/1000).
    function quoteV2(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint16 feeBps_)
        public
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0 || feeBps_ >= BPS) return 0;
        uint256 amountInWithFee = amountIn * (BPS - feeBps_);
        amountOut = Math.mulDiv(amountInWithFee, reserveOut, reserveIn * BPS + amountInWithFee);
    }

    function _pull(bool nativeIn, address inToken, uint256 amountIn)
        internal
        returns (uint256 received, uint256 budget)
    {
        if (nativeIn) {
            if (msg.value != amountIn) revert ValueMismatch();
            received = amountIn;
            budget = received;
            if (budget > 0) IWETH9(wpol).deposit{value: budget}();
        } else {
            if (msg.value != 0) revert ValueMismatch();
            uint256 beforeBal = IERC20(inToken).balanceOf(address(this));
            IERC20(inToken).safeTransferFrom(msg.sender, address(this), amountIn);
            received = IERC20(inToken).balanceOf(address(this)) - beforeBal;
            budget = received;
        }
        if (budget == 0) revert BadRoute();
    }

    /// @dev Wrapper fee taken in the original input token. Fees on a later token are still
    ///      transferred and emitted; they are not added here because they are not units of `tokenIn`.
    ///      Unpaid principal is tracked in two places so a dust hop cannot mark the reserved
    ///      input as already charged: `budgetUnpaid` is the unspent input, and `produced*`
    ///      is unpaid value created by earlier Blazar hops.
    function _run(
        Call[] calldata calls,
        address budgetToken,
        uint256 budgetStart,
        uint16 feeNow,
        uint256 inputFloor,
        address[16] memory floorToken,
        uint256[16] memory floorAmt
    ) internal returns (uint256 inputFee)
    {
        uint256 budget = budgetStart;
        uint256 budgetUnpaid = budgetStart;
        address[8] memory producedToken;
        uint256[8] memory producedUnpaid;
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            if (c.bps == 0 || c.bps > BPS || c.spendToken == address(0)) revert BadRoute();
            uint256 base;
            if (c.useBalance) {
                uint256 bal = IERC20(c.spendToken).balanceOf(address(this));
                uint256 floor = c.spendToken == budgetToken ? inputFloor : _floorOf(floorToken, floorAmt, c.spendToken);
                if (bal < floor) revert BadRoute();
                uint256 above = bal - floor;
                if (c.spendToken == budgetToken) {
                    if (above < budget) revert BadRoute();
                    base = above - budget;
                } else {
                    base = above;
                }
            } else {
                if (c.spendToken != budgetToken) revert BadRoute();
                base = budget;
            }
            uint256 spendAmt = Math.mulDiv(base, c.bps, BPS);
            if (spendAmt == 0) revert BadRoute();
            if (!c.useBalance) budget -= spendAmt;

            uint256 unpaidTaken;
            if (!c.useBalance) {
                if (spendAmt > budgetUnpaid) revert BadRoute();
                budgetUnpaid -= spendAmt;
                unpaidTaken = spendAmt;
            } else {
                uint256 have = _producedUnpaid(producedToken, producedUnpaid, c.spendToken);
                unpaidTaken = spendAmt < have ? spendAmt : have;
                if (unpaidTaken > 0) _bumpProduced(producedToken, producedUnpaid, c.spendToken, unpaidTaken, false);
            }

            uint256 spendGross = spendAmt;
            if (!_isBlazar(c) && unpaidTaken > 0) {
                uint256 feeTaken = Math.mulDiv(unpaidTaken, feeNow, BPS);
                if (feeTaken > 0) {
                    IERC20(c.spendToken).safeTransfer(feeRecipient, feeTaken);
                    emit WrapperFee(msg.sender, c.spendToken, feeTaken);
                    if (c.spendToken == budgetToken) inputFee += feeTaken;
                    spendAmt -= feeTaken;
                }
            }
            if (spendAmt == 0 || c.minBuy == 0 || c.v2TokenOut == address(0)) revert BadRoute();

            uint256 outBefore = IERC20(c.v2TokenOut).balanceOf(address(this));
            if (c.kind == KIND_V2) {
                _swapV2(c.target, c.spendToken, c.v2TokenOut, spendAmt);
            } else if (c.kind == KIND_TARGET) {
                if (!allowedTarget[c.target] || c.target == address(this)) revert TargetNotAllowed(c.target);
                IERC20(c.spendToken).forceApprove(c.target, spendAmt);
                _call(c, spendAmt);
                IERC20(c.spendToken).forceApprove(c.target, 0);
            } else {
                revert BadRoute();
            }
            uint256 hopOut = IERC20(c.v2TokenOut).balanceOf(address(this)) - outBefore;
            if (hopOut < c.minBuy) revert InsufficientOutput(hopOut, c.minBuy);
            if (_isBlazar(c) && unpaidTaken > 0 && spendGross > 0) {
                _bumpProduced(producedToken, producedUnpaid, c.v2TokenOut, Math.mulDiv(hopOut, unpaidTaken, spendGross), true);
            }
        }
    }

    function _producedUnpaid(address[8] memory tokens, uint256[8] memory amts, address token)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i; i < 8; ++i) {
            if (tokens[i] == token) return amts[i];
        }
        return 0;
    }

    function _bumpProduced(
        address[8] memory tokens,
        uint256[8] memory amts,
        address token,
        uint256 amount,
        bool add
    ) internal pure {
        if (amount == 0 || token == address(0)) return;
        for (uint256 i; i < 8; ++i) {
            if (tokens[i] == token || (add && tokens[i] == address(0))) {
                tokens[i] = token;
                if (add) amts[i] += amount;
                else amts[i] -= amount;
                return;
            }
        }
        revert BadRoute();
    }

    function _swapV2(address factory, address tokenIn, address tokenOut, uint256 amountIn) internal {
        uint16 poolFee = v2FeeBps[factory];
        if (poolFee == 0) revert FactoryNotAllowed(factory);
        if (tokenOut == address(0) || tokenIn == tokenOut) revert BadRoute();
        address pair = IV2Factory(factory).getPair(tokenIn, tokenOut);
        if (pair == address(0) || pair.code.length == 0) revert BadRoute();
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        bool inIs0 = tokenIn < tokenOut;
        address token0 = inIs0 ? tokenIn : tokenOut;
        // Pair token ordering is address sort, matching UniswapV2. Confirm against the pair.
        if (IV2Pair(pair).token0() != token0) revert BadRoute();
        uint256 reserveIn = inIs0 ? uint256(r0) : uint256(r1);
        uint256 reserveOut = inIs0 ? uint256(r1) : uint256(r0);
        uint256 beforeBal = IERC20(tokenIn).balanceOf(pair);
        IERC20(tokenIn).safeTransfer(pair, amountIn);
        uint256 actualIn = IERC20(tokenIn).balanceOf(pair) - beforeBal;
        uint256 amountOut = quoteV2(actualIn, reserveIn, reserveOut, poolFee);
        if (amountOut == 0 || amountOut >= reserveOut) revert BadRoute();
        (uint256 amount0Out, uint256 amount1Out) = inIs0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        IV2Pair(pair).swap(amount0Out, amount1Out, address(this), "");
    }

    function _call(Call calldata c, uint256 spendAmt) internal {
        bytes memory data = c.data;
        if (data.length < 4) revert BadRoute();
        if (c.amountOffset != NO_PATCH) {
            if (c.amountOffset + 32 > data.length) revert BadRoute();
            _patch(data, c.amountOffset, spendAmt);
        }
        if (c.minOffset != NO_PATCH) {
            if (c.minOffset + 32 > data.length) revert BadRoute();
            _patch(data, c.minOffset, c.minBuy);
        }
        (bool ok, bytes memory ret) = c.target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _patch(bytes memory data, uint256 offset, uint256 value) internal pure {
        assembly ("memory-safe") {
            mstore(add(add(data, 32), offset), value)
        }
    }

    function _remember(address[16] memory tokens, uint256[16] memory amts, address token) internal view {
        if (token == address(0) || _isNative(token)) return;
        for (uint256 i; i < 16; ++i) {
            if (tokens[i] == token) return;
            if (tokens[i] == address(0)) {
                tokens[i] = token;
                amts[i] = IERC20(token).balanceOf(address(this));
                return;
            }
        }
        revert BadRoute();
    }

    function _floorOf(address[16] memory tokens, uint256[16] memory amts, address token) internal pure returns (uint256) {
        for (uint256 i; i < 16; ++i) {
            if (tokens[i] == token) return amts[i];
        }
        return 0;
    }

    function _refundAbove(bool nativeIn, address token, uint256 floorAmt, address to) internal {
        if (token == address(0) || _isNative(token)) return;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal <= floorAmt) return;
        uint256 amt = bal - floorAmt;
        if (nativeIn && token == wpol) {
            IWETH9(wpol).withdraw(amt);
            _sendETH(to, amt);
        } else {
            IERC20(token).safeTransfer(to, amt);
        }
    }

    function _refundInput(bool nativeIn, address inToken, address to) internal {
        if (nativeIn) {
            uint256 left = IERC20(wpol).balanceOf(address(this));
            if (left == 0) return;
            IWETH9(wpol).withdraw(left);
            _sendETH(to, left);
        } else {
            _refundToken(inToken, to);
        }
    }

    function _refundToken(address token, address to) internal {
        if (token == address(0)) return;
        uint256 left = IERC20(token).balanceOf(address(this));
        if (left > 0) IERC20(token).safeTransfer(to, left);
    }

    function _price(address token, uint256 amount) internal view returns (uint256 usdE8, bool trusted) {
        if (address(oracle) == address(0) || amount == 0) return (0, false);
        try oracle.quote(token, amount) returns (uint256 v, bool t) {
            return (v, t);
        } catch {
            return (0, false);
        }
    }

    function _sendETH(address to, uint256 amount) internal {
        Address.sendValue(payable(to), amount);
    }

    function _isNative(address token) internal pure returns (bool) {
        return token == address(0) || token == NATIVE;
    }

    /// @dev Only a V2 leg whose factory is the immutable Blazar factory skips the wrapper fee.
    ///      A caller cannot relabel a third-party router as Blazar: KIND_TARGET is always charged,
    ///      and KIND_V2 resolves the pair from the factory it names.
    function _isBlazar(Call calldata c) internal view returns (bool) {
        return blazarFactory != address(0) && c.kind == KIND_V2 && c.target == blazarFactory;
    }
}
