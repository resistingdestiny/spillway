// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockBackstopAdapter} from "../src/MockBackstopAdapter.sol";

contract MockBackstopAdapterTest is Test {
    MockUSD internal usd;
    MockBackstopAdapter internal adapter;

    address internal owner = makeAddr("owner");
    address internal runner = makeAddr("runner");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usd = new MockUSD();
        adapter = new MockBackstopAdapter(usd, 1, owner);
        vm.startPrank(owner);
        adapter.setRunner(runner);
        // The test contract plays the vault so it can call receiveCover directly.
        adapter.setVault(address(this));
        vm.stopPrank();

        usd.mint(address(this), 100_000e6);
        usd.approve(address(adapter), type(uint256).max);
        adapter.fundInsurance(100_000e6);
    }

    function test_fundInsurancePullsTokens() public view {
        assertEq(adapter.insuranceFund(), 100_000e6);
        assertEq(usd.balanceOf(address(adapter)), 100_000e6);
        assertEq(adapter.asset(), address(usd));
        assertEq(adapter.perpId(), 1);
    }

    function test_badDebtWithinFundIsPaidByFund() public {
        vm.expectEmit(address(adapter));
        emit MockBackstopAdapter.InsuranceDraw(40_000e6, 60_000e6);
        vm.prank(runner);
        adapter.reportBadDebt(40_000e6);

        assertEq(adapter.insuranceFund(), 60_000e6);
        assertEq(adapter.pendingShortfall(), 0);
        assertEq(adapter.badDebtTotal(), 40_000e6);
        assertEq(adapter.fundPaid(), 40_000e6);
    }

    function test_badDebtBeyondFundBecomesShortfall() public {
        vm.expectEmit(address(adapter));
        emit MockBackstopAdapter.InsuranceDraw(100_000e6, 0);
        vm.expectEmit(address(adapter));
        emit MockBackstopAdapter.Shortfall(30_000e6, 30_000e6);
        vm.prank(runner);
        adapter.reportBadDebt(130_000e6);

        assertEq(adapter.insuranceFund(), 0);
        assertEq(adapter.pendingShortfall(), 30_000e6);
        assertEq(adapter.fundPaid(), 100_000e6);
        assertEq(adapter.badDebtTotal(), 130_000e6);
    }

    function test_onlyRunnerReportsAndFinalizes() public {
        vm.startPrank(stranger);
        vm.expectRevert(MockBackstopAdapter.NotRunner.selector);
        adapter.reportBadDebt(1e6);
        vm.expectRevert(MockBackstopAdapter.NotRunner.selector);
        adapter.finalizeShortfall();
        vm.stopPrank();
    }

    function test_onlyOwnerSetsRunner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        adapter.setRunner(stranger);
    }

    function test_vaultIsSetOnce() public {
        vm.prank(owner);
        vm.expectRevert(MockBackstopAdapter.VaultAlreadySet.selector);
        adapter.setVault(stranger);
    }

    function test_receiveCoverReducesShortfall() public {
        vm.prank(runner);
        adapter.reportBadDebt(130_000e6);

        usd.mint(address(this), 20_000e6);
        assertTrue(usd.transfer(address(adapter), 20_000e6));
        vm.expectEmit(address(adapter));
        emit MockBackstopAdapter.CoverReceived(address(this), 20_000e6, 10_000e6);
        adapter.receiveCover(20_000e6);

        assertEq(adapter.pendingShortfall(), 10_000e6);
        assertEq(adapter.layerPaid(), 20_000e6);
    }

    function test_receiveCoverOnlyFromVault() public {
        vm.prank(runner);
        adapter.reportBadDebt(130_000e6);
        vm.prank(stranger);
        vm.expectRevert(MockBackstopAdapter.NotVault.selector);
        adapter.receiveCover(1e6);
    }

    function test_receiveCoverAboveShortfallReverts() public {
        vm.prank(runner);
        adapter.reportBadDebt(110_000e6);
        usd.mint(address(this), 20_000e6);
        assertTrue(usd.transfer(address(adapter), 20_000e6));
        vm.expectRevert(
            abi.encodeWithSelector(
                MockBackstopAdapter.CoverExceedsShortfall.selector, 20_000e6, 10_000e6
            )
        );
        adapter.receiveCover(20_000e6);
    }

    function test_receiveCoverWithoutTokensReverts() public {
        vm.prank(runner);
        adapter.reportBadDebt(130_000e6);
        vm.expectRevert(MockBackstopAdapter.CoverNotTransferred.selector);
        adapter.receiveCover(10_000e6);
    }

    function test_finalizeBooksRestAsAdl() public {
        vm.prank(runner);
        adapter.reportBadDebt(130_000e6);

        vm.expectEmit(address(adapter));
        emit MockBackstopAdapter.AutoDeleverage(30_000e6, 30_000e6);
        vm.prank(runner);
        adapter.finalizeShortfall();

        assertEq(adapter.pendingShortfall(), 0);
        assertEq(adapter.adlLoss(), 30_000e6);
        // The three counters add up to all bad debt.
        assertEq(
            adapter.fundPaid() + adapter.layerPaid() + adapter.adlLoss(), adapter.badDebtTotal()
        );
    }

    function test_finalizeWithNoShortfallIsNoop() public {
        vm.recordLogs();
        vm.prank(runner);
        adapter.finalizeShortfall();
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(adapter.adlLoss(), 0);
    }
}
