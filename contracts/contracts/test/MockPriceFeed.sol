// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test-only Chainlink-style ETH/USD feed (8 decimals).
contract MockPriceFeed {
    int256 public answer;
    uint256 public updatedAt;

    uint8 public decimals = 8;

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
