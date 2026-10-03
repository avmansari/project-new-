// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Fixed supply: 100,000,000,000 tokens (18 decimals). Until `enableTrading()` is
/// called, only whitelisted addresses (owner, distributor) can send tokens, so claimed
/// tokens sit in wallets but cannot be traded. Enabling is one-way and public.
contract ClaimToken is ERC20, Ownable {
    bool public tradingEnabled;
    mapping(address => bool) public transferAllowed;

    event TradingEnabled();

    constructor(string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_) Ownable(owner_)
    {
        transferAllowed[owner_] = true;
        _mint(owner_, 100_000_000_000 * 1e18);
    }

    function setTransferAllowed(address a, bool ok) external onlyOwner { transferAllowed[a] = ok; }

    function enableTrading() external onlyOwner {
        tradingEnabled = true; // cannot be turned off again
        emit TradingEnabled();
    }

    function _update(address from, address to, uint256 value) internal override {
        require(tradingEnabled || from == address(0) || transferAllowed[from], "Trading not enabled");
        super._update(from, to, value);
    }
}
