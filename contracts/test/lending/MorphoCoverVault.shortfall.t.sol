// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "../../script/lending/MorphoReplay.sol";

/// @dev The unrealised path: an oracle drop leaves a borrower under water, nobody
/// liquidates, and `claimShortfall` pays the holder's share of the gap. Then the loss is
/// realised and nothing is paid twice.
contract MorphoCoverVaultShortfallTest is MorphoFixture {
    using SharesMathLib for uint256;

    uint256 internal constant SUPPLY = 1_000_000e6;
    uint256 internal constant CAPITAL = 2_000_000e6;

    // Sorted by address, as claimShortfall requires.
    address internal constant B1 = address(0xB1);
    address internal constant B2 = address(0xB2);
    address internal constant B3 = address(0xB3);

    uint256 internal holderShares;

    function setUp() public override {
        super.setUp();
        holderShares = _supply(holder, SUPPLY);
        _supply(otherSupplier, SUPPLY);
        _deposit(alice, CAPITAL);
        // At $4,000: B1 borrows at 85% of its collateral, B2 at 70%, B3 at 40%.
        _borrow(B1, 300e18, 1_020_000e6);
        _borrow(B2, 100e18, 280_000e6);
        _borrow(B3, 100e18, 160_000e6);
    }

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        (l[0], l[1]) = (a, b);
    }

    function _list(address a, address b, address c) internal pure returns (address[] memory l) {
        l = new address[](3);
        (l[0], l[1], l[2]) = (a, b, c);
    }

    /// @dev The unrealised due, computed from Morpho's state without the vault: each
    /// borrower's debt (rounded down) less its collateral at the oracle (rounded up),
    /// the holder's pro rata part of the sum, plus the realised loss, less the deductible.
    function _expected(uint256 policyId, address[] memory borrowers) internal returns (uint256) {
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        uint256 shortfall;
        for (uint256 i; i < borrowers.length; ++i) {
            Position memory pos = morpho.position(id, borrowers[i]);
            uint256 debt =
                uint256(pos.borrowShares).toAssetsDown(m.totalBorrowAssets, m.totalBorrowShares);
            uint256 value = Math.mulDiv(pos.collateral, oracle.price(), 1e36, Math.Rounding.Ceil);
            if (debt > value) shortfall += debt - value;
        }
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        uint256 shares = Math.min(p.coveredShares, _sharesOf(p.holder));
        uint256 unrealised = shortfall * shares / (m.totalSupplyShares + 1e6);
        uint256 atStart = shares.toAssetsDown(p.startSupplyAssets, p.startSupplyShares);
        uint256 atNow = shares.toAssetsDown(m.totalSupplyAssets, m.totalSupplyShares);
        if (atStart + unrealised <= atNow + p.deductible) return 0;
        return Math.min(atStart + unrealised - atNow - p.deductible, p.limit);
    }

    // ------------------------------------------------------------- the payout

    function test_unrealisedShortfallPaysTheHolderShareExactly() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);

        // wstETH is marked down 25%. B1's 300 wstETH is worth 900k against 1.02M of debt.
        // Nobody liquidates: the share price has not moved, so `claim` pays nothing.
        _drop(2500);
        assertFalse(MorphoReplay.isHealthy(morpho, params, B1));
        assertEq(_price(), _startPrice(policyId));
        assertEq(vault.claimable(policyId), 0);
        assertEq(vault.marketShortfall(id, _list(B1)), 120_000e6);

        // The holder has 1e18 of the market's 2e18 supply shares (plus Morpho's 1e6
        // virtual shares): half of 120k, rounded down.
        uint256 due = 120_000e6 * holderShares / (2 * holderShares + 1e6);
        assertEq(due, 59_999_999_999);
        assertEq(due, _expected(policyId, _list(B1)));
        assertEq(vault.claimableShortfall(policyId, _list(B1)), due);

        vm.expectEmit(address(vault));
        emit MorphoCoverVault.ShortfallClaimed(policyId, holder, 120_000e6, due, due, due, due);
        vm.prank(makeAddr("stranger"));
        uint256 paid = vault.claimShortfall(policyId, _list(B1));

        assertEq(paid, due);
        assertEq(usd.balanceOf(holder), due);
        assertEq(vault.policy(policyId).paid, due);
        assertEq(vault.totalPrincipal(), CAPITAL - due);
        _assertSolvent();

        // Nothing more until the shortfall grows.
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claimShortfall(policyId, _list(B1));
    }

    function test_realisingThePaidShortfallPaysOnlyTheIncrease() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        _drop(2500);
        uint256 first = vault.claimShortfall(policyId, _list(B1));
        assertEq(first, 59_999_999_999);

        // A liquidator now seizes B1's collateral. Morpho books more than the 120k
        // shortfall, because it pays the liquidator the incentive: 1.02M less 900k / 1.0438.
        (, uint256 badDebt) = _liquidate(B1);
        assertGt(badDebt, 120_000e6);
        assertApproxEqRel(badDebt, 157_766e6, 0.001e18);
        assertEq(morpho.position(id, B1).borrowShares, 0);

        // The realised loss already includes what was paid as unrealised, so `claim` pays
        // only the increase, and the total is the realised loss, once.
        uint256 loss = _lossSince(policyId, holderShares);
        assertEq(vault.claimable(policyId), loss - first);
        uint256 second = vault.claim(policyId);
        assertEq(second, loss - first);
        assertEq(first + second, loss);
        assertEq(vault.policy(policyId).paid, loss);
        assertEq(usd.balanceOf(holder), loss);

        // B1 now has no debt, so listing it again adds nothing, and neither path pays more.
        assertEq(vault.marketShortfall(id, _list(B1)), 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claimShortfall(policyId, _list(B1));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
        _assertSolvent();
    }

    function test_realisedFirstThenTheSameShortfallPaysNothingMore() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        _drop(2500);
        _liquidate(B1);
        uint256 paid = vault.claim(policyId);
        assertEq(paid, _lossSince(policyId, holderShares));

        // Listing the liquidated borrower and the others: nothing is left unrealised.
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claimShortfall(policyId, _list(B1, B2, B3));
        assertEq(vault.policy(policyId).paid, paid);
    }

    function test_aShortfallThatRecoversIsNotClawedBack() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        _drop(2500);
        uint256 paid = vault.claimShortfall(policyId, _list(B1));

        // The issuer reverses the markdown. B1 is healthy again and nothing is due, but
        // the policy keeps what it was paid: it is paid the most it was ever due.
        oracle.setPrice(PRICE);
        assertTrue(MorphoReplay.isHealthy(morpho, params, B1));
        assertEq(vault.claimableShortfall(policyId, _list(B1)), 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claimShortfall(policyId, _list(B1));
        assertEq(vault.policy(policyId).paid, paid);
        assertEq(usd.balanceOf(holder), paid);

        // A deeper markdown later pays only past what was paid.
        _drop(3000);
        uint256 more = vault.claimShortfall(policyId, _list(B1));
        assertEq(paid + more, _expected(policyId, _list(B1)));
    }

    // ------------------------------------------------------------ the list

    function test_unsortedOrDuplicateBorrowersAreRejected() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        _drop(2500);

        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.BorrowersNotSorted.selector, 1));
        vault.claimShortfall(policyId, _list(B2, B1));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.BorrowersNotSorted.selector, 1));
        vault.claimShortfall(policyId, _list(B1, B1));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.BorrowersNotSorted.selector, 2));
        vault.claimShortfall(policyId, _list(B1, B3, B2));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.BorrowersNotSorted.selector, 0));
        vault.claimShortfall(policyId, _list(address(0)));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.BorrowersNotSorted.selector, 1));
        vault.marketShortfall(id, _list(B1, B1));
    }

    function test_healthyBorrowersAddNothing() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        _drop(2500);

        // B3 (40% becomes 53%) stays healthy. B2 (70% becomes 93%) is unhealthy, but its
        // collateral still covers its debt, so it has no shortfall either.
        assertTrue(MorphoReplay.isHealthy(morpho, params, B3));
        assertFalse(MorphoReplay.isHealthy(morpho, params, B2));
        assertEq(vault.marketShortfall(id, _list(B2)), 0);
        assertEq(vault.marketShortfall(id, _list(B3)), 0);
        assertEq(vault.marketShortfall(id, _list(B1, B2, B3)), 120_000e6);
        assertEq(
            vault.claimableShortfall(policyId, _list(B1, B2, B3)),
            vault.claimableShortfall(policyId, _list(B1))
        );

        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claimShortfall(policyId, _list(B2, B3));
        // An address with no position adds nothing either.
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claimShortfall(policyId, _list(alice));
    }

    // ------------------------------------------------------------ the terms

    function test_deductibleAndLimitApplyToTheUnrealisedLoss() public {
        uint256 deductible = 10_000e6;
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, deductible);
        uint256 capped = _buy(otherSupplier, _sharesOf(otherSupplier), 25_000e6, 0);
        _drop(2500);

        assertEq(vault.claimShortfall(policyId, _list(B1)), 59_999_999_999 - deductible);
        assertEq(vault.claimShortfall(capped, _list(B1)), 25_000e6);
        _assertSolvent();
    }

    function test_realisedAndUnrealisedLossAdd() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        // A first borrower's bad debt is realised, then a markdown puts B1 under water.
        _badDebtOf(50_000e6);
        _drop(2500);
        uint256 realised = _lossSince(policyId, holderShares);
        assertGt(realised, 24_000e6);

        uint256 expected = _expected(policyId, _list(B1));
        assertGt(expected, realised + 59_000e6);
        assertEq(vault.claimShortfall(policyId, _list(B1)), expected);
    }

    function test_interestSinceInceptionAbsorbsTheUnrealisedLossFirst() public {
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 0);
        // 29 days at 5% on 1.46M of debt lifts the holder's supply by about 2,900. B1's
        // debt grows too, so its shortfall is a little over 120k by then.
        vm.warp(block.timestamp + 29 days);
        _drop(2500);
        uint256 gain = _assetsOf(holder) - SUPPLY;
        assertGt(gain, 2_500e6);
        Market memory m = morpho.market(id);
        uint256 share =
            vault.marketShortfall(id, _list(B1)) * holderShares / (m.totalSupplyShares + 1e6);

        // The holder is paid its share of the shortfall less the interest it has earned,
        // to a unit of rounding.
        uint256 paid = vault.claimShortfall(policyId, _list(B1));
        assertEq(paid, _expected(policyId, _list(B1)));
        assertApproxEqAbs(paid, share - gain, 1);
    }
}
