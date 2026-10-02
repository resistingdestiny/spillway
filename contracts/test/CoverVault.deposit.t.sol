// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {CoverVault} from "../src/CoverVault.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockBackstopAdapter} from "../src/MockBackstopAdapter.sol";

/// @dev Deposits, the capacity cap, the lock and share pricing.
contract CoverVaultDepositTest is VaultFixture {
    function test_constructorWiring() public view {
        assertEq(address(vault.asset()), address(usd));
        assertEq(address(vault.adapter()), address(adapter));
        assertEq(vault.sponsor(), sponsor);
        assertEq(vault.termStart(), START);
        assertEq(vault.termEnd(), START + TERM);
        assertEq(vault.limit(), LIMIT);
        assertEq(vault.attachmentHint(), FUND);
        assertEq(vault.remainingLimit(), LIMIT);
        assertEq(vault.availableCapacity(), LIMIT);
        assertTrue(vault.isCoverActive());
    }

    function test_constructorRejectsBadTerm() public {
        vm.expectRevert(CoverVault.InvalidTerm.selector);
        new CoverVault(usd, adapter, sponsor, START, START, LIMIT, FUND);
    }

    function test_constructorRejectsAssetMismatch() public {
        MockUSD other = new MockUSD();
        vm.expectRevert(CoverVault.AssetMismatch.selector);
        new CoverVault(IERC20(address(other)), adapter, sponsor, START, START + TERM, LIMIT, FUND);
    }

    function test_firstDepositMintsOneToOne() public {
        _mint(alice, 50_000e6);
        vm.startPrank(alice);
        usd.approve(address(vault), 50_000e6);
        vm.expectEmit(address(vault));
        emit CoverVault.Deposit(alice, 50_000e6, 50_000e6);
        uint256 shares = vault.deposit(50_000e6);
        vm.stopPrank();

        assertEq(shares, 50_000e6);
        assertEq(vault.sharesOf(alice), 50_000e6);
        assertEq(vault.totalShares(), 50_000e6);
        assertEq(vault.totalPrincipal(), 50_000e6);
        assertEq(vault.principalOf(alice), 50_000e6);
        assertEq(vault.availableCapacity(), LIMIT - 50_000e6);
        assertEq(usd.balanceOf(address(vault)), 50_000e6);
    }

    function test_depositCapIsRemainingLimit() public {
        _deposit(alice, 200_000e6);

        _mint(bob, 60_000e6);
        vm.startPrank(bob);
        usd.approve(address(vault), 60_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(CoverVault.CapacityExceeded.selector, 60_000e6, 50_000e6)
        );
        vault.deposit(60_000e6);
        vm.stopPrank();

        // Exactly the remaining capacity fits.
        _deposit(bob, 50_000e6);
        assertEq(vault.totalPrincipal(), LIMIT);
        assertEq(vault.availableCapacity(), 0);
    }

    function test_capacityStaysAlignedAfterPayout() public {
        _deposit(alice, 200_000e6);
        _badDebt(FUND + 30_000e6);
        vault.settle();

        // Principal fell by 30k and so did the remaining limit, so room is unchanged.
        assertEq(vault.totalPrincipal(), 170_000e6);
        assertEq(vault.remainingLimit(), 220_000e6);
        assertEq(vault.availableCapacity(), 50_000e6);
    }

    function test_depositAfterTermEndReverts() public {
        _warpToEnd();
        _mint(alice, 1e6);
        vm.startPrank(alice);
        usd.approve(address(vault), 1e6);
        vm.expectRevert(CoverVault.TermOver.selector);
        vault.deposit(1e6);
        vm.stopPrank();
        assertEq(vault.availableCapacity(), 0);
    }

    function test_zeroDepositReverts() public {
        vm.prank(alice);
        vm.expectRevert(CoverVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_withdrawBeforeExpiryReverts() public {
        _deposit(alice, 10_000e6);
        vm.warp(START + TERM - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CoverVault.Locked.selector, START + TERM));
        vault.withdraw(10_000e6);
    }

    function test_withdrawMoreThanHeldReverts() public {
        _deposit(alice, 10_000e6);
        _warpToEnd();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CoverVault.InsufficientShares.selector, 10_001e6, 10_000e6)
        );
        vault.withdraw(10_001e6);
    }

    function test_depositAfterPartialLossPricesShares() public {
        _deposit(alice, 100_000e6);
        _badDebt(FUND + 50_000e6);
        vault.settle();
        assertEq(vault.principalOf(alice), 50_000e6);

        // Principal per share is now 0.5, so 50k buys 100k shares.
        uint256 bobShares = _deposit(bob, 50_000e6);
        assertEq(bobShares, 100_000e6);
        assertEq(vault.principalOf(bob), 50_000e6);

        _warpToEnd();
        (uint256 a,) = _withdrawAll(alice);
        (uint256 b,) = _withdrawAll(bob);
        assertEq(a, 50_000e6);
        assertEq(b, 50_000e6);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalPrincipal(), 0);
    }

    function test_depositBlockedWhenLayerExhausted() public {
        _deposit(alice, LIMIT);
        _badDebt(FUND + LIMIT);
        vault.settle();
        assertEq(vault.remainingLimit(), 0);

        _mint(bob, 1e6);
        vm.startPrank(bob);
        usd.approve(address(vault), 1e6);
        vm.expectRevert(CoverVault.LayerExhausted.selector);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    function test_depositBlockedWhenPrincipalWipedOut() public {
        // Only 100k deposited against a 250k limit, then a 180k shortfall.
        _deposit(alice, 100_000e6);
        _badDebt(FUND + 180_000e6);
        vault.settle();
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.remainingLimit(), 150_000e6);
        assertEq(vault.availableCapacity(), 0);

        _mint(bob, 1e6);
        vm.startPrank(bob);
        usd.approve(address(vault), 1e6);
        vm.expectRevert(CoverVault.PrincipalWipedOut.selector);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    function test_withdrawAfterEndReturnsPrincipal() public {
        _deposit(alice, 40_000e6);
        _deposit(bob, 60_000e6);
        _warpToEnd();

        vm.expectEmit(address(vault));
        emit CoverVault.Withdraw(alice, 40_000e6, 40_000e6, 0);
        (uint256 assets,) = _withdrawAll(alice);
        assertEq(assets, 40_000e6);
        assertEq(usd.balanceOf(alice), 40_000e6);
        assertEq(vault.sharesOf(alice), 0);
        assertEq(vault.totalPrincipal(), 60_000e6);
    }

    function test_depositBeforeTermStartIsAllowed() public {
        MockBackstopAdapter a2 = new MockBackstopAdapter(usd, 1, address(this));
        CoverVault later =
            new CoverVault(usd, a2, sponsor, START + 1 days, START + 31 days, LIMIT, 0);
        assertFalse(later.isCoverActive());

        _mint(alice, 1_000e6);
        vm.startPrank(alice);
        usd.approve(address(later), 1_000e6);
        later.deposit(1_000e6);
        vm.stopPrank();
        assertEq(later.totalPrincipal(), 1_000e6);
    }
}
