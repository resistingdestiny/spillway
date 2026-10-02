// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBackstopAdapter
/// @notice What a Spillway cover vault needs from the market it protects.
/// @dev One adapter stands for one perpetual's insurance fund. The vault reads the
/// shortfall (bad debt the fund could not pay), sends tokens to the adapter, then
/// calls `receiveCover` so the adapter books them against the shortfall.
interface IBackstopAdapter {
    /// @notice The collateral token the market settles in.
    function asset() external view returns (address);

    /// @notice Current insurance fund balance.
    function insuranceFund() external view returns (uint256);

    /// @notice Bad debt left over after the insurance fund ran dry and not yet covered.
    function pendingShortfall() external view returns (uint256);

    /// @notice Books `amount` of cover against the pending shortfall.
    /// @dev The caller must have transferred `amount` tokens to the adapter first.
    function receiveCover(uint256 amount) external;
}
