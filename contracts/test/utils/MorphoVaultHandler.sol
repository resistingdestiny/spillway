// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, Id, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {TestToken} from "../../src/lending/TestToken.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "../../script/lending/MorphoReplay.sol";

/// @dev Drives the cover vault and a live Morpho market with random but valid actions
/// for the invariant suite. Every call is shaped so it should not revert, so a revert is
/// a bug. The exceptions are `claim` and `claimShortfall`, which are expected to refuse
/// when there is nothing to pay, and are checked against what the vault said it would
/// pay. Borrowers opened by `borrow` stay in the market, so oracle moves leave some under
/// water with nobody liquidating, until `liquidate` realises their loss.
contract MorphoVaultHandler is Test {
    using MarketParamsLib for MarketParams;

    IMorpho internal immutable morpho;
    MockUSD internal immutable usd;
    TestToken internal immutable wsteth;
    MockOracle internal immutable oracle;
    MorphoCoverVault internal immutable vault;
    MarketParams internal params;
    Id internal id;

    address[] public underwriters;
    address[] public suppliers;
    uint256[] public policyIds;
    /// @notice Borrowers opened by `borrow`, in increasing address order.
    address[] public borrowers;
    /// @notice The most each policy was ever due, as `paid` plus what the vault said a
    /// claim on either path would pay, seen before every claim.
    mapping(uint256 policyId => uint256) public maxDueSeen;
    uint256 internal immutable basePrice;

    /// @notice All principal ever deposited and withdrawn.
    uint256 public ghostDeposited;
    uint256 public ghostWithdrawn;
    /// @notice Set if a claim ever paid more than min(claimable, free capital).
    bool public payoutTooLarge;
    /// @notice Count of claims that paid, and of bad debt write-offs.
    uint256 public claims;
    uint256 public shortfallClaims;
    uint256 public writeOffs;
    uint256 internal borrowerCount;

    constructor(
        IMorpho morpho_,
        MarketParams memory params_,
        MockUSD usd_,
        TestToken wsteth_,
        MockOracle oracle_,
        MorphoCoverVault vault_
    ) {
        morpho = morpho_;
        params = params_;
        id = params_.id();
        usd = usd_;
        wsteth = wsteth_;
        oracle = oracle_;
        vault = vault_;
        basePrice = oracle_.price();
        underwriters.push(makeAddr("uw-1"));
        underwriters.push(makeAddr("uw-2"));
        underwriters.push(makeAddr("uw-3"));
        suppliers.push(makeAddr("supplier-1"));
        suppliers.push(makeAddr("supplier-2"));
    }

    function underwriterCount() external view returns (uint256) {
        return underwriters.length;
    }

    function policyCount() external view returns (uint256) {
        return policyIds.length;
    }

    function _mint(address to, uint256 amount) internal {
        uint256 cap = usd.MAX_MINT();
        while (amount > 0) {
            uint256 chunk = amount > cap ? cap : amount;
            usd.mint(to, chunk);
            amount -= chunk;
        }
    }

    // ------------------------------------------------------------ underwriters

    function deposit(uint256 seed, uint256 amount) external {
        if (vault.totalShares() > 0 && vault.totalPrincipal() == 0) return;
        address who = underwriters[seed % underwriters.length];
        amount = bound(amount, 1e6, 1_000_000e6);
        _mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        ghostDeposited += amount;
    }

    function requestWithdrawal(uint256 seed, uint256 bps) external {
        address who = underwriters[seed % underwriters.length];
        uint256 shares = vault.sharesOf(who) * bound(bps, 1, 10_000) / 10_000;
        if (shares == 0) return;
        vm.prank(who);
        vault.requestWithdrawal(shares);
    }

    function withdraw(uint256 seed) external {
        address who = underwriters[seed % underwriters.length];
        (uint256 shares, uint64 readyAt) = vault.withdrawalRequests(who);
        if (shares == 0) return;
        if (block.timestamp < readyAt) vm.warp(readyAt);
        if (block.timestamp > uint256(readyAt) + vault.withdrawalWindow()) {
            vm.prank(who);
            vault.cancelWithdrawal();
            return;
        }
        vm.prank(who);
        (uint256 assets,) = vault.withdraw();
        ghostWithdrawn += assets;
    }

    function claimPremium(uint256 seed) external {
        vm.prank(underwriters[seed % underwriters.length]);
        vault.claimPremium();
    }

    function sweep() external {
        vault.sweepUnallocatedPremium();
    }

    // ------------------------------------------------------------ the market

    function supply(uint256 seed, uint256 amount) external {
        address who = suppliers[seed % suppliers.length];
        amount = bound(amount, 1_000e6, 2_000_000e6);
        _mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(morpho), amount);
        morpho.supply(params, amount, 0, who, "");
        vm.stopPrank();
    }

    /// @dev A borrower takes `amount` and its collateral then becomes worthless at the
    /// oracle. A liquidator seizes it all and Morpho writes off the debt.
    function badDebt(uint256 amount) external {
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        uint256 liquidity = m.totalSupplyAssets - m.totalBorrowAssets;
        if (liquidity < 4e6) return;
        amount = bound(amount, 1e6, liquidity / 2);

        address b = address(uint160(0xB000 + ++borrowerCount));
        uint256 price = oracle.price();
        uint256 collateral = amount * 1e36 / price * 1e18 / params.lltv + 1e18;
        wsteth.mint(b, collateral);
        vm.startPrank(b);
        wsteth.approve(address(morpho), collateral);
        morpho.supplyCollateral(params, collateral, b, "");
        morpho.borrow(params, amount, 0, b, b);
        vm.stopPrank();

        oracle.setPrice(1);
        address liquidator = makeAddr("liquidator");
        _mint(liquidator, 1e6);
        vm.startPrank(liquidator);
        usd.approve(address(morpho), type(uint256).max);
        MorphoReplay.liquidate(morpho, params, b);
        vm.stopPrank();
        oracle.setPrice(price);
        ++writeOffs;
    }

    /// @dev A borrower opens a healthy position at 50% to 85% of its collateral at the
    /// oracle price now, and keeps it. Addresses grow with the count, so `borrowers`
    /// stays in increasing order.
    function borrow(uint256 amount, uint256 ltvBps) external {
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        uint256 liquidity = m.totalSupplyAssets - m.totalBorrowAssets;
        if (liquidity < 4e6) return;
        amount = bound(amount, 1e6, liquidity / 2);
        ltvBps = bound(ltvBps, 5_000, 8_500);

        address b = address(uint160(0xB000 + ++borrowerCount));
        uint256 collateral = amount * 10_000 / ltvBps * 1e36 / oracle.price() + 1;
        wsteth.mint(b, collateral);
        vm.startPrank(b);
        wsteth.approve(address(morpho), collateral);
        morpho.supplyCollateral(params, collateral, b, "");
        morpho.borrow(params, amount, 0, b, b);
        vm.stopPrank();
        borrowers.push(b);
    }

    /// @dev The issuer moves the oracle to between a tenth of and 1.2 times its start.
    function setPrice(uint256 bps) external {
        oracle.setPrice(basePrice * bound(bps, 1_000, 12_000) / 10_000);
    }

    /// @dev A liquidator clears one of the open borrowers if it is unhealthy, realising
    /// any bad debt.
    function liquidate(uint256 seed) external {
        if (borrowers.length == 0) return;
        address b = borrowers[seed % borrowers.length];
        morpho.accrueInterest(params);
        if (MorphoReplay.isHealthy(morpho, params, b)) return;
        Market memory m = morpho.market(id);
        uint256 debt = SharesMathLib.toAssetsUp(
            morpho.position(id, b).borrowShares, m.totalBorrowAssets, m.totalBorrowShares
        );
        address liquidator = makeAddr("liquidator");
        _mint(liquidator, debt + 1e6);
        vm.startPrank(liquidator);
        usd.approve(address(morpho), type(uint256).max);
        MorphoReplay.liquidate(morpho, params, b);
        vm.stopPrank();
    }

    // ---------------------------------------------------------- policyholders

    function buyPolicy(uint256 seed, uint256 bps, uint256 limit, uint256 deductible) external {
        address who = suppliers[seed % suppliers.length];
        morpho.accrueInterest(params);
        uint256 held = morpho.position(id, who).supplyShares;
        uint256 covered = vault.coveredSharesOf(id, who);
        if (held <= covered) return;
        uint256 shares = (held - covered) * bound(bps, 1, 10_000) / 10_000;
        uint256 available = vault.capacity();
        if (shares == 0 || available < 1e6) return;
        limit = bound(limit, 1e6, available);
        deductible = bound(deductible, 0, 5_000e6);

        uint256 premium = vault.premiumFor(id, limit);
        address buyer = makeAddr("buyer");
        _mint(buyer, premium);
        vm.startPrank(buyer);
        usd.approve(address(vault), premium);
        policyIds.push(vault.buyPolicy(id, who, shares, limit, deductible, new address[](0)));
        vm.stopPrank();
    }

    function claim(uint256 seed) external {
        if (policyIds.length == 0) return;
        uint256 policyId = policyIds[seed % policyIds.length];
        uint256 due = vault.claimable(policyId);
        _see(policyId, due);
        uint256 principal = vault.totalPrincipal();
        try vault.claim(policyId) returns (uint256 paid) {
            if (paid > Math.min(due, principal)) payoutTooLarge = true;
            ++claims;
        } catch (bytes memory reason) {
            _checkRefusal(reason, due, principal);
        }
    }

    /// @dev Claims the unrealised loss over every borrower `borrow` opened, healthy or not.
    function claimShortfall(uint256 seed) external {
        if (policyIds.length == 0) return;
        uint256 policyId = policyIds[seed % policyIds.length];
        address[] memory list = borrowers;
        uint256 due = vault.claimableShortfall(policyId, list);
        _see(policyId, due);
        uint256 principal = vault.totalPrincipal();
        try vault.claimShortfall(policyId, list) returns (uint256 paid) {
            if (paid > Math.min(due, principal)) payoutTooLarge = true;
            ++shortfallClaims;
        } catch (bytes memory reason) {
            _checkRefusal(reason, due, principal);
        }
    }

    function attach(uint256 seed) external {
        if (policyIds.length == 0) return;
        uint256 policyId = policyIds[seed % policyIds.length];
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        if (p.attached || block.timestamp > p.end) return;
        if (block.timestamp < p.attachesAt) vm.warp(p.attachesAt);
        vault.attach(policyId);
    }

    /// @dev Records the most `policyId` has been due: what it has been paid plus what a
    /// claim would pay now.
    function _see(uint256 policyId, uint256 claimable) internal {
        uint256 due = vault.policy(policyId).paid + claimable;
        if (due > maxDueSeen[policyId]) maxDueSeen[policyId] = due;
    }

    /// @dev A claim may refuse only for these reasons, and never with a payable amount on
    /// the table.
    function _checkRefusal(bytes memory reason, uint256 due, uint256 principal) internal view {
        bytes4 sel = bytes4(reason);
        if (
            sel != MorphoCoverVault.NoLoss.selector && sel != MorphoCoverVault.BelowDust.selector
                && sel != MorphoCoverVault.NoFreeCapital.selector
                && sel != MorphoCoverVault.ClaimWindowClosed.selector
                && sel != MorphoCoverVault.NotAttached.selector
        ) {
            revert("unexpected claim revert");
        }
        if (
            sel != MorphoCoverVault.ClaimWindowClosed.selector && due >= vault.dustThreshold()
                && principal > 0
        ) {
            revert("claim refused a payable loss");
        }
    }

    function release(uint256 seed) external {
        if (policyIds.length == 0) return;
        uint256 policyId = policyIds[seed % policyIds.length];
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        if (p.released || block.timestamp <= uint256(p.end) + vault.claimWindow()) return;
        vault.release(policyId);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 10 days));
    }
}
