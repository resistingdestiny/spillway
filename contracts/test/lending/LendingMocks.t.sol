// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {TestToken} from "../../src/lending/TestToken.sol";
import {MorphoReplay} from "../../script/lending/MorphoReplay.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev The testnet pieces under the cover: oracle, test collateral, IRM and our own
/// Morpho Blue deployment.
contract LendingMocksTest is MorphoFixture {
    function test_oracleOwnerSetsPrice() public {
        vm.expectEmit(address(oracle));
        emit MockOracle.PriceSet(PRICE, PRICE / 2);
        oracle.setPrice(PRICE / 2);
        assertEq(oracle.price(), PRICE / 2);
    }

    function test_oracleRejectsStrangersAndZero() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setPrice(1);

        vm.expectRevert(MockOracle.ZeroPrice.selector);
        oracle.setPrice(0);
        vm.expectRevert(MockOracle.ZeroPrice.selector);
        new MockOracle(0, address(this));
    }

    function test_oracleScaleMatchesMorpho() public view {
        // One whole wstETH (1e18) is worth 4,000 whole tUSD (4000e6) at the oracle.
        assertEq(1e18 * oracle.price() / LendingConfig.ORACLE_PRICE_SCALE, 4000e6);
    }

    function test_testTokenFaucet() public {
        assertEq(wsteth.name(), "Test wstETH");
        assertEq(wsteth.symbol(), "twstETH");
        assertEq(wsteth.decimals(), 18);
        wsteth.mint(alice, 5e18);
        assertEq(wsteth.balanceOf(alice), 5e18);

        uint256 cap = wsteth.maxMint();
        vm.expectRevert(abi.encodeWithSelector(TestToken.MintCapExceeded.selector, cap + 1, cap));
        wsteth.mint(alice, cap + 1);
    }

    function test_morphoDeployedWithOurIrmAndLltvs() public view {
        assertEq(morpho.owner(), address(this));
        assertTrue(morpho.isIrmEnabled(address(irm)));
        uint256[6] memory lltvs = LendingConfig.lltvs();
        for (uint256 i; i < lltvs.length; ++i) {
            assertTrue(morpho.isLltvEnabled(lltvs[i]));
        }
        assertGt(morpho.market(id).lastUpdate, 0);
    }

    function test_fixedRateIrmAccruesInterest() public {
        _supply(alice, 1_000_000e6);
        _borrow(borrower, 500e18, 1_000_000e6 / 2);
        vm.warp(block.timestamp + 365 days);
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        // 5% a year, compounded by Morpho's third-order Taylor expansion: a bit over 5%.
        assertGt(m.totalBorrowAssets, 525_000e6);
        assertLt(m.totalBorrowAssets, 526_000e6);
        assertEq(irm.ratePerSecond(), LendingConfig.BORROW_RATE_PER_SECOND);
    }

    function test_liquidationIncentiveFactorMatchesDocs() public pure {
        // docs/LENDING.md, to four places: 1.0168 at 94.5%, 1.0262 at 91.5%, 1.0438 at
        // 86%, 1.0741 at 77%.
        assertEq(_fourPlaces(MorphoReplay.liquidationIncentiveFactor(0.945e18)), 10168);
        assertEq(_fourPlaces(MorphoReplay.liquidationIncentiveFactor(0.915e18)), 10262);
        assertEq(_fourPlaces(MorphoReplay.liquidationIncentiveFactor(0.86e18)), 10438);
        assertEq(_fourPlaces(MorphoReplay.liquidationIncentiveFactor(0.77e18)), 10741);
        assertEq(MorphoReplay.liquidationIncentiveFactor(0), 1.15e18);
    }

    function _fourPlaces(uint256 wad) internal pure returns (uint256) {
        return (wad + 0.5e14) / 1e14;
    }

    function test_liquidationWithoutBadDebt() public {
        _supply(alice, 1_000_000e6);
        // 100 wstETH at $4,000 = $400k, borrow $340k (85%).
        _borrow(borrower, 100e18, 340_000e6);
        assertTrue(MorphoReplay.isHealthy(morpho, params, borrower));
        // A 2% drop makes it unhealthy (85% / 0.98 > 86%) but leaves the collateral worth
        // far more than debt times the incentive.
        _drop(200);
        assertFalse(MorphoReplay.isHealthy(morpho, params, borrower));
        uint256 supplyBefore = morpho.market(id).totalSupplyAssets;
        (uint256 repaid, uint256 badDebt) = _liquidate(borrower);
        assertEq(badDebt, 0);
        assertGe(repaid, 340_000e6);
        assertEq(morpho.position(id, borrower).borrowShares, 0);
        assertGt(morpho.position(id, borrower).collateral, 0);
        assertGe(morpho.market(id).totalSupplyAssets, supplyBefore);
    }

    function test_liquidationWithBadDebt() public {
        _supply(alice, 1_000_000e6);
        _borrow(borrower, 100e18, 340_000e6);
        // A 30% drop: collateral is worth $280k, below the $340k debt.
        _drop(3000);
        (uint256 repaid, uint256 badDebt) = _liquidate(borrower);
        assertEq(morpho.position(id, borrower).collateral, 0);
        assertEq(morpho.position(id, borrower).borrowShares, 0);
        // Repaid is the collateral's value over the incentive factor. The rest is bad debt.
        assertApproxEqAbs(repaid, uint256(280_000e6) * 1e18 / 1.0438e18, 50e6);
        assertApproxEqAbs(badDebt, 340_000e6 - repaid, 2);
    }

    function test_healthyPositionIsLeftAlone() public {
        _supply(alice, 1_000_000e6);
        _borrow(borrower, 100e18, 300_000e6);
        (uint256 repaid, uint256 badDebt) = _liquidate(borrower);
        assertEq(repaid, 0);
        assertEq(badDebt, 0);
    }
}
