// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {CoverVault} from "../src/CoverVault.sol";

/// @dev The loss waterfall: fund first, then the layer, then ADL.
contract CoverVaultSettleTest is VaultFixture {
    function test_fullLoss() public {
        _deposit(alice, LIMIT);
        // 400k of bad debt beyond the fund: the layer pays its 250k, ADL takes 150k.
        _badDebt(FUND + 400_000e6);
        assertEq(adapter.insuranceFund(), 0);
        assertEq(adapter.pendingShortfall(), 400_000e6);

        vm.expectEmit(address(vault));
        emit CoverVault.LayerPayout(400_000e6, LIMIT, 0);
        uint256 paid = vault.settle();

        assertEq(paid, LIMIT);
        assertEq(vault.paidOut(), LIMIT);
        assertEq(vault.remainingLimit(), 0);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(adapter.layerPaid(), LIMIT);
        assertEq(adapter.pendingShortfall(), 150_000e6);
        assertEq(usd.balanceOf(address(vault)), 0);

        vm.prank(runner);
        adapter.finalizeShortfall();
        assertEq(adapter.adlLoss(), 150_000e6);
        assertEq(adapter.fundPaid(), FUND);
        assertEq(
            adapter.fundPaid() + adapter.layerPaid() + adapter.adlLoss(), adapter.badDebtTotal()
        );

        // Depositors get nothing back but the shares still exist.
        _warpToEnd();
        (uint256 assets,) = _withdrawAll(alice);
        assertEq(assets, 0);
    }

    function test_partialLoss() public {
        _deposit(alice, LIMIT);
        _badDebt(FUND + 60_000e6);

        uint256 paid = vault.settle();

        assertEq(paid, 60_000e6);
        assertEq(adapter.pendingShortfall(), 0);
        assertEq(vault.remainingLimit(), 190_000e6);
        assertEq(vault.totalPrincipal(), 190_000e6);
        assertEq(vault.principalOf(alice), 190_000e6);

        vm.prank(runner);
        adapter.finalizeShortfall();
        assertEq(adapter.adlLoss(), 0);

        _warpToEnd();
        (uint256 assets,) = _withdrawAll(alice);
        assertEq(assets, 190_000e6);
    }

    function test_lossInsideFundDoesNotTouchLayer() public {
        _deposit(alice, LIMIT);
        _badDebt(FUND / 2);
        assertEq(vault.settle(), 0);
        assertEq(vault.totalPrincipal(), LIMIT);
        assertEq(adapter.insuranceFund(), FUND / 2);
    }

    function test_settleWithNoShortfallIsNoop() public {
        _deposit(alice, LIMIT);
        vm.recordLogs();
        uint256 paid = vault.settle();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(paid, 0);
        assertEq(logs.length, 0);
        assertEq(vault.paidOut(), 0);
        assertEq(vault.totalPrincipal(), LIMIT);
    }

    function test_settleWithEmptyVaultIsNoop() public {
        _badDebt(FUND + 10_000e6);
        assertEq(vault.settle(), 0);
        assertEq(adapter.pendingShortfall(), 10_000e6);
    }

    function test_twoPayoutsHitTheLimit() public {
        _deposit(alice, LIMIT);

        _badDebt(FUND + 100_000e6);
        assertEq(vault.settle(), 100_000e6);
        assertEq(vault.remainingLimit(), 150_000e6);

        vm.warp(START + 5 days);
        _badDebt(200_000e6);
        vm.expectEmit(address(vault));
        emit CoverVault.LayerPayout(200_000e6, 150_000e6, 0);
        assertEq(vault.settle(), 150_000e6);

        assertEq(vault.paidOut(), LIMIT);
        assertEq(vault.remainingLimit(), 0);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(adapter.pendingShortfall(), 50_000e6);

        // The layer is spent. Settling again pays nothing.
        assertEq(vault.settle(), 0);
        assertEq(adapter.pendingShortfall(), 50_000e6);
    }

    function test_payoutCappedByPrincipal() public {
        // The vault is only 40% full, so principal binds before the limit.
        _deposit(alice, 100_000e6);
        _badDebt(FUND + 180_000e6);

        assertEq(vault.settle(), 100_000e6);
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.paidOut(), 100_000e6);
        assertEq(vault.remainingLimit(), 150_000e6);
        assertEq(adapter.pendingShortfall(), 80_000e6);
    }

    function test_payoutSharedProRata() public {
        _deposit(alice, 150_000e6);
        _deposit(bob, 50_000e6);
        _badDebt(FUND + 100_000e6);
        vault.settle();

        assertEq(vault.principalOf(alice), 75_000e6);
        assertEq(vault.principalOf(bob), 25_000e6);
    }

    function test_settleOutsideTermIsNoop() public {
        _deposit(alice, LIMIT);
        _badDebt(FUND + 10_000e6);
        _warpToEnd();

        assertFalse(vault.isCoverActive());
        assertEq(vault.settle(), 0);
        assertEq(vault.totalPrincipal(), LIMIT);
        assertEq(adapter.pendingShortfall(), 10_000e6);
    }

    function test_anyoneCanSettle() public {
        _deposit(alice, LIMIT);
        _badDebt(FUND + 10_000e6);
        vm.prank(makeAddr("keeper"));
        assertEq(vault.settle(), 10_000e6);
    }
}
