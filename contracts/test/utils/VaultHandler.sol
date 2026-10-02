// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {MockBackstopAdapter} from "../../src/MockBackstopAdapter.sol";
import {CoverVault} from "../../src/CoverVault.sol";

/// @dev Drives the vault and adapter with random but valid actions for the invariant
/// suite. Every call is shaped so it should not revert, so a revert is a bug.
contract VaultHandler is Test {
    MockUSD internal immutable usd;
    MockBackstopAdapter internal immutable adapter;
    CoverVault internal immutable vault;
    address internal immutable sponsor;
    address internal immutable runner;

    address[] public actors;

    /// @notice Sum of every payout `settle` returned.
    uint256 public ghostPaid;
    /// @notice Set if any single payout broke min(shortfall, remaining limit, principal).
    bool public payoutTooLarge;
    /// @notice Count of payouts that actually moved money.
    uint256 public payouts;
    /// @notice Count of withdrawals after the term.
    uint256 public withdrawals;
    /// @notice Set if a deposit ever went through while the adapter had a shortfall.
    bool public depositedWhilePending;

    constructor(
        MockUSD usd_,
        MockBackstopAdapter adapter_,
        CoverVault vault_,
        address sponsor_,
        address runner_
    ) {
        usd = usd_;
        adapter = adapter_;
        vault = vault_;
        sponsor = sponsor_;
        runner = runner_;
        actors.push(makeAddr("lp-1"));
        actors.push(makeAddr("lp-2"));
        actors.push(makeAddr("lp-3"));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _mint(address to, uint256 amount) internal {
        uint256 cap = usd.MAX_MINT();
        while (amount > 0) {
            uint256 chunk = amount > cap ? cap : amount;
            usd.mint(to, chunk);
            amount -= chunk;
        }
    }

    // ---------------------------------------------------------------- actions

    function deposit(uint256 actorSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        if (adapter.pendingShortfall() > 0) {
            // The layer owes money, so any deposit must be refused. Try one to prove it.
            _mint(who, 1e6);
            vm.startPrank(who);
            usd.approve(address(vault), 1e6);
            try vault.deposit(1e6) {
                depositedWhilePending = true;
            } catch {}
            vm.stopPrank();
            return;
        }
        uint256 room = vault.availableCapacity();
        if (room == 0) return;
        amount = bound(amount, 1, room);
        _mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 actorSeed, uint256 shares) external {
        if (block.timestamp < vault.termEnd()) return;
        address who = _actor(actorSeed);
        uint256 held = vault.sharesOf(who);
        if (held == 0) return;
        shares = bound(shares, 1, held);
        vm.prank(who);
        vault.withdraw(shares);
        ++withdrawals;
    }

    function claimPremium(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        vault.claimPremium();
    }

    function fundPremium(uint256 amount) external {
        if (block.timestamp >= vault.termEnd()) return;
        amount = bound(amount, 1, 50_000e6);
        _mint(sponsor, amount);
        vm.startPrank(sponsor);
        usd.approve(address(vault), amount);
        vault.fundPremium(amount);
        vm.stopPrank();
    }

    function reportBadDebt(uint256 amount) external {
        amount = bound(amount, 1, 300_000e6);
        vm.prank(runner);
        adapter.reportBadDebt(amount);
    }

    function settle() external {
        uint256 shortfall = adapter.pendingShortfall();
        uint256 remaining = vault.remainingLimit();
        uint256 principal = vault.totalPrincipal();

        uint256 paid = vault.settle();

        if (paid > shortfall || paid > remaining || paid > principal) payoutTooLarge = true;
        if (paid > 0) ++payouts;
        ghostPaid += paid;
    }

    function finalizeShortfall() external {
        vm.prank(runner);
        adapter.finalizeShortfall();
    }

    function sweep() external {
        if (block.timestamp < vault.termEnd()) return;
        vault.sweepUnearnedPremium();
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 0, 10 days);
        vm.warp(block.timestamp + dt);
    }
}
