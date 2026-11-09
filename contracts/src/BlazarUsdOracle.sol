// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAggregatorV3, IBlazarUsdOracle, IV2Pair} from "./interfaces/External.sol";

/// @title BlazarUsdOracle
/// @notice Prices an ERC-20 amount in 8-decimal USD.
///         Chainlink answers are marked trusted. Spot prices read from a V2 pair
///         against a Chainlink-priced anchor are marked untrusted (manipulable in-block).
///         The volume indexer recomputes points from previous-block state and does not
///         treat untrusted quotes as scoreable on their own.
contract BlazarUsdOracle is Ownable2Step, IBlazarUsdOracle {
    struct Feed {
        address aggregator;
        uint8 tokenDecimals;
        bool set;
    }

    struct Spot {
        address pair;
        address anchor;
        bool set;
    }

    uint256 public maxAge = 1 days;
    mapping(address => Feed) public feeds;
    mapping(address => Spot) public spots;

    event FeedSet(address indexed token, address indexed aggregator, uint8 tokenDecimals);
    event SpotSet(address indexed token, address indexed pair, address indexed anchor);
    event MaxAgeSet(uint256 maxAge);

    error ZeroAddress();
    error BadPair();
    error AgeCap();

    constructor(
        address initialOwner,
        address[] memory tokens,
        address[] memory aggregators,
        uint8[] memory tokenDecimals
    ) Ownable(initialOwner) {
        uint256 n = tokens.length;
        require(n == aggregators.length && n == tokenDecimals.length, "len");
        for (uint256 i; i < n; ++i) {
            _setFeed(tokens[i], aggregators[i], tokenDecimals[i]);
        }
    }

    function setMaxAge(uint256 next) external onlyOwner {
        if (next < 30 minutes || next > 7 days) revert AgeCap();
        maxAge = next;
        emit MaxAgeSet(next);
    }

    function setFeed(address token, address aggregator, uint8 tokenDecimals) external onlyOwner {
        _setFeed(token, aggregator, tokenDecimals);
    }

    function clearFeed(address token) external onlyOwner {
        delete feeds[token];
        emit FeedSet(token, address(0), 0);
    }

    /// @param pair A UniswapV2-style pair that contains `token` and `anchor`.
    /// @param anchor A token that already has a Chainlink feed.
    function setSpot(address token, address pair, address anchor) external onlyOwner {
        if (token == address(0) || pair == address(0) || anchor == address(0)) revert ZeroAddress();
        if (!feeds[anchor].set) revert BadPair();
        address t0 = IV2Pair(pair).token0();
        address t1 = IV2Pair(pair).token1();
        bool ok = (t0 == token && t1 == anchor) || (t1 == token && t0 == anchor);
        if (!ok) revert BadPair();
        spots[token] = Spot({pair: pair, anchor: anchor, set: true});
        emit SpotSet(token, pair, anchor);
    }

    function clearSpot(address token) external onlyOwner {
        delete spots[token];
        emit SpotSet(token, address(0), address(0));
    }

    function quote(address token, uint256 amount) external view returns (uint256 usdE8, bool trusted) {
        if (amount == 0) return (0, false);
        if (feeds[token].set) {
            return _fromFeed(token, amount);
        }
        // Spot is untrusted. Volume scoring must not use this branch.
        if (spots[token].set) {
            return (_fromSpot(token, amount), false);
        }
        return (0, false);
    }

    function _setFeed(address token, address aggregator, uint8 tokenDecimals) internal {
        if (token == address(0) || aggregator == address(0)) revert ZeroAddress();
        feeds[token] = Feed({aggregator: aggregator, tokenDecimals: tokenDecimals, set: true});
        emit FeedSet(token, aggregator, tokenDecimals);
    }

    function _fromFeed(address token, uint256 amount) internal view returns (uint256 usdE8, bool trusted) {
        Feed memory feed = feeds[token];
        if (!feed.set || amount == 0) return (0, false);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            IAggregatorV3(feed.aggregator).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) {
            return (0, false);
        }
        if (answeredInRound < roundId) return (0, false);
        uint8 priceDecimals = IAggregatorV3(feed.aggregator).decimals();
        uint256 scale = uint256(priceDecimals) + uint256(feed.tokenDecimals);
        if (scale >= 8) {
            usdE8 = Math.mulDiv(uint256(answer), amount, 10 ** (scale - 8));
        } else {
            usdE8 = uint256(answer) * amount * (10 ** (8 - scale));
        }
        trusted = true;
    }

    function _fromSpot(address token, uint256 amount) internal view returns (uint256 usdE8) {
        Spot memory spot = spots[token];
        if (!spot.set) return 0;
        (uint112 r0, uint112 r1,) = IV2Pair(spot.pair).getReserves();
        address t0 = IV2Pair(spot.pair).token0();
        uint256 reserveToken = t0 == token ? uint256(r0) : uint256(r1);
        uint256 reserveAnchor = t0 == token ? uint256(r1) : uint256(r0);
        if (reserveToken == 0 || reserveAnchor == 0) return 0;
        uint256 anchorRaw = Math.mulDiv(amount, reserveAnchor, reserveToken);
        (usdE8,) = _fromFeed(spot.anchor, anchorRaw);
    }
}
