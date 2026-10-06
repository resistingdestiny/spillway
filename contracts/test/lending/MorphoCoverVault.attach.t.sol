// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev Adverse selection: the waiting period before cover attaches, and the
/// purchase-time health check. This suite runs with the config's waiting period.
contract MorphoCoverVaultAttachTest is MorphoFixture {
    uint256 internal constant WAIT = LendingConfig.WAITING_PERIOD;
    address internal constant B1 = address(0xB1);
    address internal constant B2 = address(0xB2);

    uint256 internal holderShares;

    function _waitingPeriod() internal pure override returns (uint256) {
        return WAIT;
    }

    function setUp() public override {
        super.setUp();
        holderShares = _supply(holder, 1_000_000e6);
        _supply(otherSupplier, 1_000_000e6);
        _deposit(alice, 2_000_000e6);
        // B1 borrows at 85% of its collateral at $4,000, B2 at 40%.
        _borrow(B1, 300e18, 1_020_000e6);
        _borrow(B2, 100e18, 160_000e6);
    }

    function _list(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        (l[0], l[1]) = (a, b);
    }

    // ------------------------------------------------------------ waiting period

    function test_claimsWaitForCoverToAttach() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        assertFalse(p.attached);
        assertEq(p.attachesAt, block.timestamp + WAIT);

        _drop(2500);
        assertEq(vault.claimableShortfall(policyId, _list(B1)), 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NotAttached.selector, policyId));
        vault.claimShortfall(policyId, _list(B1));
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NotAttached.selector, policyId));
        vault.claim(policyId);

        vm.warp(p.attachesAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoCoverVault.WaitingPeriodRunning.selector, policyId, p.attachesAt
            )
        );
        vault.attach(policyId);
    }

    function test_attachRecordsTheStartPriceThen() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        vm.warp(block.timestamp + WAIT);

        vm.expectEmit(true, false, false, false, address(vault));
        emit MorphoCoverVault.PolicyAttached(policyId, 0);
        vm.prank(makeAddr("stranger"));
        vault.attach(policyId);

        // The start price is the one at attachment, with two days of interest in it.
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        assertTrue(p.attached);
        assertEq(p.startSupplyAssets, morpho.market(id).totalSupplyAssets);
        assertEq(_startPrice(policyId), _price());
        assertGt(p.startSupplyAssets, 2_000_000e6);

        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.AlreadyAttached.selector, policyId));
        vault.attach(policyId);
    }

    function test_aLossRealisedDuringTheWaitingPeriodIsNotCovered() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        // Bad debt lands a day after the sale, inside the waiting period.
        vm.warp(block.timestamp + 1 days);
        _badDebtOf(100_000e6);

        vm.warp(block.timestamp + WAIT);
        vault.attach(policyId);
        assertEq(vault.claimable(policyId), 0);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId));
        vault.claim(policyId);

        // A loss after attachment is covered.
        _badDebtOf(100_000e6);
        uint256 loss = _lossSince(policyId, holderShares);
        assertGt(loss, 49_000e6);
        assertEq(vault.claim(policyId), loss);
    }

    function test_attachClosesWhenThePolicyEnds() public {
        uint256 policyId = _buy(holder, holderShares, 500_000e6, 0);
        uint256 end = vault.policy(policyId).end;
        vm.warp(end + 1);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoCoverVault.AttachWindowClosed.selector, policyId, end)
        );
        vault.attach(policyId);

        // An unattached policy is still released after its claim window.
        vm.warp(end + LendingConfig.CLAIM_WINDOW + 1);
        vault.release(policyId);
        assertEq(vault.activeLimit(), 0);
    }

    // ------------------------------------------------------------ health check

    function test_cannotBuyWhileAListedBorrowerIsUnhealthy() public {
        // Healthy borrowers pass, and so does an address with no position.
        _buy(holder, holderShares / 2, 100_000e6, 0, _list(B1, B2));
        _buy(holder, holderShares / 4, 100_000e6, 0, _list(alice));

        _drop(2500);
        uint256 premium = vault.premiumFor(id, 100_000e6);
        _mint(buyer, premium);
        vm.startPrank(buyer);
        usd.approve(address(vault), premium);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.UnhealthyBorrower.selector, B1));
        vault.buyPolicy(id, holder, holderShares / 4, 100_000e6, 0, _list(B2, B1));
        // B2 alone is still healthy at $3,000, so a list without B1 passes: the check is
        // only as complete as the list.
        vault.buyPolicy(id, holder, holderShares / 4, 100_000e6, 0, _list(B2));
        vm.stopPrank();
    }

    function test_healthCheckUsesMorphosRuleAtTheBoundary() public {
        // A borrower at exactly the most Morpho lets it borrow is healthy. One unit of
        // interest later it is not.
        address edge = address(0xE0);
        uint256 collateral = 10e18;
        uint256 max = collateral * PRICE / 1e36 * LLTV / 1e18;
        _borrow(edge, collateral, max);
        _buy(holder, holderShares / 2, 100_000e6, 0, _list(edge));

        vm.warp(block.timestamp + 1 hours);
        uint256 premium = vault.premiumFor(id, 100_000e6);
        _mint(buyer, premium);
        vm.startPrank(buyer);
        usd.approve(address(vault), premium);
        vm.expectRevert(abi.encodeWithSelector(MorphoCoverVault.UnhealthyBorrower.selector, edge));
        vault.buyPolicy(id, holder, holderShares / 2, 100_000e6, 0, _list(edge));
        vm.stopPrank();
    }
}
