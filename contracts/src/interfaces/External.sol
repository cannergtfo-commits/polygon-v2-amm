// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice USD quote in 8-decimal fixed point. `trusted` is true only for a fresh Chainlink answer.
interface IBlazarUsdOracle {
    function quote(address token, uint256 amount) external view returns (uint256 usdE8, bool trusted);
}
