// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BlazarMultiRewardStaking as M} from "../../src/BlazarMultiRewardStaking.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {Permit2Helper} from "../agent/Permit2Helper.sol";

interface IChildMetaTx {
    function executeMetaTransaction(
        address userAddress,
        bytes calldata functionSignature,
        bytes32 sigR,
        bytes32 sigS,
        uint8 sigV
    ) external payable returns (bytes memory);
    function getNonce(address user) external view returns (uint256);
    function getDomainSeperator() external view returns (bytes32);
}

/// @notice Polygon PoS fork (local only, nothing broadcast): the real bridged BZB works with the canonical
///         Permit2 for `stakeWithPermit2`, and the Permit2 approval itself can be made gasless with BZB's
///         NativeMetaTransaction `executeMetaTransaction`, relayed by a third party.
contract MultiRewardPermit2ForkTest is Permit2Helper {
    address constant BZB = 0x462D8d82C2B2D2DDabf7f8a93928De09d47A5807;
    bytes32 constant META_TRANSACTION_TYPEHASH =
        keccak256(bytes("MetaTransaction(uint256 nonce,address from,bytes functionSignature)"));

    M internal s;
    address internal user;
    uint256 internal userPk;
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.createSelectFork("polygon");
        (user, userPk) = makeAddrAndKey("forkUser");
        s = new M(makeAddr("owner"), BZB, 1e15);
        deal(BZB, user, 100 ether);
    }

    function testFork_canonicalPermit2IsLive() public view {
        assertGt(PERMIT2.code.length, 9000);
        assertEq(address(s.PERMIT2()), PERMIT2);
    }

    function testFork_permit2StakeWithRealBzb() public {
        vm.prank(user);
        IERC20(BZB).approve(PERMIT2, type(uint256).max);
        ISignatureTransfer.PermitTransferFrom memory p = _permit(BZB, 40 ether, 1, block.timestamp + 1 hours);
        bytes memory sig = _sign(userPk, p, address(s));
        vm.prank(relayer);
        s.stakeWithPermit2(user, p, sig);
        assertEq(s.balanceOf(user), 40 ether);
        assertEq(IERC20(BZB).balanceOf(user), 60 ether);
        assertEq(IERC20(BZB).balanceOf(address(s)), 40 ether);
        vm.prank(user);
        s.withdraw(40 ether);
        assertEq(IERC20(BZB).balanceOf(user), 100 ether);
    }

    /// Fully gasless for the user: a relayer submits the user's signed `approve(PERMIT2, max)` meta-tx,
    /// then the user's Permit2 signature. The user sends no transaction at all.
    function testFork_gaslessApproveViaExecuteMetaTransaction() public {
        bytes memory fn = abi.encodeCall(IERC20.approve, (PERMIT2, type(uint256).max));
        uint256 nonce = IChildMetaTx(BZB).getNonce(user);
        bytes32 structHash = keccak256(abi.encode(META_TRANSACTION_TYPEHASH, nonce, user, keccak256(fn)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IChildMetaTx(BZB).getDomainSeperator(), structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(userPk, digest);
        vm.prank(relayer);
        IChildMetaTx(BZB).executeMetaTransaction(user, fn, r, ss, v);
        assertEq(IERC20(BZB).allowance(user, PERMIT2), type(uint256).max);
        assertEq(IChildMetaTx(BZB).getNonce(user), nonce + 1);

        ISignatureTransfer.PermitTransferFrom memory p = _permit(BZB, 25 ether, 9, block.timestamp + 1 hours);
        bytes memory sig = _sign(userPk, p, address(s));
        vm.prank(relayer);
        s.stakeWithPermit2(user, p, sig);
        assertEq(s.balanceOf(user), 25 ether);
    }
}
