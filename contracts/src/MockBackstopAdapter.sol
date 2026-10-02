// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IBackstopAdapter} from "./interfaces/IBackstopAdapter.sol";

/// @title MockBackstopAdapter
/// @notice Testnet stand-in for one Perpl perpetual's insurance fund.
/// @dev A scenario runner posts bad debt. The adapter pays it from the insurance fund
/// first. What the fund cannot pay becomes the pending shortfall, which the cover
/// vault pays down through `receiveCover`. Whatever is still pending when the runner
/// calls `finalizeShortfall` is booked as auto-deleveraging (ADL) loss borne by
/// winning traders.
///
/// Tokens spent on bad debt stay in this contract and are only booked as paid. On a
/// real exchange they would settle the bankrupt positions' counterparties.
///
/// On real Perpl the top-up path would be the protocol's
/// `xferProtocolToPerp(perpId, amount, true)`, which moves protocol balance into a
/// perpetual's insurance fund (event `TransferProtocolToPerp`). Whether a third party
/// such as a cover vault can do the same is an open question for the Perpl team, so
/// the demo uses this mock.
contract MockBackstopAdapter is IBackstopAdapter, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Collateral token (tUSD on testnet).
    IERC20 public immutable token;
    /// @notice The perpetual this adapter mirrors, for display only.
    uint256 public immutable perpId;

    /// @notice Address allowed to post bad debt and finalize shortfalls.
    address public runner;
    /// @notice The cover vault. Set once by the owner.
    address public vault;

    /// @inheritdoc IBackstopAdapter
    uint256 public insuranceFund;
    /// @inheritdoc IBackstopAdapter
    uint256 public pendingShortfall;

    /// @notice All bad debt ever reported.
    uint256 public badDebtTotal;
    /// @notice Bad debt paid by the insurance fund.
    uint256 public fundPaid;
    /// @notice Bad debt paid by the Spillway layer.
    uint256 public layerPaid;
    /// @notice Bad debt booked as auto-deleveraging loss to winning traders.
    uint256 public adlLoss;

    event RunnerSet(address indexed runner);
    event VaultSet(address indexed vault);
    event InsuranceFunded(address indexed from, uint256 amount, uint256 insuranceFund);
    event BadDebtReported(uint256 amount, uint256 badDebtTotal);
    event InsuranceDraw(uint256 amount, uint256 insuranceFund);
    event Shortfall(uint256 amount, uint256 pendingShortfall);
    event CoverReceived(address indexed vault, uint256 amount, uint256 pendingShortfall);
    event AutoDeleverage(uint256 amount, uint256 adlLoss);

    error ZeroAddress();
    error ZeroAmount();
    error NotRunner();
    error NotVault();
    error VaultAlreadySet();
    error CoverExceedsShortfall(uint256 amount, uint256 pendingShortfall);
    error CoverNotTransferred();

    modifier onlyRunner() {
        if (msg.sender != runner) revert NotRunner();
        _;
    }

    constructor(IERC20 token_, uint256 perpId_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        perpId = perpId_;
    }

    /// @inheritdoc IBackstopAdapter
    function asset() external view returns (address) {
        return address(token);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Sets the scenario runner. Can be changed.
    function setRunner(address runner_) external onlyOwner {
        if (runner_ == address(0)) revert ZeroAddress();
        runner = runner_;
        emit RunnerSet(runner_);
    }

    /// @notice Wires the cover vault. Can only be done once.
    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vault_;
        emit VaultSet(vault_);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Adds `amount` to the insurance fund. Pulls tokens from the caller.
    function fundInsurance(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        insuranceFund += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit InsuranceFunded(msg.sender, amount, insuranceFund);
    }

    // ---------------------------------------------------------------- runner

    /// @notice Posts `amount` of bad debt. The fund pays what it can. The rest
    /// becomes pending shortfall for the cover vault.
    function reportBadDebt(uint256 amount) external onlyRunner {
        if (amount == 0) revert ZeroAmount();
        badDebtTotal += amount;
        emit BadDebtReported(amount, badDebtTotal);

        uint256 draw = amount < insuranceFund ? amount : insuranceFund;
        if (draw > 0) {
            insuranceFund -= draw;
            fundPaid += draw;
            emit InsuranceDraw(draw, insuranceFund);
        }

        uint256 rest = amount - draw;
        if (rest > 0) {
            pendingShortfall += rest;
            emit Shortfall(rest, pendingShortfall);
        }
    }

    /// @notice Books whatever shortfall is still pending as ADL loss to winning
    /// traders and clears it. Does nothing when there is no shortfall.
    function finalizeShortfall() external onlyRunner {
        uint256 amount = pendingShortfall;
        if (amount == 0) return;
        pendingShortfall = 0;
        adlLoss += amount;
        emit AutoDeleverage(amount, adlLoss);
    }

    // ---------------------------------------------------------------- vault

    /// @inheritdoc IBackstopAdapter
    function receiveCover(uint256 amount) external {
        if (msg.sender != vault) revert NotVault();
        if (amount == 0) revert ZeroAmount();
        if (amount > pendingShortfall) revert CoverExceedsShortfall(amount, pendingShortfall);
        pendingShortfall -= amount;
        layerPaid += amount;
        // Every token the adapter has booked must be in its balance.
        if (token.balanceOf(address(this)) < insuranceFund + fundPaid + layerPaid) {
            revert CoverNotTransferred();
        }
        emit CoverReceived(msg.sender, amount, pendingShortfall);
    }
}
