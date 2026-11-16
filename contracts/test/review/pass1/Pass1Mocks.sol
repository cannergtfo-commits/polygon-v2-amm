// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Owner-controlled malicious token: reports a fake balance for `victim` and moves nothing on transferFrom.
/// Lets an owner create runs of any size (<= MAX_RUN_AMOUNT) with no real funding.
contract LyingToken {
    address public victim;
    uint256 public fake;

    function setVictim(address v) external {
        victim = v;
    }

    function bump(uint256 by) external {
        fake += by;
    }

    function balanceOf(address a) external view returns (uint256) {
        return a == victim ? fake : 0;
    }

    function transferFrom(address, address to, uint256 v) external returns (bool) {
        if (to == victim) fake += v; // pretend it arrived
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("lying: no real tokens");
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// Burns all gas on outgoing `transfer` (pays out). transferFrom/balanceOf behave.
contract GasBombToken is ERC20 {
    bool public armed;
    constructor() ERC20("Bomb", "BOMB") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(bool a) external {
        armed = a;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        if (armed) {
            while (true) {
                assembly { pop(sload(0x1234)) }
            }
        }
        return super.transfer(to, v);
    }
}

/// Returns false from transfer when toggled.
contract FalseToken is ERC20 {
    bool public bad;
    constructor() ERC20("False", "FALSE") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setBad(bool b) external {
        bad = b;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        if (bad) return false;
        return super.transfer(to, v);
    }
}

interface IStakingLike {
    function stake(uint256) external;
    function withdraw(uint256) external;
    function emergencyWithdraw() external;
    function claim(address) external;
    function recover(address, uint256, address) external;
    function notifyRewardAmount(bytes calldata) external;
}

/// On every outgoing transfer from `target`, tries every reentry and records whether any succeeded.
contract ReenterAllToken is ERC20 {
    address public target;
    bool public armed;
    uint256 public reentrySucceeded;
    uint256 public reentryAttempts;
    constructor() ERC20("ReAll", "REALL") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(address t, bool a) external {
        target = t;
        armed = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == target && to != address(0)) {
            armed = false;
            IStakingLike t = IStakingLike(target);
            reentryAttempts += 4;
            try t.withdraw(1) {
                reentrySucceeded++;
            } catch {}
            try t.emergencyWithdraw() {
                reentrySucceeded++;
            } catch {}
            try t.claim(address(this)) {
                reentrySucceeded++;
            } catch {}
            try t.recover(address(this), 1, address(this)) {
                reentrySucceeded++;
            } catch {}
            armed = true;
        }
    }
}

/// Simulates a future BZB proxy upgrade that charges the SENDER an extra fee on top of `value`.
contract SenderFeeBZB is ERC20 {
    uint256 public feeBps;
    address public sink = address(0xFEE);
    constructor() ERC20("BlazarBits", "BZB") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (feeBps > 0 && from != address(0) && to != address(0) && from != sink) {
            super._update(from, sink, value * feeBps / 10_000);
        }
    }
}
