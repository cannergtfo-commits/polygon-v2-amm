// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";

/// @notice Puts the canonical Permit2 runtime (fetched from Polygon PoS, see test/fixtures) at its canonical
///         address and signs SignatureTransfer permits exactly as wallets do (EIP-712).
abstract contract Permit2Helper is Test {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    function _etchPermit2() internal {
        if (PERMIT2.code.length != 0) return;
        string memory hexCode = vm.readFile("test/fixtures/permit2.polygon.runtime.hex");
        vm.etch(PERMIT2, vm.parseBytes(vm.trim(hexCode)));
    }

    function _permit(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(uint256 pk, ISignatureTransfer.PermitTransferFrom memory p, address spender)
        internal
        view
        returns (bytes memory)
    {
        bytes32 tp = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.permitted.token, p.permitted.amount));
        bytes32 structHash = keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, tp, spender, p.nonce, p.deadline));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, digest);
        return abi.encodePacked(r, s_, v);
    }
}
