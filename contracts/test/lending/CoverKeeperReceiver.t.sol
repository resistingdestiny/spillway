// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MorphoFixture} from "../utils/MorphoFixture.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {
    CoverKeeperReceiver,
    ICoverClaims,
    IReceiver
} from "../../src/lending/CoverKeeperReceiver.sol";

/// @dev Delivers reports the way Chainlink's `KeystoneForwarder.report` does, without the
/// signature check: a 109-byte header, of which bytes 45 to 109 reach the receiver as
/// `metadata`, then the workflow's payload as `report`. Returns whether `onReport`
/// succeeded, as the forwarder records it, instead of reverting.
contract TestForwarder {
    function deliver(
        address receiver,
        bytes32 workflowId,
        bytes10 name,
        address owner,
        bytes memory payload
    ) external returns (bool ok) {
        bytes memory raw = abi.encodePacked(
            uint8(1), // version
            bytes32(uint256(0xe0)), // workflow execution id
            uint32(1_800_000_000), // timestamp
            uint32(1), // DON id
            uint32(1), // DON config version
            workflowId,
            name,
            owner,
            bytes2(0x0001), // report id
            payload
        );
        try this.route(receiver, raw) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// @dev A call to itself, as the forwarder's `report` calls its `route`, so the slices
    /// are taken from calldata.
    function route(address receiver, bytes calldata raw) external {
        IReceiver(receiver).onReport(raw[45:109], raw[109:]);
    }
}

/// @dev The keeper's receiver on a local Morpho Blue: reports from the forwarder become
/// claims that pay exactly what the vault previews, nobody else can deliver one, and the
/// workflow identity is checked when set.
contract CoverKeeperReceiverTest is MorphoFixture {
    uint256 internal constant SUPPLY = 1_000_000e6;
    uint256 internal constant CAPITAL = 2_000_000e6;
    uint256 internal constant LIMIT = 1_000_000e6;

    address internal constant B1 = address(0xB1);
    address internal constant B2 = address(0xB2);

    bytes32 internal constant WORKFLOW_ID = keccak256("workflow");
    // CRE's encoding of the name "my_workflow", from Chainlink's consumer contract guide.
    bytes10 internal constant NAME = 0x62373666336165316465;
    address internal workflowOwner = makeAddr("workflow-owner");

    TestForwarder internal forwarder;
    CoverKeeperReceiver internal receiver;
    uint256 internal holderShares;

    function setUp() public override {
        super.setUp();
        holderShares = _supply(holder, SUPPLY);
        _supply(otherSupplier, SUPPLY);
        _deposit(alice, CAPITAL);
        // At $4,000: B1 borrows at 85% of its collateral, B2 at 40%.
        _borrow(B1, 300e18, 1_020_000e6);
        _borrow(B2, 100e18, 160_000e6);
        forwarder = new TestForwarder();
        receiver = _receiver(address(0), bytes10(0));
    }

    function _receiver(address owner_, bytes10 name_) internal returns (CoverKeeperReceiver) {
        return
            new CoverKeeperReceiver(address(forwarder), ICoverClaims(address(vault)), owner_, name_);
    }

    function _list(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        (l[0], l[1]) = (a, b);
    }

    function _one(uint256 policyId, address[] memory borrowers)
        internal
        pure
        returns (bytes memory)
    {
        CoverKeeperReceiver.Claim[] memory claims = new CoverKeeperReceiver.Claim[](1);
        claims[0] = CoverKeeperReceiver.Claim(policyId, borrowers);
        return abi.encode(claims);
    }

    function _deliver(CoverKeeperReceiver r, bytes memory payload) internal returns (bool) {
        return forwarder.deliver(address(r), WORKFLOW_ID, bytes10(0), address(0), payload);
    }

    // ------------------------------------------------------------- the claims

    function test_aShortfallReportPaysWhatTheVaultPreviews() public {
        uint256 policyId = _buy(holder, holderShares, LIMIT, 0);
        _drop(2500);
        address[] memory borrowers = _list(B1, B2);
        uint256 due = vault.claimableShortfall(policyId, borrowers);
        assertEq(due, 59_999_999_999);

        vm.expectEmit(address(receiver));
        emit CoverKeeperReceiver.ClaimSent(policyId, true, due);
        assertTrue(_deliver(receiver, _one(policyId, borrowers)));

        assertEq(usd.balanceOf(holder), due);
        assertEq(usd.balanceOf(address(receiver)), 0);
        assertEq(vault.policy(policyId).paid, due);
        assertEq(vault.claimableShortfall(policyId, borrowers), 0);
    }

    function test_anEmptyBorrowerListClaimsTheRealisedLoss() public {
        uint256 policyId = _buy(holder, holderShares, LIMIT, 0);
        _drop(2500);
        _liquidate(B1);
        uint256 due = vault.claimable(policyId);
        assertGt(due, 0);

        vm.expectEmit(address(receiver));
        emit CoverKeeperReceiver.ClaimSent(policyId, false, due);
        assertTrue(_deliver(receiver, _one(policyId, new address[](0))));
        assertEq(usd.balanceOf(holder), due);
    }

    function test_aStaleClaimIsLoggedAndTheRestArePaid() public {
        uint256 first = _buy(holder, holderShares / 2, LIMIT / 2, 0);
        uint256 second = _buy(holder, holderShares / 2, LIMIT / 2, 0);
        _drop(2500);
        address[] memory borrowers = _list(B1, B2);
        // Someone claims the first policy before the report lands.
        vault.claimShortfall(first, borrowers);
        uint256 due = vault.claimableShortfall(second, borrowers);

        CoverKeeperReceiver.Claim[] memory claims = new CoverKeeperReceiver.Claim[](2);
        claims[0] = CoverKeeperReceiver.Claim(first, borrowers);
        claims[1] = CoverKeeperReceiver.Claim(second, borrowers);
        bytes memory noLoss = abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, first);
        vm.expectEmit(address(receiver));
        emit CoverKeeperReceiver.ClaimFailed(first, true, noLoss);
        vm.expectEmit(address(receiver));
        emit CoverKeeperReceiver.ClaimSent(second, true, due);
        assertTrue(_deliver(receiver, abi.encode(claims)));
        assertEq(vault.policy(second).paid, due);
    }

    function test_nothingDueChangesNothing() public {
        uint256 policyId = _buy(holder, holderShares, LIMIT, 0);
        bytes memory noLoss = abi.encodeWithSelector(MorphoCoverVault.NoLoss.selector, policyId);
        vm.expectEmit(address(receiver));
        emit CoverKeeperReceiver.ClaimFailed(policyId, true, noLoss);
        assertTrue(_deliver(receiver, _one(policyId, _list(B1, B2))));
        assertEq(usd.balanceOf(holder), 0);
        assertEq(vault.totalPrincipal(), CAPITAL);
    }

    // ------------------------------------------------------------ the callers

    function test_onlyTheForwarderCanDeliver() public {
        uint256 policyId = _buy(holder, holderShares, LIMIT, 0);
        _drop(2500);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(CoverKeeperReceiver.InvalidSender.selector, stranger)
        );
        receiver.onReport("", _one(policyId, _list(B1, B2)));
        assertEq(usd.balanceOf(holder), 0);
    }

    function test_theWorkflowIdentityIsCheckedWhenSet() public {
        CoverKeeperReceiver strict = _receiver(workflowOwner, NAME);
        uint256 policyId = _buy(holder, holderShares, LIMIT, 0);
        _drop(2500);
        bytes memory payload = _one(policyId, _list(B1, B2));

        // CRE's simulation forwarder sends no identity, so a strict receiver refuses it.
        assertFalse(_deliver(strict, payload));
        assertFalse(forwarder.deliver(address(strict), WORKFLOW_ID, NAME, bob, payload));
        assertFalse(
            forwarder.deliver(
                address(strict), WORKFLOW_ID, bytes10("other-name"), workflowOwner, payload
            )
        );
        assertEq(usd.balanceOf(holder), 0);

        assertTrue(forwarder.deliver(address(strict), WORKFLOW_ID, NAME, workflowOwner, payload));
        assertEq(usd.balanceOf(holder), 59_999_999_999);
    }

    function test_anOwnerWithoutANameAcceptsAnyNameFromThatOwner() public {
        CoverKeeperReceiver byOwner = _receiver(workflowOwner, bytes10(0));
        uint256 policyId = _buy(holder, holderShares, LIMIT, 0);
        _drop(2500);
        bytes memory payload = _one(policyId, _list(B1, B2));
        assertFalse(forwarder.deliver(address(byOwner), WORKFLOW_ID, NAME, bob, payload));
        assertTrue(
            forwarder.deliver(address(byOwner), WORKFLOW_ID, bytes10("any"), workflowOwner, payload)
        );
    }

    function test_shortMetadataIsRefused() public {
        CoverKeeperReceiver strict = _receiver(workflowOwner, NAME);
        vm.prank(address(forwarder));
        vm.expectRevert(abi.encodeWithSelector(CoverKeeperReceiver.MetadataTooShort.selector, 61));
        strict.onReport(new bytes(61), abi.encode(new CoverKeeperReceiver.Claim[](0)));
    }

    // ----------------------------------------------------------- construction

    function test_constructorRefusesZeroAddressesAndANameWithoutOwner() public {
        ICoverClaims v = ICoverClaims(address(vault));
        vm.expectRevert(CoverKeeperReceiver.ZeroAddress.selector);
        new CoverKeeperReceiver(address(0), v, address(0), bytes10(0));
        vm.expectRevert(CoverKeeperReceiver.ZeroAddress.selector);
        new CoverKeeperReceiver(
            address(forwarder), ICoverClaims(address(0)), address(0), bytes10(0)
        );
        vm.expectRevert(CoverKeeperReceiver.NameWithoutOwner.selector);
        new CoverKeeperReceiver(address(forwarder), v, address(0), NAME);
    }

    function test_supportsTheReceiverInterfaceForTheForwarderCheck() public view {
        // The forwarder checks this through ERC165 before it delivers anything.
        assertEq(type(IReceiver).interfaceId, bytes4(keccak256("onReport(bytes,bytes)")));
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId));
        assertFalse(receiver.supportsInterface(0xffffffff));
    }
}
