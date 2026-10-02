// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {CoverVault} from "../src/CoverVault.sol";
import {MockBackstopAdapter} from "../src/MockBackstopAdapter.sol";

/// @dev Premium streaming, time weighting, claims and the sweep.
contract CoverVaultPremiumTest is VaultFixture {
    /// @dev 3,000 tUSD over 30 days is 100 tUSD a day.
    uint256 internal constant PREMIUM = 3_000e6;
    /// @dev Rounding allowance in token units (millionths of a dollar).
    uint256 internal constant DUST = 2;

    function test_noLossTermPaysPrincipalPlusPremium() public {
        _deposit(alice, 100_000e6);
        _fundPremium(PREMIUM);

        _warpToEnd();
        (uint256 assets, uint256 premium) = _withdrawAll(alice);

        assertEq(assets, 100_000e6);
        assertApproxEqAbs(premium, PREMIUM, DUST);
        assertApproxEqAbs(usd.balanceOf(alice), 100_000e6 + PREMIUM, DUST);
        assertLe(vault.sweepUnearnedPremium(), DUST);
    }

    function test_premiumIsTimeWeighted() public {
        _fundPremium(PREMIUM);
        _deposit(alice, 100_000e6);

        // Bob joins a third of the way in with the same stake.
        vm.warp(START + 10 days);
        _deposit(bob, 100_000e6);

        // Alice: 1,000 alone, then half of 2,000. Bob: half of 2,000.
        _warpToEnd();
        assertApproxEqAbs(vault.pendingPremium(alice), 2_000e6, DUST);
        assertApproxEqAbs(vault.pendingPremium(bob), 1_000e6, DUST);

        (, uint256 pa) = _withdrawAll(alice);
        (, uint256 pb) = _withdrawAll(bob);
        assertApproxEqAbs(pa, 2_000e6, DUST);
        assertApproxEqAbs(pb, 1_000e6, DUST);
    }

    function test_claimPremiumMidTerm() public {
        _deposit(alice, 100_000e6);
        _fundPremium(PREMIUM);

        vm.warp(START + 15 days);
        uint256 expected = vault.pendingPremium(alice);
        assertApproxEqAbs(expected, 1_500e6, DUST);

        vm.prank(alice);
        uint256 claimed = vault.claimPremium();
        assertEq(claimed, expected);
        assertEq(usd.balanceOf(alice), claimed);
        assertEq(vault.pendingPremium(alice), 0);

        // Principal is untouched and still locked.
        assertEq(vault.principalOf(alice), 100_000e6);

        _warpToEnd();
        (, uint256 rest) = _withdrawAll(alice);
        assertApproxEqAbs(claimed + rest, PREMIUM, DUST);
    }

    function test_claimWithNothingOwedIsNoop() public {
        _deposit(alice, 100_000e6);
        vm.warp(START + 1 days);
        vm.recordLogs();
        vm.prank(alice);
        assertEq(vault.claimPremium(), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
    }

    function test_topUpRespreadsRemainingStream() public {
        _deposit(alice, 100_000e6);
        _fundPremium(PREMIUM);

        // Halfway, 1,500 has streamed. A 1,500 top-up joins the 1,500 still to come,
        // so the last 15 days pay 200 a day.
        vm.warp(START + 15 days);
        _fundPremium(1_500e6);

        vm.warp(START + 20 days);
        assertApproxEqAbs(vault.pendingPremium(alice), 2_500e6, DUST);

        _warpToEnd();
        assertApproxEqAbs(vault.pendingPremium(alice), 4_500e6, DUST);
        assertEq(vault.premiumFunded(), 4_500e6);
    }

    function test_premiumFundedBeforeStartWaitsForStart() public {
        MockBackstopAdapter a2 = new MockBackstopAdapter(usd, 1, address(this));
        CoverVault later =
            new CoverVault(usd, a2, sponsor, START + 10 days, START + 40 days, LIMIT, 0);

        _mint(alice, 100_000e6);
        vm.startPrank(alice);
        usd.approve(address(later), 100_000e6);
        later.deposit(100_000e6);
        vm.stopPrank();

        _mint(sponsor, PREMIUM);
        vm.startPrank(sponsor);
        usd.approve(address(later), PREMIUM);
        later.fundPremium(PREMIUM);
        vm.stopPrank();

        vm.warp(START + 10 days);
        assertEq(later.pendingPremium(alice), 0);
        vm.warp(START + 25 days);
        assertApproxEqAbs(later.pendingPremium(alice), PREMIUM / 2, DUST);
    }

    function test_onlySponsorFundsPremium() public {
        _mint(alice, 1_000e6);
        vm.startPrank(alice);
        usd.approve(address(vault), 1_000e6);
        vm.expectRevert(CoverVault.NotSponsor.selector);
        vault.fundPremium(1_000e6);
        vm.stopPrank();
    }

    function test_fundPremiumAfterEndReverts() public {
        _warpToEnd();
        _mint(sponsor, 1_000e6);
        vm.startPrank(sponsor);
        usd.approve(address(vault), 1_000e6);
        vm.expectRevert(CoverVault.TermOver.selector);
        vault.fundPremium(1_000e6);
        vm.stopPrank();
    }

    function test_sweepUnearnedPremium() public {
        _fundPremium(PREMIUM);

        // Nobody holds shares for the first 10 days, so 1,000 streams to no one.
        vm.warp(START + 10 days);
        _deposit(alice, 100_000e6);

        vm.expectRevert(abi.encodeWithSelector(CoverVault.Locked.selector, START + TERM));
        vault.sweepUnearnedPremium();

        _warpToEnd();
        uint256 swept = vault.sweepUnearnedPremium();
        assertApproxEqAbs(swept, 1_000e6, DUST);
        assertEq(usd.balanceOf(sponsor), swept);
        assertEq(vault.premiumSwept(), swept);

        // A second sweep finds nothing.
        assertEq(vault.sweepUnearnedPremium(), 0);

        (, uint256 premium) = _withdrawAll(alice);
        assertApproxEqAbs(premium, 2_000e6, DUST);
        // Everything funded went to alice or back to the sponsor, give or take dust.
        assertApproxEqAbs(swept + premium, PREMIUM, DUST);
        assertLe(usd.balanceOf(address(vault)), DUST);
    }

    function test_payoutNeverTouchesPremium() public {
        _deposit(alice, LIMIT);
        _fundPremium(PREMIUM);

        vm.warp(START + 10 days);
        _badDebt(FUND + 1_000_000e6);
        assertEq(vault.settle(), LIMIT);
        assertEq(vault.totalPrincipal(), 0);

        // What is left in the vault is the premium, in full.
        assertEq(usd.balanceOf(address(vault)), PREMIUM);
        _assertSolvent();

        // Premium keeps streaming to the holders after the loss.
        _warpToEnd();
        (uint256 assets, uint256 premium) = _withdrawAll(alice);
        assertEq(assets, 0);
        assertApproxEqAbs(premium, PREMIUM, DUST);
    }

    function test_premiumRateMatchesFunding() public {
        _fundPremium(PREMIUM);
        assertEq(vault.premiumRate(), PREMIUM * vault.PRECISION() / TERM);
        assertEq(vault.premiumReserve(), PREMIUM);
    }
}
