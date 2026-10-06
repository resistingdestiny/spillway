// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev Random sizes for supply, capital, limit, deductible, withdrawals and losses.
/// The payout must always be min(loss - deductible, limit, free capital), and the
/// vault must stay solvent.
contract MorphoCoverVaultFuzzTest is MorphoFixture {
    function testFuzz_payoutIsTheMinOfLossLimitAndCapital(
        uint256 holderSupply,
        uint256 otherSupply,
        uint256 capital,
        uint256 limit,
        uint256 deductible,
        uint256 withdrawn,
        uint256 debt,
        uint256 coverBps
    ) public {
        holderSupply = bound(holderSupply, 1_000e6, 10_000_000e6);
        otherSupply = bound(otherSupply, 0, 10_000_000e6);
        capital = bound(capital, 1_000e6, 10_000_000e6);
        limit = bound(limit, 1e6, capital);
        deductible = bound(deductible, 0, holderSupply);
        withdrawn = bound(withdrawn, 0, capital);
        debt = bound(debt, 1e6, holderSupply + otherSupply);
        coverBps = bound(coverBps, 1, 10_000);

        uint256 holderShares = _supply(holder, holderSupply);
        if (otherSupply > 0) _supply(otherSupplier, otherSupply);
        _deposit(alice, capital);
        uint256 covered = holderShares * coverBps / 10_000;
        if (covered == 0) covered = 1;
        uint256 policyId = _buy(holder, covered, limit, deductible);

        // Part of the capital leaves after notice, so free capital can fall below limit.
        if (withdrawn > 0) {
            vm.startPrank(alice);
            vault.requestWithdrawal(withdrawn);
            vm.warp(block.timestamp + LendingConfig.WITHDRAWAL_NOTICE);
            vault.withdraw();
            vm.stopPrank();
        }

        _badDebtOf(debt);
        uint256 loss = _lossSince(policyId, covered);
        uint256 due = loss > deductible ? Math.min(loss - deductible, limit) : 0;
        uint256 principal = vault.totalPrincipal();

        if (due == 0) {
            vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
            vault.claim(policyId);
        } else if (due < LendingConfig.DUST_THRESHOLD) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    MorphoCoverVault.BelowDust.selector, due, LendingConfig.DUST_THRESHOLD
                )
            );
            vault.claim(policyId);
        } else if (principal == 0) {
            vm.expectRevert(MorphoCoverVault.NoFreeCapital.selector);
            vault.claim(policyId);
        } else {
            uint256 paid = vault.claim(policyId);
            assertEq(paid, Math.min(due, principal), "payout != min(due, capital)");
            assertLe(paid, limit, "payout > limit");
            assertLe(paid, principal, "payout > free capital");
            assertLe(paid + deductible, loss, "payout + deductible > loss");
            assertEq(usd.balanceOf(holder), paid);
        }
        _assertSolvent();
    }

    function testFuzz_interestAloneNeverPays(uint256 borrowBps, uint256 elapsed) public {
        borrowBps = bound(borrowBps, 1, 9_000);
        elapsed = bound(elapsed, 1, LendingConfig.POLICY_TERM);
        uint256 holderShares = _supply(holder, 1_000_000e6);
        _deposit(alice, 1_000_000e6);
        uint256 borrowed = 1_000_000e6 * borrowBps / 10_000;
        _borrow(borrower, borrowed * 1e18 / 3000e6 + 1e18, borrowed);
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);

        vm.warp(block.timestamp + elapsed);
        assertEq(vault.claimable(policyId), 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
    }

    /// @dev A borrower goes under water and nobody liquidates. `claimShortfall` pays the
    /// unrealised due. Then the loss is realised and `claim` pays only the increase. In
    /// total the policy is paid the larger of the two dues, never their sum, and never
    /// more than its limit.
    function testFuzz_bothPathsPayTheMostEverDueOnce(
        uint256 holderSupply,
        uint256 otherSupply,
        uint256 ltvBps,
        uint256 dropBps,
        uint256 limit,
        uint256 deductible
    ) public {
        holderSupply = bound(holderSupply, 10_000e6, 5_000_000e6);
        otherSupply = bound(otherSupply, 0, 5_000_000e6);
        ltvBps = bound(ltvBps, 5_000, 8_500);
        dropBps = bound(dropBps, 100, 9_000);
        limit = bound(limit, 1e6, 10_000_000e6);
        deductible = bound(deductible, 0, holderSupply / 10);

        uint256 holderShares = _supply(holder, holderSupply);
        if (otherSupply > 0) _supply(otherSupplier, otherSupply);
        _deposit(alice, 10_000_000e6);
        // One borrower takes 90% of the market at `ltvBps` of its collateral.
        uint256 debt = (holderSupply + otherSupply) * 9 / 10;
        _borrow(borrower, debt * 10_000 / ltvBps * 1e36 / PRICE + 1, debt);
        uint256 policyId = _buy(holder, holderShares, limit, deductible);
        _drop(dropBps);

        address[] memory list = new address[](1);
        list[0] = borrower;
        uint256 unrealisedDue = vault.claimableShortfall(policyId, list);
        if (unrealisedDue >= LendingConfig.DUST_THRESHOLD) {
            assertEq(vault.claimShortfall(policyId, list), unrealisedDue);
        } else {
            vm.expectRevert();
            vault.claimShortfall(policyId, list);
        }
        uint256 first = vault.policy(policyId).paid;
        assertLe(first, limit, "unrealised payout > limit");

        _liquidate(borrower);
        uint256 loss = _lossSince(policyId, holderShares);
        uint256 realisedDue = loss > deductible ? Math.min(loss - deductible, limit) : 0;
        // Liquidation books at least the shortfall at the oracle, to a unit of rounding.
        assertGe(realisedDue + 1, unrealisedDue, "realised < unrealised");
        if (realisedDue > first && realisedDue - first >= LendingConfig.DUST_THRESHOLD) {
            assertEq(vault.claim(policyId), realisedDue - first);
        }

        uint256 total = vault.policy(policyId).paid;
        uint256 most = Math.max(unrealisedDue, realisedDue);
        assertLe(total, most, "paid > most ever due");
        assertLe(total, limit, "paid > limit");
        assertGe(total + LendingConfig.DUST_THRESHOLD, most, "a payable due went unpaid");
        assertEq(usd.balanceOf(holder), total);
        _assertSolvent();
    }
}
