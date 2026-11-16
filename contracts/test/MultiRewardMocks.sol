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

/// @notice Reward token whose outgoing transfers can be switched into hostile modes, for the skipping exits.
///         0 ok, 1 revert, 2 return false (no transfer), 3 burn all gas, 4 returnbomb revert,
///         5 transfer THEN return false (lying), 6 burn `hungry` gas then transfer normally.
contract FlakyToken is ERC20 {
    uint8 public mode;
    uint256 public hungry = 150_000;

    constructor() ERC20("Flaky", "FLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function setHungry(uint256 g) external {
        hungry = g;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        uint8 m = mode;
        if (m == 1) revert("flaky: revert");
        if (m == 2) return false;
        if (m == 3) {
            while (true) {}
        }
        if (m == 4) {
            assembly {
                revert(0, 200000) // large revert data; the caller must not copy it
            }
        }
        if (m == 5) {
            super.transfer(to, value);
            return false;
        }
        if (m == 6) {
            uint256 stop = gasleft() > hungry ? gasleft() - hungry : 0;
            while (gasleft() > stop) {}
        }
        return super.transfer(to, value);
    }
}
