// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IMorpho, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {TestToken} from "../../src/lending/TestToken.sol";

/// @title ReplayBorrower
/// @notice One borrower in a replayed market. It opens its whole position in its
/// constructor: mints test collateral from the faucet, posts it and borrows.
/// @dev A contract per borrower means one broadcaster can replay any number of
/// positions without holding a key for each. The borrowed tokens go to `receiver`,
/// which pays for the liquidations later. Nobody can touch the position afterwards
/// except a liquidator.
contract ReplayBorrower {
    constructor(
        IMorpho morpho,
        MarketParams memory params,
        uint256 collateral,
        uint256 borrowAssets,
        address receiver
    ) {
        TestToken token = TestToken(params.collateralToken);
        uint256 cap = token.maxMint();
        for (uint256 left = collateral; left > 0;) {
            uint256 chunk = left > cap ? cap : left;
            token.mint(address(this), chunk);
            left -= chunk;
        }
        token.approve(address(morpho), collateral);
        morpho.supplyCollateral(params, collateral, address(this), "");
        if (borrowAssets > 0) morpho.borrow(params, borrowAssets, 0, address(this), receiver);
    }
}
