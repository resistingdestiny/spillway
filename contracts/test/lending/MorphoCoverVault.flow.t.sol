// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "../../script/lending/MorphoReplay.sol";

/// @dev End to end on a local Morpho Blue: suppliers and borrowers at real loan to
/// values, the collateral breaks, liquidators clear the book, Morpho writes off bad
/// debt, and the cover pays each covered supplier its share of it.
contract MorphoCoverVaultFlowTest is MorphoFixture {
    address internal constant B1 = address(0xB1);
    address internal constant B2 = address(0xB2);
    address internal constant B3 = address(0xB3);
    address internal constant B4 = address(0xB4);

    function test_oracleDropAndLiquidationsCreateBadDebtAndTheClaimPaysIt() public {
        // Three suppliers, 3M in all. The holder has 1.5M of it.
        uint256 holderShares = _supply(holder, 1_500_000e6);
        _supply(otherSupplier, 1_000_000e6);
        _supply(alice, 500_000e6);

        // Four borrowers at $4,000 wstETH. Loan to value 85%, 80%, 70% and 50%.
        _borrow(B1, 300e18, 1_020_000e6);
        _borrow(B2, 250e18, 800_000e6);
        _borrow(B3, 200e18, 560_000e6);
        _borrow(B4, 100e18, 200_000e6);

        // Underwriters put up 1M, and the holder buys cover on all its shares with a
        // 25k deductible.
        _deposit(bob, 1_000_000e6);
        uint256 policyId = _buy(holder, holderShares, 1_000_000e6, 25_000e6);
        uint256 valueBefore = _assetsOf(holder);

        // A day of interest, then wstETH depegs 25%.
        vm.warp(block.timestamp + 1 days);
        _drop(2500);
        morpho.accrueInterest(params);

        // B1 (85% LTV becomes 113%) and B2 (80% becomes 107%) are under water. B3 (70%
        // becomes 93%) is unhealthy but its collateral still covers debt times the
        // incentive. B4 stays healthy.
        assertFalse(MorphoReplay.isHealthy(morpho, params, B1));
        assertFalse(MorphoReplay.isHealthy(morpho, params, B2));
        assertFalse(MorphoReplay.isHealthy(morpho, params, B3));
        assertTrue(MorphoReplay.isHealthy(morpho, params, B4));

        // Before anyone liquidates, the loss is unrealised and the cover pays nothing.
        assertEq(vault.claimable(policyId), 0);

        uint256 supplyBefore = morpho.market(id).totalSupplyAssets;
        uint256 badDebt;
        address[4] memory borrowers = [B1, B2, B3, B4];
        for (uint256 i; i < borrowers.length; ++i) {
            (, uint256 b) = _liquidate(borrowers[i]);
            badDebt += b;
        }
        Market memory m = morpho.market(id);
        assertEq(supplyBefore - m.totalSupplyAssets, badDebt);
        assertEq(morpho.position(id, B3).borrowShares, 0, "B3 repaid in full");
        assertGt(morpho.position(id, B3).collateral, 0, "B3 keeps the change");
        assertGt(morpho.position(id, B4).borrowShares, 0, "B4 untouched");

        // B1: 300 wstETH at $3,000 is $900k, repaid at 1/1.0438, against $1.02M of debt.
        // B2: 250 at $3,000 is $750k against $800k. Bad debt is about 157k + 81k.
        assertApproxEqRel(badDebt, 238_000e6, 0.01e18);

        // The claim pays the holder's half of the bad debt less the deductible.
        uint256 loss = _lossSince(policyId, holderShares);
        assertEq(loss, valueBefore - _assetsOf(holder), "loss in Morpho's terms");
        uint256 paid = vault.claim(policyId);
        assertEq(paid, loss - 25_000e6);
        // A day of interest on 2.58M of debt at 5% offsets a little of the loss.
        assertApproxEqRel(loss, badDebt / 2, 0.005e18);
        assertEq(usd.balanceOf(holder), paid);
        _assertSolvent();

        // Nothing more to pay until the loss grows.
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);
    }
}
