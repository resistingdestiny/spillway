// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice The interface a Chainlink CRE forwarder calls to deliver a workflow report.
/// Same selector and ERC165 id as `IReceiver` in Chainlink's `KeystoneForwarder`.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice The two claim paths of `MorphoCoverVault`. Both are permissionless and pay the
/// policyholder, never the caller.
interface ICoverClaims {
    function claim(uint256 policyId) external returns (uint256 amount);
    function claimShortfall(uint256 policyId, address[] calldata borrowers)
        external
        returns (uint256 amount);
}

/// @title CoverKeeperReceiver
/// @notice Receives reports from the Spillway keeper workflow on Chainlink CRE and turns
/// each into a claim on `MorphoCoverVault`. A report lists policies with their borrower
/// lists. An empty list calls `claim`, a non-empty one `claimShortfall`.
/// @dev The receiver can only claim, and anyone can claim, so it adds no power a caller
/// does not already have. The checks below keep it to its own workflow anyway: only the
/// forwarder may call `onReport`, and, when set at deploy, only reports from one workflow
/// owner and name. It holds no funds and has no owner. The vault pays the holder.
///
/// One claim that reverts (already paid by someone else, under the dust threshold since
/// the workflow read it) is logged and skipped, so it does not block the others in the
/// same report.
contract CoverKeeperReceiver is IReceiver {
    /// @notice One claim in a report.
    struct Claim {
        uint256 policyId;
        address[] borrowers; // strictly increasing. Empty means `claim`.
    }

    /// @notice Length of the workflow identity at the start of `metadata`:
    /// `bytes32 workflowId, bytes10 workflowName, address workflowOwner`, packed.
    /// `KeystoneForwarder` passes 64 bytes, the last two being the report id.
    uint256 public constant METADATA_LENGTH = 62;

    /// @notice The CRE forwarder allowed to deliver reports.
    address public immutable forwarder;
    /// @notice The cover vault claims are made on.
    ICoverClaims public immutable vault;
    /// @notice Owner of the workflow whose reports are accepted. 0 accepts any, as CRE's
    /// simulation forwarder sends no workflow identity.
    address public immutable workflowOwner;
    /// @notice CRE's 10-byte encoding of the workflow name. 0 accepts any. Names are
    /// unique per owner only, so it is checked only with `workflowOwner`.
    bytes10 public immutable workflowName;

    event ClaimSent(uint256 indexed policyId, bool shortfall, uint256 amount);
    event ClaimFailed(uint256 indexed policyId, bool shortfall, bytes reason);

    error ZeroAddress();
    error NameWithoutOwner();
    error InvalidSender(address sender);
    error MetadataTooShort(uint256 length);
    error InvalidWorkflowOwner(address owner);
    error InvalidWorkflowName(bytes10 name);

    constructor(
        address forwarder_,
        ICoverClaims vault_,
        address workflowOwner_,
        bytes10 workflowName_
    ) {
        if (forwarder_ == address(0) || address(vault_) == address(0)) {
            revert ZeroAddress();
        }
        if (workflowName_ != bytes10(0) && workflowOwner_ == address(0)) revert NameWithoutOwner();
        forwarder = forwarder_;
        vault = vault_;
        workflowOwner = workflowOwner_;
        workflowName = workflowName_;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender);
        if (workflowOwner != address(0)) _checkWorkflow(metadata);

        Claim[] memory claims = abi.decode(report, (Claim[]));
        for (uint256 i; i < claims.length; ++i) {
            _claim(claims[i]);
        }
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev The workflow identity in `metadata` must match the one set at deploy.
    function _checkWorkflow(bytes calldata metadata) internal view {
        if (metadata.length < METADATA_LENGTH) revert MetadataTooShort(metadata.length);
        address owner = address(bytes20(metadata[42:62]));
        if (owner != workflowOwner) revert InvalidWorkflowOwner(owner);
        bytes10 name = bytes10(metadata[32:42]);
        if (workflowName != bytes10(0) && name != workflowName) revert InvalidWorkflowName(name);
    }

    function _claim(Claim memory c) internal {
        bool shortfall = c.borrowers.length > 0;
        if (shortfall) {
            try vault.claimShortfall(c.policyId, c.borrowers) returns (uint256 amount) {
                emit ClaimSent(c.policyId, true, amount);
            } catch (bytes memory reason) {
                emit ClaimFailed(c.policyId, true, reason);
            }
        } else {
            try vault.claim(c.policyId) returns (uint256 amount) {
                emit ClaimSent(c.policyId, false, amount);
            } catch (bytes memory reason) {
                emit ClaimFailed(c.policyId, false, reason);
            }
        }
    }
}
