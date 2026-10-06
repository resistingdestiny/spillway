// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoVaultHandler} from "../utils/MorphoVaultHandler.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";

/// @dev Random sequences of deposits, notices, withdrawals, Morpho supply, policy
/// sales, real bad debt, claims, releases, premium claims, sweeps and time jumps. The
/// rules below must hold after every call.
/// forge-config: default.invariant.fail-on-revert = true
contract MorphoCoverVaultInvariantTest is StdInvariant, MorphoFixture {
    MorphoVaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new MorphoVaultHandler(morpho, params, usd, wsteth, oracle, vault);
        oracle.transferOwnership(address(handler));

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = MorphoVaultHandler.deposit.selector;
        selectors[1] = MorphoVaultHandler.requestWithdrawal.selector;
        selectors[2] = MorphoVaultHandler.withdraw.selector;
        selectors[3] = MorphoVaultHandler.claimPremium.selector;
        selectors[4] = MorphoVaultHandler.sweep.selector;
        selectors[5] = MorphoVaultHandler.supply.selector;
        selectors[6] = MorphoVaultHandler.badDebt.selector;
        selectors[7] = MorphoVaultHandler.buyPolicy.selector;
        selectors[8] = MorphoVaultHandler.claim.selector;
        selectors[9] = MorphoVaultHandler.release.selector;
        selectors[10] = MorphoVaultHandler.warp.selector;
        selectors[11] = MorphoVaultHandler.supply.selector; // twice: keep the market deep
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The vault always holds its principal plus every premium token it owes.
    function invariant_balanceCoversPrincipalAndPremium() public view {
        assertGe(
            usd.balanceOf(address(vault)),
            vault.totalPrincipal() + vault.premiumReserve(),
            "balance < principal + premium reserve"
        );
    }

    /// @dev The premium reserve covers what every underwriter could claim right now.
    function invariant_premiumReserveCoversOwed() public view {
        uint256 owed;
        for (uint256 i; i < handler.underwriterCount(); ++i) {
            owed += vault.pendingPremium(handler.underwriters(i));
        }
        assertGe(vault.premiumReserve(), owed, "premium owed > reserve");
    }

    /// @dev No policy is ever paid past its limit, the vault's total paid is the sum over
    /// policies, and the live limit is what is left of every unreleased policy.
    function invariant_payoutsWithinLimits() public view {
        uint256 paid;
        uint256 live;
        for (uint256 i; i < handler.policyCount(); ++i) {
            MorphoCoverVault.Policy memory p = vault.policy(handler.policyIds(i));
            assertLe(p.paid, p.limit, "policy paid past its limit");
            paid += p.paid;
            if (!p.released) live += p.limit - p.paid;
        }
        assertEq(paid, vault.paidOut(), "paidOut != sum of policies");
        assertEq(live, vault.activeLimit(), "activeLimit != unreleased limits");
    }

    /// @dev No claim paid more than min(what was due, free capital).
    function invariant_noPayoutPastDueOrCapital() public view {
        assertFalse(handler.payoutTooLarge(), "payout > min(due, capital)");
    }

    /// @dev Principal is conserved: every deposited unit is still in, paid on a claim, or
    /// withdrawn.
    function invariant_principalConserved() public view {
        assertEq(
            handler.ghostDeposited(),
            vault.totalPrincipal() + vault.paidOut() + handler.ghostWithdrawn(),
            "principal leaked"
        );
    }

    /// @dev Shares under notice never exceed the shares outstanding.
    function invariant_noticeWithinShares() public view {
        assertLe(vault.sharesUnderNotice(), vault.totalShares());
    }

    /// @dev The handler's claim path does pay: one scripted sequence through it.
    function test_handlerSequencePaysAClaim() public {
        handler.deposit(0, 1_000_000e6);
        handler.supply(0, 1_000_000e6);
        handler.supply(1, 1_000_000e6);
        handler.buyPolicy(0, 10_000, 500_000e6, 0);
        handler.badDebt(400_000e6);
        handler.claim(0);
        assertEq(handler.claims(), 1);
        assertGt(vault.paidOut(), 0);
        invariant_principalConserved();
        invariant_payoutsWithinLimits();
    }
}
