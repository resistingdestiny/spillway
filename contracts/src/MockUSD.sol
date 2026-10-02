// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSD
/// @notice Testnet dollar for the Spillway demo. It has no value and no backing.
/// @dev Six decimals, like USDC. Anyone can mint up to MAX_MINT per call, so judges
/// can fund their own wallets without asking anyone.
contract MockUSD is ERC20 {
    /// @notice Largest amount one `mint` call can create: 100,000 tUSD.
    uint256 public constant MAX_MINT = 100_000e6;

    error MintCapExceeded(uint256 requested, uint256 cap);

    constructor() ERC20("Test Dollar", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Faucet. Mints `amount` to `to`, capped per call.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintCapExceeded(amount, MAX_MINT);
        _mint(to, amount);
    }
}
