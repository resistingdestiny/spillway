// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Id, MarketParams} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev The trigger and the payout: what a claim pays, and when it pays nothing.
contract MorphoCoverVaultClaimTest is MorphoFixture {
    using MarketParamsLib for MarketParams;

    uint256 internal constant SUPPLY = 1_000_000e6;
    uint256 internal constant CAPITAL = 2_000_000e6;

    uint256 internal holderShares;

    function setUp() public override {
        super.setUp();
        holderShares = _supply(holder, SUPPLY);
        _supply(otherSupplier, SUPPLY);
        _deposit(alice, CAPITAL);
    }

    /// @dev The payout rule, computed independently of the vault.
    function _expected(uint256 policyId, uint256 shares, uint256 deductible, uint256 limit)
        internal
        returns (uint256)
    {
        uint256 loss = _lossSince(policyId, shares);
        if (loss <= deductible) return 0;
        return Math.min(loss - deductible, limit);
    }

    // ------------------------------------------------------------- the payout

    function test_claimPaysShareLossTimesCoveredShares() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        uint256 startPrice = _startPrice(policyId);
        assertEq(startPrice, _price());
        uint256 valueBefore = _assetsOf(holder);

        uint256 badDebt = _badDebtOf(100_000e6);
        assertGt(badDebt, 99_000e6);
        uint256 price = _price();
        assertLt(price, startPrice);

        uint256 expected = _expected(policyId, holderShares, 0, 500_000e6);
        uint256 before = usd.balanceOf(holder);
        uint256 paid = vault.claim(policyId);

        assertEq(paid, expected);
        assertEq(usd.balanceOf(holder) - before, paid);
        // The payout is the fall in what the holder can withdraw from Morpho, exactly.
        assertEq(paid, valueBefore - _assetsOf(holder));
        // The holder supplied 1M of the 2M the bad debt was spread over (plus the bad
        // borrower's own borrow, which is the same pool), so it bears about half.
        assertApproxEqRel(paid, badDebt / 2, 0.001e18);
        assertEq(vault.policy(policyId).paid, paid);
        assertEq(vault.paidOut(), paid);
        assertEq(vault.totalPrincipal(), CAPITAL - paid);
        _assertSolvent();
    }

    function test_deductibleIsSubtracted() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 10_000e6);
        _badDebtOf(100_000e6);
        uint256 loss = _lossSince(policyId, holderShares);

        assertEq(vault.claim(policyId), loss - 10_000e6);
    }

    function test_partialCoverPaysOnCoveredSharesOnly() public {
        uint256 policyId = _buy(holder, holderShares / 4, 500_000e6, 0);
        _badDebtOf(100_000e6);
        uint256 expected = _expected(policyId, holderShares / 4, 0, 500_000e6);
        assertEq(vault.claim(policyId), expected);
    }

    function test_limitCapsThePayout() public {
        uint256 policyId = _buy(holder, holderShares, 20_000e6, 0);
        _badDebtOf(100_000e6);
        assertEq(vault.claim(policyId), 20_000e6);

        // More loss later pays nothing more: the limit is used up.
        _badDebtOf(100_000e6);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
        assertEq(vault.policy(policyId).paid, 20_000e6);
    }

    function test_freeCapitalCapsThePayout() public {
        // Bob joins with 500k. Alice then leaves after notice, so principal falls to
        // 500k, below the 1M limit the vault backed when it sold the policy.
        _deposit(bob, 500_000e6);
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        vm.startPrank(alice);
        vault.requestWithdrawal(vault.sharesOf(alice));
        vm.warp(block.timestamp + LendingConfig.WITHDRAWAL_NOTICE);
        vault.withdraw();
        vm.stopPrank();
        assertEq(vault.totalPrincipal(), 500_000e6);

        // A loss that wipes most of the market: the holder bears about 900k of it.
        _badDebtOf(1_800_000e6);
        uint256 due = vault.claimable(policyId);
        assertGt(due, 500_000e6);

        assertEq(vault.claim(policyId), 500_000e6);
        assertEq(vault.totalPrincipal(), 0);
        vm.expectRevert(MorphoCoverVault.NoFreeCapital.selector);
        vault.claim(policyId);
        _assertSolvent();
    }

    function test_claimsRepeatAsTheLossGrows() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 5_000e6);
        _badDebtOf(40_000e6);
        uint256 first = vault.claim(policyId);
        assertEq(first, _expected(policyId, holderShares, 5_000e6, 500_000e6));

        _badDebtOf(60_000e6);
        uint256 second = vault.claim(policyId);
        uint256 total = _expected(policyId, holderShares, 5_000e6, 500_000e6);
        assertEq(first + second, total);
        assertEq(vault.policy(policyId).paid, total);
    }

    function test_claimIsPermissionlessAndPaysTheHolder() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        _badDebtOf(100_000e6);
        uint256 expected = vault.claimable(policyId);

        vm.expectEmit(true, true, false, false, address(vault));
        emit MorphoCoverVault.Claimed(policyId, holder, 0, 0, 0, 0);
        vm.prank(makeAddr("stranger"));
        uint256 paid = vault.claim(policyId);

        assertEq(paid, expected);
        assertEq(usd.balanceOf(makeAddr("stranger")), 0);
        assertEq(usd.balanceOf(holder), paid);
    }

    function test_claimAccruesInterestFirst() public {
        // With interest accruing, the view and the claim agree only if the claim accrues.
        _borrow(borrower, 500e18, 600_000e6);
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        vm.warp(block.timestamp + 10 days);
        _badDebtOf(100_000e6);
        vm.warp(block.timestamp + 1 days);
        uint256 viewed = vault.claimable(policyId);
        assertEq(vault.claim(policyId), viewed);
    }

    // ------------------------------------------------------------- no payout

    function test_noLossNoClaim() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        assertEq(vault.claimable(policyId), 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
    }

    function test_interestAccrualAloneNeverPays() public {
        _borrow(borrower, 500e18, 1_500_000e6);
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        uint256 startPrice = _startPrice(policyId);
        for (uint256 i; i < 6; ++i) {
            vm.warp(block.timestamp + 5 days);
            assertGt(_price(), startPrice);
            vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
            vault.claim(policyId);
        }
    }

    function test_interestEarnedSinceInceptionAbsorbsASmallLoss() public {
        _borrow(borrower, 500e18, 1_500_000e6);
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        vm.warp(block.timestamp + 30 days);
        // About 6,000 of interest has reached suppliers. A 2,000 loss leaves the price above
        // where it started.
        _badDebtOf(2_000e6);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
    }

    function test_lossWithinTheDeductibleDoesNotPay() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 60_000e6);
        _badDebtOf(100_000e6); // the holder loses about 50k
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
    }

    function test_dustIsNotPaid() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        _badDebtOf(1.5e6); // the holder loses about 0.75
        uint256 due = vault.claimable(policyId);
        assertGt(due, 0);
        assertLt(due, LendingConfig.DUST_THRESHOLD);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.BelowDust.selector, due, LendingConfig.DUST_THRESHOLD
            )
        );
        vault.claim(policyId);
    }

    function test_holderWhoLeftTheMarketIsNotPaid() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        vm.prank(holder);
        morpho.withdraw(params, 0, holderShares, holder, holder);
        _badDebtOf(100_000e6);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
    }

    function test_unknownPolicy() public {
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.UnknownPolicy.selector, 7));
        vault.claim(7);
    }

    // ------------------------------------------------------ claim window

    function test_claimWindowAfterTheEnd() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        uint256 end = vault.policy(policyId).end;
        vm.warp(end + LendingConfig.CLAIM_WINDOW);
        _badDebtOf(100_000e6);
        assertGt(vault.claim(policyId), 0);

        vm.warp(end + LendingConfig.CLAIM_WINDOW + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.ClaimWindowClosed.selector,
                policyId,
                end + LendingConfig.CLAIM_WINDOW
            )
        );
        vault.claim(policyId);
    }

    function test_releaseReturnsCapacityAfterTheWindow() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        uint256 closesAt = vault.policy(policyId).end + LendingConfig.CLAIM_WINDOW;
        assertEq(vault.capacity(), CAPITAL - 500_000e6);
        assertEq(vault.coveredSharesOf(id, holder), holderShares);

        vm.warp(closesAt);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.ClaimWindowOpen.selector, policyId, closesAt)
        );
        vault.release(policyId);

        vm.warp(closesAt + 1);
        vm.expectEmit(address(vault));
        emit MorphoCoverVault.PolicyReleased(policyId, 500_000e6);
        vault.release(policyId);
        assertEq(vault.capacity(), CAPITAL);
        assertEq(vault.activeLimit(), 0);
        assertEq(vault.coveredSharesOf(id, holder), 0);

        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.AlreadyReleased.selector, policyId));
        vault.release(policyId);
    }

    // ------------------------------------------------------------ whitelist

    function test_unlistedMarketIsRejected() public {
        Id other = Id.wrap(keccak256("not a market"));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.MarketNotListed.selector, other));
        vault.buyPolicy(other, holder, 1, 1, 0, _none());
    }

    function test_sameMarketWithAnotherOracleIsADifferentId() public {
        // The id hashes all five parameters, so a market that swaps in another oracle is
        // not covered by the listing.
        MockOracle rogue = new MockOracle(PRICE, address(this));
        MarketParams memory p = params;
        p.oracle = address(rogue);
        morpho.createMarket(p);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.MarketNotListed.selector, p.id()));
        vault.buyPolicy(p.id(), holder, 1, 1, 0, _none());
    }

    function test_listingChecks() public {
        MarketParams memory p = params;
        p.lltv = 0.77e18;
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.MarketNotCreated.selector, p.id()));
        vault.listMarket(p, 200);

        p.loanToken = address(wsteth);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.LoanTokenMismatch.selector, address(wsteth))
        );
        vault.listMarket(p, 200);

        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.InvalidPremiumRate.selector, 0));
        vault.listMarket(params, 0);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.listMarket(params, 200);
    }

    function test_delistStopsSalesButNotClaims() public {
        uint256 policyId = _buy(holder, holderShares / 2, 500_000e6, 0);
        vm.prank(owner);
        vault.delistMarket(id);
        assertFalse(vault.isListed(id));

        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.MarketNotListed.selector, id));
        vault.buyPolicy(id, holder, 1, 1, 0, _none());

        _badDebtOf(100_000e6);
        assertGt(vault.claim(policyId), 0);
    }

    // ------------------------------------------------------------ underwriting

    function test_cannotCoverSharesNotHeld() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.SharesNotHeld.selector, holderShares + 1, holderShares
            )
        );
        vault.buyPolicy(id, holder, holderShares + 1, 1e6, 0, _none());

        // The same shares cannot be covered twice.
        _buy(holder, holderShares, 100_000e6, 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.SharesNotHeld.selector, 1, 0));
        vault.buyPolicy(id, holder, 1, 1e6, 0, _none());
    }

    function test_limitMustFitCapacity() public {
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.CapacityExceeded.selector, CAPITAL + 1, CAPITAL)
        );
        vault.buyPolicy(id, holder, holderShares, CAPITAL + 1, 0, _none());
    }

    function test_policyRecordsItsTerms() public {
        vm.recordLogs();
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 1_000e6);
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        assertEq(p.holder, holder);
        assertEq(Id.unwrap(p.marketId), Id.unwrap(id));
        assertEq(p.coveredShares, holderShares);
        assertEq(p.limit, 500_000e6);
        assertEq(p.deductible, 1_000e6);
        assertEq(p.start, block.timestamp);
        assertEq(p.end, block.timestamp + LendingConfig.POLICY_TERM);
        assertEq(p.startSupplyAssets, morpho.market(id).totalSupplyAssets);
        assertEq(p.startSupplyShares, morpho.market(id).totalSupplyShares);
        // A fresh market prices one share at 1e-6 of a base unit: 1e30 at 1e36 scale.
        assertApproxEqRel(_startPrice(policyId), 1e30, 1e12);
        assertEq(vault.policyCount(), 1);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = MorphoCoverVault.PolicyBought.selector;
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == topic) seen = true;
        }
        assertTrue(seen, "PolicyBought not emitted");
    }
}
