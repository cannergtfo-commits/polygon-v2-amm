// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Owner can blacklist accounts (USDC/USDT style) or freeze every transfer.
contract BlacklistToken is ERC20 {
    mapping(address => bool) public blocked;
    bool public frozen;

    constructor() ERC20("Blacklist", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function setFrozen(bool f) external {
        frozen = f;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen, "frozen");
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

interface IReenterTarget {
    function withdraw(uint256) external;
    function claim(address) external;
    function stake(uint256) external;
}

/// @notice On every outgoing transfer from `target`, tries to reenter `target`.
contract ReentrantToken is ERC20 {
    address public target;
    uint8 public mode; // 0 off, 1 claim, 2 withdraw

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, uint8 mode_) external {
        target = target_;
        mode = mode_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (mode != 0 && from == target && to != address(0)) {
            uint8 m = mode;
            mode = 0;
            if (m == 1) IReenterTarget(target).claim(address(this));
            else IReenterTarget(target).withdraw(1);
        }
    }
}
