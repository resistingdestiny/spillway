// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {CoverKeeperReceiver, ICoverClaims} from "../../src/lending/CoverKeeperReceiver.sol";

/// @dev The part of Chainlink's MockKeystoneForwarder this test calls. It is the
/// forwarder `cre workflow simulate --broadcast` delivers through, and it checks no
/// signatures.
interface IMockKeystoneForwarder {
    event ReportProcessed(
        address indexed receiver,
        bytes32 indexed workflowExecutionId,
        bytes2 indexed reportId,
        bool result
    );

    function typeAndVersion() external view returns (string memory);
    function report(
        address receiver,
        bytes calldata rawReport,
        bytes calldata reportContext,
        bytes[] calldata signatures
    ) external;
}

/// @dev The keeper's write path on a fork of Monad testnet: the deployed vault, Morpho
/// Blue and oracle, and Chainlink's MockKeystoneForwarder at its Monad testnet address.
/// A receiver is deployed on the fork only, the oracle is marked down again so policy 1 is
/// owed more, and the report the workflow would send is delivered through the forwarder.
/// Nothing is broadcast.
///
/// Skipped unless MONAD_FORK=1, so `forge test` stays offline:
///   MONAD_FORK=1 forge test --match-path test/lending/CoverKeeperReceiver.fork.t.sol -vv
contract CoverKeeperReceiverForkTest is Test {
    /// @dev A further markdown of the collateral, on top of the replay's 25%.
    uint256 internal constant DROP_BPS = 1000;

    MorphoCoverVault internal vault;
    MockOracle internal oracle;
    IERC20 internal usd;
    IMockKeystoneForwarder internal forwarder;
    CoverKeeperReceiver internal receiver;
    address[] internal borrowers;
    uint256 internal policyId;

    function setUp() public {
        if (!vm.envOr("MONAD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("monad_testnet");
        assertEq(block.chainid, 10143);

        string memory deployment = vm.readFile("deployments/monad-testnet-lending.json");
        string memory config = vm.readFile("../cre/keeper/config.json");
        vault = MorphoCoverVault(vm.parseJsonAddress(deployment, ".contracts.vault"));
        oracle = MockOracle(vm.parseJsonAddress(deployment, ".contracts.oracle"));
        usd = IERC20(vm.parseJsonAddress(deployment, ".contracts.usd"));
        borrowers = vm.parseJsonAddressArray(deployment, ".borrowers");
        policyId = vm.parseJsonUint(deployment, ".policy.id");
        forwarder = IMockKeystoneForwarder(vm.parseJsonAddress(config, ".forwarders.simulation"));
        assertEq(vm.parseJsonAddress(config, ".vault"), address(vault));

        receiver = new CoverKeeperReceiver(
            address(forwarder), ICoverClaims(address(vault)), address(0), bytes10(0)
        );
    }

    /// @dev The report as CRE delivers it: the 109-byte header of `KeystoneForwarder`
    /// (version, execution id, timestamp, DON id and config version, workflow id, name,
    /// owner, report id), then the payload the workflow encodes, `abi.encode(Claim[])`.
    function _rawReport(bytes32 executionId) internal view returns (bytes memory) {
        CoverKeeperReceiver.Claim[] memory claims = new CoverKeeperReceiver.Claim[](1);
        claims[0] = CoverKeeperReceiver.Claim(policyId, borrowers);
        return abi.encodePacked(
            uint8(1),
            executionId,
            uint32(block.timestamp),
            uint32(1),
            uint32(1),
            bytes32(0),
            bytes10(0),
            address(0),
            bytes2(0x0001),
            abi.encode(claims)
        );
    }

    function test_theSimulationForwarderIsLiveOnMonadTestnet() public view {
        assertEq(forwarder.typeAndVersion(), "MockKeystoneForwarder 1.0.0");
        assertEq(borrowers.length, 17);
    }

    function test_asDeployedNothingIsDueAndAReportPaysNothing() public {
        uint256 dust = vault.dustThreshold();
        assertLt(vault.claimableShortfall(policyId, borrowers), dust);
        assertLt(vault.claimable(policyId), dust);

        address holder = vault.policy(policyId).holder;
        uint256 before = usd.balanceOf(holder);
        bytes32 executionId = keccak256("nothing-due");
        vm.expectEmit(address(forwarder));
        emit IMockKeystoneForwarder.ReportProcessed(address(receiver), executionId, 0x0001, true);
        forwarder.report(address(receiver), _rawReport(executionId), "", new bytes[](0));
        assertEq(usd.balanceOf(holder), before);
    }

    function test_aFurtherMarkdownIsClaimedThroughTheForwarder() public {
        uint256 price = oracle.price() * (10_000 - DROP_BPS) / 10_000;
        vm.prank(oracle.owner());
        oracle.setPrice(price);
        uint256 due = vault.claimableShortfall(policyId, borrowers);
        assertGe(due, vault.dustThreshold());
        assertLe(due, vault.totalPrincipal());

        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        uint256 before = usd.balanceOf(p.holder);
        bytes32 executionId = keccak256("markdown");
        bytes memory raw = _rawReport(executionId);

        // The simulation forwarder checks no signatures, so anyone can deliver through it.
        // The receiver can only claim, and the vault pays the holder.
        vm.expectEmit(address(receiver));
        emit CoverKeeperReceiver.ClaimSent(policyId, true, due);
        vm.expectEmit(address(forwarder));
        emit IMockKeystoneForwarder.ReportProcessed(address(receiver), executionId, 0x0001, true);
        vm.prank(makeAddr("anyone"));
        forwarder.report(address(receiver), raw, "", new bytes[](0));

        assertEq(usd.balanceOf(p.holder), before + due);
        assertEq(vault.policy(policyId).paid, p.paid + due);
        assertLt(vault.claimableShortfall(policyId, borrowers), vault.dustThreshold());
        emit log_named_decimal_uint("paid to the holder, tUSD", due, 6);
    }
}
