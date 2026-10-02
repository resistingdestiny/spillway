// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {VaultHandler} from "./utils/VaultHandler.sol";

/// @dev Random sequences of deposits, losses, settles, premium funding, claims,
/// withdrawals and time jumps. The rules below must hold after every call.
/// forge-config: default.invariant.fail-on-revert = true
contract CoverVaultInvariantTest is StdInvariant, VaultFixture {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(usd, adapter, vault, sponsor, runner);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.withdraw.selector;
        selectors[2] = VaultHandler.claimPremium.selector;
        selectors[3] = VaultHandler.fundPremium.selector;
        selectors[4] = VaultHandler.reportBadDebt.selector;
        selectors[5] = VaultHandler.settle.selector;
        selectors[6] = VaultHandler.finalizeShortfall.selector;
        selectors[7] = VaultHandler.sweep.selector;
        selectors[8] = VaultHandler.warp.selector;
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

    /// @dev The premium reserve covers what every holder could claim right now.
    function invariant_premiumReserveCoversOwed() public view {
        uint256 owed;
        for (uint256 i; i < handler.actorCount(); ++i) {
            owed += vault.pendingPremium(handler.actors(i));
        }
        assertGe(vault.premiumReserve(), owed, "premium owed > reserve");
    }

    /// @dev No payout ever passed min(shortfall, remaining limit, principal), and the
    /// total never passes the limit.
    function invariant_payoutsBounded() public view {
        assertFalse(handler.payoutTooLarge(), "a payout broke its bound");
        assertLe(vault.paidOut(), vault.limit(), "paid past the limit");
        assertEq(vault.paidOut(), handler.ghostPaid(), "paidOut drifted");
        assertEq(adapter.layerPaid(), vault.paidOut(), "adapter and vault disagree");
    }

    /// @dev There is never idle principal beyond what the layer can still lose.
    function invariant_principalWithinRemainingLimit() public view {
        assertLe(vault.totalPrincipal(), vault.remainingLimit());
    }

    /// @dev Shares add up.
    function invariant_sharesAddUp() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += vault.sharesOf(handler.actors(i));
        }
        assertEq(sum, vault.totalShares());
    }

    /// @dev Every dollar of bad debt is paid by the fund, the layer, ADL, or is
    /// still pending.
    function invariant_waterfallAddsUp() public view {
        assertEq(
            adapter.fundPaid() + adapter.layerPaid() + adapter.adlLoss()
                + adapter.pendingShortfall(),
            adapter.badDebtTotal()
        );
    }
}
