// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Pass-2 review mock: once armed, EVERY entry point (incl. balanceOf) reverts or burns all gas.
contract HostileToken is ERC20 {
    uint8 public mode; // 0 normal, 1 revert everything, 2 burn all gas

    constructor() ERC20("Hostile", "HOS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function _hostile() internal view {
        if (mode == 1) revert("hostile");
        if (mode == 2) {
            while (true) {}
        }
    }

    function balanceOf(address a) public view override returns (uint256) {
        _hostile();
        return super.balanceOf(a);
    }

    function _update(address from, address to, uint256 value) internal override {
        _hostile();
        super._update(from, to, value);
    }
}

/// @notice Negative-rebase style token: anyone can slash an account's balance (models balance-reducing tokens).
contract SlashableToken is ERC20 {
    constructor() ERC20("Slash", "SLS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function slash(address who, uint256 amount) external {
        _burn(who, amount);
    }
}
