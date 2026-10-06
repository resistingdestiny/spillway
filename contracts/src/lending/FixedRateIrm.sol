// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IIrm} from "morpho-blue/src/interfaces/IIrm.sol";
import {MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";

/// @title FixedRateIrm
/// @notice The interest rate model for our own Morpho Blue deployment on testnet: one
/// borrow rate per second for every market, fixed at deploy.
/// @dev Mainnet markets use Morpho's AdaptiveCurveIrm, which moves the rate with
/// utilisation. A replay runs for minutes, so the rate barely matters. A fixed rate
/// keeps the share price's interest drift easy to predict in tests.
contract FixedRateIrm is IIrm {
    /// @notice Borrow rate per second, scaled by 1e18.
    uint256 public immutable ratePerSecond;

    constructor(uint256 ratePerSecond_) {
        ratePerSecond = ratePerSecond_;
    }

    /// @inheritdoc IIrm
    function borrowRate(MarketParams memory, Market memory) external view returns (uint256) {
        return ratePerSecond;
    }

    /// @inheritdoc IIrm
    function borrowRateView(MarketParams memory, Market memory) external view returns (uint256) {
        return ratePerSecond;
    }
}
