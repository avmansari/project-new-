// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test-only fee wallet that rejects ETH (simulates a misconfigured fee recipient).
contract RejectingWallet {
    receive() external payable {
        revert("no ETH");
    }
}
