// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";

/// @title MockOracle
/// @notice Testnet price feed for one Morpho Blue market. Its owner sets the price, so
/// a replay can break the collateral on demand.
/// @dev Morpho reads `price()` as the value of one base unit of collateral in base
/// units of the loan token, scaled by 1e36. With 18-decimal collateral worth 4,000
/// six-decimal dollars that is `4000 * 1e6 * 1e36 / 1e18 = 4000e24`.
contract MockOracle is IOracle, Ownable {
    /// @inheritdoc IOracle
    uint256 public price;

    event PriceSet(uint256 oldPrice, uint256 newPrice);

    error ZeroPrice();

    constructor(uint256 price_, address owner_) Ownable(owner_) {
        if (price_ == 0) revert ZeroPrice();
        price = price_;
        emit PriceSet(0, price_);
    }

    /// @notice Sets the price Morpho reads. Zero is refused: Morpho would treat every
    /// borrower as underwater and seize nothing for their debt.
    function setPrice(uint256 price_) external onlyOwner {
        if (price_ == 0) revert ZeroPrice();
        emit PriceSet(price, price_);
        price = price_;
    }
}
