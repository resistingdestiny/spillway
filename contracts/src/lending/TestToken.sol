// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Testnet stand-in for a collateral token such as wstETH. No value, no backing.
/// @dev Same faucet as MockUSD: anyone can mint up to `maxMint` per call.
contract TestToken is ERC20 {
    /// @notice Largest amount one `mint` call can create, in base units.
    uint256 public immutable maxMint;
    uint8 internal immutable _decimals;

    error MintCapExceeded(uint256 requested, uint256 cap);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 maxMint_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
        maxMint = maxMint_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Faucet. Mints `amount` to `to`, capped per call.
    function mint(address to, uint256 amount) external {
        if (amount > maxMint) revert MintCapExceeded(amount, maxMint);
        _mint(to, amount);
    }
}
