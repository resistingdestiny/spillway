// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id, MarketParams, Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {TestToken} from "../../src/lending/TestToken.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {FixedRateIrm} from "../../src/lending/FixedRateIrm.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "../../script/lending/MorphoReplay.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev Shared setup: Morpho Blue deployed locally, a wstETH/tUSD market at 86% LLTV
/// with wstETH at $4,000, and a cover vault that lists it.
abstract contract MorphoFixture is Test {
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;

    uint256 internal constant START = 1_800_000_000;
    uint256 internal constant LLTV = 0.86e18;
    /// @dev $4,000 for 1e18 base units of collateral, in 6-decimal base units, scaled 1e36.
    uint256 internal constant PRICE = 4000e6 * 1e36 / 1e18;

    IMorpho internal morpho;
    FixedRateIrm internal irm;
    MockUSD internal usd;
    TestToken internal wsteth;
    MockOracle internal oracle;
    MarketParams internal params;
    Id internal id;
    MorphoCoverVault internal vault;

    address internal owner = makeAddr("owner");
    address internal holder = makeAddr("holder");
    address internal otherSupplier = makeAddr("other-supplier");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal buyer = makeAddr("buyer");

    function setUp() public virtual {
        vm.warp(START);
        (morpho, irm) = MorphoReplay.deployMorpho(address(this));
        usd = new MockUSD();
        wsteth = new TestToken(
            "Test wstETH",
            "twstETH",
            LendingConfig.COLLATERAL_DECIMALS,
            LendingConfig.COLLATERAL_MAX_MINT
        );
        oracle = new MockOracle(PRICE, address(this));
        params = MarketParams({
            loanToken: address(usd),
            collateralToken: address(wsteth),
            oracle: address(oracle),
            irm: address(irm),
            lltv: LLTV
        });
        id = params.id();
        morpho.createMarket(params);

        vault = new MorphoCoverVault(
            usd,
            morpho,
            owner,
            LendingConfig.POLICY_TERM,
            _waitingPeriod(),
            LendingConfig.CLAIM_WINDOW,
            LendingConfig.WITHDRAWAL_NOTICE,
            LendingConfig.WITHDRAWAL_WINDOW,
            LendingConfig.DUST_THRESHOLD
        );
        vm.prank(owner);
        vault.listMarket(params, LendingConfig.PREMIUM_BPS);
    }

    /// @dev No waiting period by default, so a policy attaches when bought and the
    /// claim tests measure from that moment. The waiting period tests override it with
    /// the config's default.
    function _waitingPeriod() internal view virtual returns (uint256) {
        return 0;
    }

    // ---------------------------------------------------------------- helpers

    function _mint(address to, uint256 amount) internal {
        uint256 cap = usd.MAX_MINT();
        while (amount > 0) {
            uint256 chunk = amount > cap ? cap : amount;
            usd.mint(to, chunk);
            amount -= chunk;
        }
    }

    /// @dev `who` supplies `assets` of tUSD to the market. Returns supply shares.
    function _supply(address who, uint256 assets) internal returns (uint256 shares) {
        _mint(who, assets);
        vm.startPrank(who);
        usd.approve(address(morpho), assets);
        (, shares) = morpho.supply(params, assets, 0, who, "");
        vm.stopPrank();
    }

    /// @dev `who` posts `collateral` wstETH and borrows `assets` tUSD.
    function _borrow(address who, uint256 collateral, uint256 assets) internal {
        wsteth.mint(who, collateral);
        vm.startPrank(who);
        wsteth.approve(address(morpho), collateral);
        morpho.supplyCollateral(params, collateral, who, "");
        morpho.borrow(params, assets, 0, who, who);
        vm.stopPrank();
    }

    /// @dev `who` deposits `amount` of underwriting capital into the vault.
    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(vault), amount);
        shares = vault.deposit(amount);
        vm.stopPrank();
    }

    /// @dev `buyer` pays for a policy on `shares` of `who`'s supply.
    function _buy(address who, uint256 shares, uint256 limit, uint256 deductible)
        internal
        returns (uint256 policyId)
    {
        uint256 premium = vault.premiumFor(id, limit);
        _mint(buyer, premium);
        vm.startPrank(buyer);
        usd.approve(address(vault), premium);
        policyId = vault.buyPolicy(id, who, shares, limit, deductible);
        vm.stopPrank();
    }

    /// @dev Moves the oracle by `-dropBps` basis points.
    function _drop(uint256 dropBps) internal {
        oracle.setPrice(oracle.price() * (10_000 - dropBps) / 10_000);
    }

    /// @dev The liquidator, funded with enough tUSD, liquidates `who` in full.
    function _liquidate(address who) internal returns (uint256 repaid, uint256 badDebt) {
        _mint(liquidator, morpho.market(id).totalBorrowAssets + 1e6);
        vm.startPrank(liquidator);
        usd.approve(address(morpho), type(uint256).max);
        (repaid, badDebt) = MorphoReplay.liquidate(morpho, params, who);
        vm.stopPrank();
    }

    /// @dev Writes `badDebt` off the market directly: a borrower whose collateral is
    /// worth nothing at the oracle is liquidated for all of it. Cheaper to set up than a
    /// full position, and the share price falls by exactly what Morpho books.
    function _badDebtOf(uint256 debt) internal returns (uint256 badDebt) {
        address b = makeAddr(string.concat("bad-", vm.toString(debt)));
        // Collateral worth just over the debt at LLTV, then the price collapses.
        uint256 collateral = debt * 1e36 / PRICE * 1e18 / LLTV + 1e18;
        _borrow(b, collateral, debt);
        uint256 price = oracle.price();
        oracle.setPrice(1);
        (, badDebt) = _liquidate(b);
        oracle.setPrice(price);
    }

    /// @dev Morpho's supply share price now, after accruing interest, as the vault reads it.
    function _price() internal returns (uint256) {
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        return vault.sharePriceOf(m.totalSupplyAssets, m.totalSupplyShares);
    }

    /// @dev What `who`'s supply is worth to Morpho right now, rounded as Morpho rounds.
    function _assetsOf(address who) internal returns (uint256) {
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        Position memory p = morpho.position(id, who);
        return p.supplyShares.toAssetsDown(m.totalSupplyAssets, m.totalSupplyShares);
    }

    /// @dev What `shares` have lost in redeemable value since policy `policyId` began,
    /// computed with Morpho's own SharesMathLib rather than the vault.
    function _lossSince(uint256 policyId, uint256 shares) internal returns (uint256) {
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        uint256 atStart = shares.toAssetsDown(p.startSupplyAssets, p.startSupplyShares);
        uint256 atNow = shares.toAssetsDown(m.totalSupplyAssets, m.totalSupplyShares);
        return atStart > atNow ? atStart - atNow : 0;
    }

    /// @dev Policy `policyId`'s start share price, scaled by 1e36.
    function _startPrice(uint256 policyId) internal view returns (uint256) {
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        return vault.sharePriceOf(p.startSupplyAssets, p.startSupplyShares);
    }

    function _sharesOf(address who) internal view returns (uint256) {
        return morpho.position(id, who).supplyShares;
    }

    /// @dev The solvency rule: the vault holds at least principal plus premium reserve.
    function _assertSolvent() internal view {
        assertGe(
            usd.balanceOf(address(vault)),
            vault.totalPrincipal() + vault.premiumReserve(),
            "vault insolvent"
        );
    }
}
