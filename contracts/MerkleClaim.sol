// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// One claim per index. Each claim must pay `claimFee` (in the chain's native coin).
/// Fund this contract with the claim pool and whitelist it on ClaimToken
/// (setTransferAllowed) so it can pay out while trading is still locked.
contract MerkleClaim is Ownable {
    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint256 public claimFee;      // wei, publicly readable, shown on the claim page
    bool public claimOpen;
    mapping(uint256 => bool) public claimed;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount, uint256 feePaid);
    event ClaimFeeUpdated(uint256 newFee);
    event ClaimOpenUpdated(bool open);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event TokensRecovered(address indexed to, uint256 amount);

    constructor(IERC20 token_, bytes32 root_, uint256 fee_, address owner_) Ownable(owner_) {
        token = token_;
        merkleRoot = root_;
        claimFee = fee_;
        emit ClaimFeeUpdated(fee_);
    }

    /// Anyone can submit; tokens always go to `account` (the address in the proof).
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external payable {
        require(claimOpen, "Claim not open");
        require(msg.value == claimFee, "Wrong fee");
        require(!claimed[index], "Already claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid proof");
        claimed[index] = true;
        require(token.transfer(account, amount), "Transfer failed");
        emit Claimed(index, account, amount, msg.value);
    }

    function setClaimOpen(bool open_) external onlyOwner { claimOpen = open_; emit ClaimOpenUpdated(open_); }

    function setClaimFee(uint256 fee_) external onlyOwner { claimFee = fee_; emit ClaimFeeUpdated(fee_); }

    function withdrawFees(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "Withdraw failed");
        emit FeesWithdrawn(to, bal);
    }

    /// Pull back unclaimed tokens (e.g. after the claim period ends).
    function recoverTokens(address to, uint256 amount) external onlyOwner {
        require(token.transfer(to, amount), "Transfer failed");
        emit TokensRecovered(to, amount);
    }
}
