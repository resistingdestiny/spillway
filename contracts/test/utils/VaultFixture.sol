// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {MockBackstopAdapter} from "../../src/MockBackstopAdapter.sol";
import {CoverVault} from "../../src/CoverVault.sol";

/// @dev Shared setup: a 100k insurance fund, a 250k layer, a 30-day term.
abstract contract VaultFixture is Test {
    uint256 internal constant FUND = 100_000e6;
    uint256 internal constant LIMIT = 250_000e6;
    uint256 internal constant TERM = 30 days;
    uint256 internal constant START = 1_800_000_000;

    MockUSD internal usd;
    MockBackstopAdapter internal adapter;
    CoverVault internal vault;

    address internal sponsor = makeAddr("sponsor");
    address internal runner = makeAddr("runner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        vm.warp(START);
        usd = new MockUSD();
        adapter = new MockBackstopAdapter(usd, 1, address(this));
        vault = new CoverVault(usd, adapter, sponsor, START, START + TERM, LIMIT, FUND);
        adapter.setRunner(runner);
        adapter.setVault(address(vault));

        _mint(address(this), FUND);
        usd.approve(address(adapter), FUND);
        adapter.fundInsurance(FUND);
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

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _mint(who, amount);
        vm.startPrank(who);
        usd.approve(address(vault), amount);
        shares = vault.deposit(amount);
        vm.stopPrank();
    }

    function _fundPremium(uint256 amount) internal {
        _mint(sponsor, amount);
        vm.startPrank(sponsor);
        usd.approve(address(vault), amount);
        vault.fundPremium(amount);
        vm.stopPrank();
    }

    function _badDebt(uint256 amount) internal {
        vm.prank(runner);
        adapter.reportBadDebt(amount);
    }

    function _withdrawAll(address who) internal returns (uint256 assets, uint256 premium) {
        uint256 shares = vault.sharesOf(who);
        vm.prank(who);
        (assets, premium) = vault.withdraw(shares);
    }

    function _warpToEnd() internal {
        vm.warp(START + TERM);
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
