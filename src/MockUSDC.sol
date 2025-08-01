// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title Mock USDC token with 6 decimals for testing.
contract MockUSDC is ERC20 {
    uint8 private constant _DECIMALS = 6;

    constructor(uint256 initialSupply) ERC20("USD Coin", "USDC") {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }
}
