// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BlazarFeeRouter} from "../src/BlazarFeeRouter.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Takes a fee from the transferred value. Recipient receives value minus fee.
contract TaxToken is ERC20 {
    uint256 public taxBps;
    address public sink;

    constructor(uint256 taxBps_, address sink_) ERC20("Tax", "TAX") {
        taxBps = taxBps_;
        sink = sink_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && taxBps > 0 && to != sink && from != sink) {
            uint256 fee = value * taxBps / 10_000;
            super._update(from, sink, fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped POL", "WPOL") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "eth");
    }

    receive() external payable {}
}

contract MockFactory {
    mapping(address => mapping(address => address)) public pairs;

    function setPair(address a, address b, address pair) external {
        pairs[a][b] = pair;
        pairs[b][a] = pair;
    }

    function getPair(address a, address b) external view returns (address) {
        return pairs[a][b];
    }
}

contract MockPair {
    address public token0;
    address public token1;
    uint112 public reserve0;
    uint112 public reserve1;

    constructor(address a, address b) {
        require(a != b && a != address(0) && b != address(0), "pair");
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function sync() external {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "out");
        require(to != token0 && to != token1, "to");
        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0In = bal0 > reserve0 - amount0Out ? bal0 - (reserve0 - amount0Out) : 0;
        uint256 amount1In = bal1 > reserve1 - amount1Out ? bal1 - (reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "in");
        uint256 bal0Adj = bal0 * 1000 - amount0In * 3;
        uint256 bal1Adj = bal1 * 1000 - amount1In * 3;
        require(bal0Adj * bal1Adj >= uint256(reserve0) * uint256(reserve1) * (1000 ** 2), "K");
        reserve0 = uint112(bal0);
        reserve1 = uint112(bal1);
    }
}

contract EchoVenue {
    uint256 public seen;

    function take(uint256 amount, address tokenIn, address tokenOut) external {
        seen = amount;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amount);
        IERC20(tokenOut).transfer(msg.sender, amount);
    }
}

contract ReenterVenue {
    BlazarFeeRouter public router;
    bool public hit;

    function setRouter(address router_) external {
        router = BlazarFeeRouter(payable(router_));
    }

    function poke(uint256) external {
        hit = true;
        BlazarFeeRouter.Call[] memory calls = new BlazarFeeRouter.Call[](1);
        address[] memory sweep = new address[](0);
        router.swap(address(0), address(1), 1, 0, msg.sender, block.timestamp + 10, false, calls, sweep);
    }
}

/// @notice Taxes only the router's outgoing transfer, so the pool can still pay the wrapper in full.
contract RecipientTax is ERC20 {
    address public router;

    constructor() ERC20("Taxed out", "TOUT") {}

    function setRouter(address router_) external {
        router = router_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == router && to != address(0) && to != router) {
            uint256 fee = value / 100;
            super._update(from, address(this), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockFeed {
    int256 public answer;
    uint8 public decimals;
    uint256 public updatedAt;

    constructor(int256 answer_, uint8 decimals_) {
        answer = answer_;
        decimals = decimals_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
