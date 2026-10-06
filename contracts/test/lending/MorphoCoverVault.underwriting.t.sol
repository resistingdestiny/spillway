// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev The underwriters' side: shares, the withdrawal notice and the premium stream.
contract MorphoCoverVaultUnderwritingTest is MorphoFixture {
    uint256 internal constant NOTICE = LendingConfig.WITHDRAWAL_NOTICE;
    uint256 internal constant WINDOW = LendingConfig.WITHDRAWAL_WINDOW;
    uint256 internal constant TERM = LendingConfig.POLICY_TERM;

    uint256 internal holderShares;

    function setUp() public override {
        super.setUp();
        holderShares = _supply(holder, 1_000_000e6);
        _supply(otherSupplier, 1_000_000e6);
    }

    // ------------------------------------------------------------- terms

    function test_noticeMustBeLongerThanTheClaimWindow() public {
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.NoticeTooShort.selector, 1 days, 1 days)
        );
        new MorphoCoverVault(usd, morpho, owner, 30 days, 0, 1 days, 1 days, 1 days, 0);
        vm.expectRevert(MorphoCoverVault.ZeroAddress.selector);
        new MorphoCoverVault(usd, IMorpho(address(0)), owner, 30 days, 0, 1 days, 2 days, 1 days, 0);
        assertGt(vault.withdrawalNotice(), vault.claimWindow());
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.WaitingPeriodTooLong.selector, 30 days, 30 days)
        );
        new MorphoCoverVault(usd, morpho, owner, 30 days, 30 days, 1 days, 2 days, 1 days, 0);
    }

    // ------------------------------------------------------------- deposits

    function test_depositMintsAtPrincipalPerShare() public {
        assertEq(_deposit(alice, 1_000_000e6), 1_000_000e6);
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        _badDebtOf(200_000e6);
        uint256 paid = vault.claim(policyId);

        // Bob joins after the loss at the lower principal per share.
        uint256 bobShares = _deposit(bob, 100_000e6);
        assertEq(bobShares, 100_000e6 * 1_000_000e6 / (1_000_000e6 - paid));
        assertApproxEqAbs(vault.principalOf(bob), 100_000e6, 1);
        assertEq(vault.principalOf(alice), 1_000_000e6 - paid);
    }

    function test_depositClosedOnceWipedOut() public {
        _deposit(alice, 100_000e6);
        uint256 policyId = _buy(holder, holderShares, 100_000e6, 0);
        _badDebtOf(1_000_000e6);
        assertEq(vault.claim(policyId), 100_000e6);
        assertEq(vault.totalPrincipal(), 0);

        _mint(bob, 1e6);
        vm.startPrank(bob);
        usd.approve(address(vault), 1e6);
        vm.expectRevert(MorphoCoverVault.PrincipalWipedOut.selector);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ withdrawals

    function test_noticeIsEnforced() public {
        _deposit(alice, 100_000e6);
        vm.startPrank(alice);
        vm.expectRevert(MorphoCoverVault.NoWithdrawalRequest.selector);
        vault.withdraw();

        vault.requestWithdrawal(40_000e6);
        uint256 readyAt = block.timestamp + NOTICE;
        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoticePending.selector, readyAt));
        vault.withdraw();

        vm.warp(readyAt);
        (uint256 assets,) = vault.withdraw();
        vm.stopPrank();
        assertEq(assets, 40_000e6);
        assertEq(usd.balanceOf(alice), 40_000e6);
        assertEq(vault.sharesOf(alice), 60_000e6);
        assertEq(vault.sharesUnderNotice(), 0);
    }

    function test_withdrawalLapsesAfterItsWindow() public {
        _deposit(alice, 100_000e6);
        vm.startPrank(alice);
        vault.requestWithdrawal(100_000e6);
        uint256 expiresAt = block.timestamp + NOTICE + WINDOW;
        vm.warp(expiresAt + 1);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.WithdrawalExpired.selector, expiresAt)
        );
        vault.withdraw();

        // A fresh request starts the notice again.
        vault.requestWithdrawal(100_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.NoticePending.selector, block.timestamp + NOTICE
            )
        );
        vault.withdraw();
        vm.stopPrank();
    }

    function test_cancelAndReplaceRequests() public {
        _deposit(alice, 100_000e6);
        vm.startPrank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.InsufficientShares.selector, 100_000e6 + 1, 100_000e6
            )
        );
        vault.requestWithdrawal(100_000e6 + 1);

        vault.requestWithdrawal(30_000e6);
        vault.requestWithdrawal(50_000e6);
        assertEq(vault.sharesUnderNotice(), 50_000e6);
        vm.expectEmit(address(vault));
        emit MorphoCoverVault.WithdrawalCancelled(alice, 50_000e6);
        vault.cancelWithdrawal();
        assertEq(vault.sharesUnderNotice(), 0);
        vm.expectRevert(MorphoCoverVault.NoWithdrawalRequest.selector);
        vault.cancelWithdrawal();
        vm.stopPrank();
    }

    function test_sharesUnderNoticeStayAtRisk() public {
        _deposit(alice, 500_000e6);
        _deposit(bob, 500_000e6);
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);

        vm.prank(alice);
        vault.requestWithdrawal(500_000e6);
        // A loss during the notice is shared by everyone, including alice.
        _badDebtOf(200_000e6);
        uint256 paid = vault.claim(policyId);

        vm.warp(block.timestamp + NOTICE);
        vm.prank(alice);
        (uint256 assets,) = vault.withdraw();
        assertEq(assets, (1_000_000e6 - paid) / 2);
    }

    function test_capacityLeavesOutPrincipalUnderNotice() public {
        _deposit(alice, 600_000e6);
        _deposit(bob, 400_000e6);
        vm.prank(alice);
        vault.requestWithdrawal(600_000e6);
        assertEq(vault.principalUnderNotice(), 600_000e6);
        assertEq(vault.capacity(), 400_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.CapacityExceeded.selector, 400_000e6 + 1, 400_000e6
            )
        );
        vault.buyPolicy(id, holder, holderShares, 400_000e6 + 1, 0);
    }

    // ---------------------------------------------------------------- premium

    function test_premiumIsTheStatedRate() public view {
        // 100k limit at 2% a year for 30 days: 164.383561... rounded up.
        assertEq(vault.premiumFor(id, 100_000e6), 164_383_562);
    }

    function test_premiumStreamsOverTheTerm() public {
        _deposit(alice, 1_000_000e6);
        uint256 premium = vault.premiumFor(id, 1_000_000e6);
        _buy(holder, holderShares, 1_000_000e6, 0);
        assertEq(vault.premiumFunded(), premium);
        assertEq(usd.balanceOf(address(vault)), 1_000_000e6 + premium);

        vm.warp(block.timestamp + TERM / 2);
        assertApproxEqAbs(vault.pendingPremium(alice), premium / 2, 2);

        vm.warp(block.timestamp + TERM);
        assertApproxEqAbs(vault.pendingPremium(alice), premium, 2);
        vm.prank(alice);
        uint256 got = vault.claimPremium();
        assertApproxEqAbs(got, premium, 2);
        assertEq(vault.premiumRate(), 0);
        _assertSolvent();
    }

    function test_lateUnderwriterEarnsFromWhenTheyJoin() public {
        _deposit(alice, 500_000e6);
        uint256 premium = vault.premiumFor(id, 500_000e6);
        _buy(holder, holderShares, 500_000e6, 0);
        vm.warp(block.timestamp + TERM / 2);
        _deposit(bob, 500_000e6);
        vm.warp(block.timestamp + TERM);

        // Alice has it all for the first half, then half for the second.
        assertApproxEqAbs(vault.pendingPremium(alice), premium * 3 / 4, 3);
        assertApproxEqAbs(vault.pendingPremium(bob), premium / 4, 3);
    }

    function test_streamsRetireAtTheirOwnEnd() public {
        _deposit(alice, 2_000_000e6);
        uint256 t0 = block.timestamp;
        _buy(holder, holderShares, 500_000e6, 0);
        uint256 rateA = vault.premiumRate();
        vm.warp(t0 + 10 days);
        _buy(otherSupplier, holderShares, 500_000e6, 0);
        uint256 rateB = vault.premiumRate() - rateA;

        vm.warp(t0 + TERM + 1);
        vault.claimPremium();
        assertEq(vault.premiumRate(), rateB);
        assertEq(vault.streamHead(), 1);

        vm.warp(t0 + 10 days + TERM);
        vm.prank(alice);
        uint256 got = vault.claimPremium();
        assertEq(vault.premiumRate(), 0);
        assertApproxEqAbs(got, vault.premiumFunded(), 4);
    }

    function test_premiumWithNoUnderwritersGoesToTheOwner() public {
        // Capacity needs capital, so put some in, sell, then everyone leaves.
        _deposit(alice, 1_000_000e6);
        uint256 premium = vault.premiumFor(id, 100_000e6);
        _buy(holder, holderShares, 100_000e6, 0);
        vm.startPrank(alice);
        vault.requestWithdrawal(1_000_000e6);
        vm.warp(block.timestamp + NOTICE);
        (, uint256 earned) = vault.withdraw();
        vm.stopPrank();
        assertEq(vault.totalShares(), 0);

        vm.warp(block.timestamp + TERM);
        uint256 swept = vault.sweepUnallocatedPremium();
        assertEq(usd.balanceOf(owner), swept);
        assertApproxEqAbs(earned + swept, premium, 2);
        assertEq(vault.sweepUnallocatedPremium(), 0);
    }

    function test_premiumNeverPaysAClaim() public {
        _deposit(alice, 100_000e6);
        uint256 policyId = _buy(holder, holderShares, 100_000e6, 0);
        uint256 premium = vault.premiumFunded();
        _badDebtOf(1_000_000e6);
        assertEq(vault.claim(policyId), 100_000e6);
        assertEq(usd.balanceOf(address(vault)), premium);

        vm.warp(block.timestamp + TERM);
        vm.prank(alice);
        assertApproxEqAbs(vault.claimPremium(), premium, 2);
        _assertSolvent();
    }
}
