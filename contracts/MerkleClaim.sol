// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// One claim per index. Fund this contract with the claim pool, and add it to
/// ClaimToken.setTransferAllowed so it can pay out while trading is disabled.
contract MerkleClaim {
    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    mapping(uint256 => bool) public claimed;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);

    constructor(IERC20 token_, bytes32 root_) { token = token_; merkleRoot = root_; }

    function claim(uint256 index, uint256 amount, bytes32[] calldata proof) external {
        require(!claimed[index], "Already claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, msg.sender, amount))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid proof");
        claimed[index] = true;
        require(token.transfer(msg.sender, amount), "Transfer failed");
        emit Claimed(index, msg.sender, amount);
    }
}
