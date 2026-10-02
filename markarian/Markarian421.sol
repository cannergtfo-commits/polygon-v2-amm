// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Markarian421
/// @notice Receipt for the WBTC / WETH / BzB basket. Only the vault mints and burns.
contract Markarian421 is ERC20 {
    address public immutable minter;
    string public description;

    constructor(string memory description_) ERC20("Markarian 421", "M421") {
        minter = msg.sender;
        description = description_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "minter");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "minter");
        _burn(from, amount);
    }
}
