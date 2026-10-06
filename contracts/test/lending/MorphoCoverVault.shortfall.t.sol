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
    function _expected(uint256 policyId, address[] memory borrowers)
        internal
        returns (uint256)
    {
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        uint256 shortfall;
        for (uint256 i; i < borrowers.length; ++i) {
            Position memory pos = morpho.position(id, borrowers[i]);
            uint256 debt =
                uint256(pos.borrowShares).toAssetsDown(m.totalBorrowAssets, m.totalBorrowShares);
            uint256 value =
                Math.mulDiv(pos.collateral, oracle.price(), 1e36, Math.Rounding.Ceil);
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
}
