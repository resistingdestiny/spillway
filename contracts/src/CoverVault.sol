// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBackstopAdapter} from "./interfaces/IBackstopAdapter.sol";

/// @title CoverVault
/// @notice One excess-of-loss layer that sits between a perp market's insurance fund
/// and auto-deleveraging. Capital providers deposit the collateral token and get
/// shares. The sponsor (the exchange) pays a premium that streams to shareholders over
/// a fixed term. If the insurance fund runs dry, anyone can call `settle()` and the
/// vault pays the next slice of loss, up to its limit. After the term ends, holders
/// withdraw their share of what is left plus any unclaimed premium.
/// @dev Principal and premium are kept in separate books. A payout only ever reduces
/// `totalPrincipal`, so premium owed to holders can never be used to pay a loss.
/// Shares are internal balances and cannot be transferred.
contract CoverVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Fixed-point scale for `premiumRate` and `premiumPerShare`.
    uint256 public constant PRECISION = 1e18;

    // ------------------------------------------------------------------ terms

    /// @notice Collateral token. Principal and premium are both paid in it.
    IERC20 public immutable asset;
    /// @notice The market this layer protects.
    IBackstopAdapter public immutable adapter;
    /// @notice Who pays the premium (the exchange). Gets unearned premium back.
    address public immutable sponsor;
    /// @notice Cover and premium start here (unix seconds).
    uint256 public immutable termStart;
    /// @notice Cover and premium stop here. Withdrawals open here.
    uint256 public immutable termEnd;
    /// @notice Most this layer will ever pay out, over the whole term.
    uint256 public immutable limit;
    /// @notice Insurance fund balance at inception. For display only: the layer
    /// attaches once the fund is gone, wherever it stands then.
    uint256 public immutable attachmentHint;

    // -------------------------------------------------------------- principal

    /// @notice Principal still at risk. Falls with payouts and withdrawals.
    uint256 public totalPrincipal;
    /// @notice Shares outstanding.
    uint256 public totalShares;
    /// @notice Total paid to the adapter so far. Never exceeds `limit`.
    uint256 public paidOut;
    /// @notice Shares held by each account.
    mapping(address account => uint256) public sharesOf;

    // ---------------------------------------------------------------- premium

    /// @notice Premium streaming per second, in token units scaled by `PRECISION`.
    uint256 public premiumRate;
    /// @notice Last time the stream was accrued into `premiumPerShare`.
    uint256 public lastAccrual;
    /// @notice Premium earned per share since inception, scaled by `PRECISION`.
    uint256 public premiumPerShare;
    /// @notice All premium the sponsor has paid in.
    uint256 public premiumFunded;
    /// @notice Premium handed to shareholders through the accumulator, scaled by
    /// `PRECISION`. Premium that streamed while nobody held shares is not in here.
    uint256 public premiumAllocated;
    /// @notice Premium paid out to holders.
    uint256 public premiumClaimed;
    /// @notice Unearned premium returned to the sponsor.
    uint256 public premiumSwept;
    /// @notice Each account's `premiumPerShare` at its last checkpoint.
    mapping(address account => uint256) public premiumPerSharePaid;
    /// @notice Premium credited to each account and not yet paid.
    mapping(address account => uint256) public accruedPremium;

    // ----------------------------------------------------------------- events

    event Deposit(address indexed account, uint256 assets, uint256 shares);
    event Withdraw(address indexed account, uint256 shares, uint256 assets, uint256 premium);
    event PremiumFunded(address indexed sponsor, uint256 amount, uint256 premiumRate);
    event PremiumClaimed(address indexed account, uint256 amount);
    event UnearnedPremiumSwept(address indexed sponsor, uint256 amount);
    event LayerPayout(uint256 shortfall, uint256 paid, uint256 remainingLimit);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error InvalidTerm();
    error AssetMismatch();
    error NotSponsor();
    error TermOver();
    error Locked(uint256 termEnd);
    error LayerExhausted();
    error PrincipalWipedOut();
    error ShortfallPending(uint256 pendingShortfall);
    error CapacityExceeded(uint256 assets, uint256 available);
    error ZeroShares();
    error InsufficientShares(uint256 requested, uint256 held);

    constructor(
        IERC20 asset_,
        IBackstopAdapter adapter_,
        address sponsor_,
        uint256 termStart_,
        uint256 termEnd_,
        uint256 limit_,
        uint256 attachmentHint_
    ) {
        if (address(asset_) == address(0) || address(adapter_) == address(0)) {
            revert ZeroAddress();
        }
        if (sponsor_ == address(0)) revert ZeroAddress();
        if (termEnd_ <= termStart_) revert InvalidTerm();
        if (limit_ == 0) revert ZeroAmount();
        if (adapter_.asset() != address(asset_)) revert AssetMismatch();

        asset = asset_;
        adapter = adapter_;
        sponsor = sponsor_;
        termStart = termStart_;
        termEnd = termEnd_;
        limit = limit_;
        attachmentHint = attachmentHint_;
        lastAccrual = termStart_;
    }

    // ------------------------------------------------------- capital providers

    /// @notice Deposits `assets` of principal and mints shares at the current
    /// principal per share (1:1 when the vault is empty).
    /// @dev Capacity is capped so principal never exceeds what the layer can still
    /// lose. Open until `termEnd`. Money is locked until `termEnd`. Closed while the
    /// adapter has a pending shortfall, so nobody joins a layer that already owes
    /// money. It reopens once `settle()` (or the runner's `finalizeShortfall`) clears it.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (block.timestamp >= termEnd) revert TermOver();
        if (remainingLimit() == 0) revert LayerExhausted();
        if (totalShares > 0 && totalPrincipal == 0) revert PrincipalWipedOut();
        uint256 pending = adapter.pendingShortfall();
        if (pending > 0) revert ShortfallPending(pending);
        uint256 available = remainingLimit() - totalPrincipal;
        if (assets > available) revert CapacityExceeded(assets, available);

        _checkpoint(msg.sender);
        shares = totalShares == 0 ? assets : Math.mulDiv(assets, totalShares, totalPrincipal);
        if (shares == 0) revert ZeroShares();

        sharesOf[msg.sender] += shares;
        totalShares += shares;
        totalPrincipal += assets;

        asset.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposit(msg.sender, assets, shares);
    }

    /// @notice After `termEnd`, burns `shares` for their part of the remaining
    /// principal and pays all of the caller's unclaimed premium.
    function withdraw(uint256 shares)
        external
        nonReentrant
        returns (uint256 assets, uint256 premium)
    {
        if (block.timestamp < termEnd) revert Locked(termEnd);
        if (shares == 0) revert ZeroAmount();
        uint256 held = sharesOf[msg.sender];
        if (shares > held) revert InsufficientShares(shares, held);

        _checkpoint(msg.sender);
        assets = Math.mulDiv(shares, totalPrincipal, totalShares);
        sharesOf[msg.sender] = held - shares;
        totalShares -= shares;
        totalPrincipal -= assets;

        premium = accruedPremium[msg.sender];
        if (premium > 0) {
            accruedPremium[msg.sender] = 0;
            premiumClaimed += premium;
        }

        if (assets + premium > 0) asset.safeTransfer(msg.sender, assets + premium);
        emit Withdraw(msg.sender, shares, assets, premium);
    }

    /// @notice Pays the caller's premium earned so far. Works at any time.
    /// Returns 0 and does nothing when there is nothing to pay.
    function claimPremium() external nonReentrant returns (uint256 amount) {
        _checkpoint(msg.sender);
        amount = accruedPremium[msg.sender];
        if (amount == 0) return 0;
        accruedPremium[msg.sender] = 0;
        premiumClaimed += amount;
        asset.safeTransfer(msg.sender, amount);
        emit PremiumClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ sponsor

    /// @notice Adds `amount` of premium. It streams evenly from now (or from
    /// `termStart` if that is later) to `termEnd`. Anything not yet streamed from
    /// earlier funding is spread over the same window.
    function fundPremium(uint256 amount) external nonReentrant {
        if (msg.sender != sponsor) revert NotSponsor();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= termEnd) revert TermOver();

        _accrue();
        uint256 start = block.timestamp > termStart ? block.timestamp : termStart;
        uint256 window = termEnd - start;
        uint256 unstreamed = premiumRate * window;
        premiumRate = (unstreamed + amount * PRECISION) / window;
        premiumFunded += amount;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit PremiumFunded(msg.sender, amount, premiumRate);
    }

    /// @notice After `termEnd`, returns premium that nobody earned (it streamed
    /// while the vault held no shares, plus rounding dust) to the sponsor.
    /// Anyone can call it. Returns 0 and does nothing when there is nothing to sweep.
    function sweepUnearnedPremium() external nonReentrant returns (uint256 amount) {
        if (block.timestamp < termEnd) revert Locked(termEnd);
        _accrue();
        amount = premiumFunded - premiumAllocated / PRECISION - premiumSwept;
        if (amount == 0) return 0;
        premiumSwept += amount;
        asset.safeTransfer(sponsor, amount);
        emit UnearnedPremiumSwept(sponsor, amount);
    }

    // ------------------------------------------------------------------- payout

    /// @notice Pays the adapter's pending shortfall, up to the remaining limit and
    /// the principal on hand. Anyone can call it. Cover runs from `termStart` to
    /// `termEnd`. Outside that window, or with nothing to pay, it does nothing.
    function settle() external nonReentrant returns (uint256 paid) {
        if (block.timestamp < termStart || block.timestamp >= termEnd) return 0;

        uint256 shortfall = adapter.pendingShortfall();
        paid = Math.min(shortfall, Math.min(remainingLimit(), totalPrincipal));
        if (paid == 0) return 0;

        paidOut += paid;
        totalPrincipal -= paid;

        asset.safeTransfer(address(adapter), paid);
        adapter.receiveCover(paid);
        emit LayerPayout(shortfall, paid, limit - paidOut);
    }

    // -------------------------------------------------------------------- views

    /// @notice How much more this layer can pay out over its life.
    function remainingLimit() public view returns (uint256) {
        return limit - paidOut;
    }

    /// @notice How much can be deposited right now. 0 when deposits are closed.
    function availableCapacity() external view returns (uint256) {
        if (block.timestamp >= termEnd) return 0;
        if (totalShares > 0 && totalPrincipal == 0) return 0;
        if (adapter.pendingShortfall() > 0) return 0;
        uint256 remaining = remainingLimit();
        return remaining > totalPrincipal ? remaining - totalPrincipal : 0;
    }

    /// @notice True while the layer is on risk.
    function isCoverActive() external view returns (bool) {
        return block.timestamp >= termStart && block.timestamp < termEnd;
    }

    /// @notice `account`'s share of the principal still in the vault.
    function principalOf(address account) external view returns (uint256) {
        uint256 shares = totalShares;
        return shares == 0 ? 0 : Math.mulDiv(sharesOf[account], totalPrincipal, shares);
    }

    /// @notice Premium `account` could claim right now.
    function pendingPremium(address account) external view returns (uint256) {
        uint256 pps = premiumPerShare;
        uint256 to = Math.min(block.timestamp, termEnd);
        uint256 shares = totalShares;
        if (to > lastAccrual && shares > 0) pps += premiumRate * (to - lastAccrual) / shares;
        uint256 earned = sharesOf[account] * (pps - premiumPerSharePaid[account]) / PRECISION;
        return accruedPremium[account] + earned;
    }

    /// @notice Premium tokens the vault still holds: owed to holders, still to
    /// stream, or unearned and waiting to be swept. Never available for payouts.
    function premiumReserve() public view returns (uint256) {
        return premiumFunded - premiumClaimed - premiumSwept;
    }

    // ----------------------------------------------------------------- internal

    /// @dev Moves the premium stream forward to now (capped at `termEnd`). While no
    /// shares exist, the streamed premium is left unallocated for the sponsor.
    function _accrue() internal {
        uint256 to = Math.min(block.timestamp, termEnd);
        uint256 from = lastAccrual;
        if (to <= from) return;
        lastAccrual = to;

        uint256 shares = totalShares;
        if (shares == 0) return;
        uint256 perShare = premiumRate * (to - from) / shares;
        premiumPerShare += perShare;
        premiumAllocated += perShare * shares;
    }

    /// @dev Credits `account` with premium earned on its current shares.
    function _checkpoint(address account) internal {
        _accrue();
        uint256 pps = premiumPerShare;
        uint256 paid = premiumPerSharePaid[account];
        if (pps == paid) return;
        accruedPremium[account] += sharesOf[account] * (pps - paid) / PRECISION;
        premiumPerSharePaid[account] = pps;
    }
}
