// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IMorpho, Id, MarketParams, Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";
import {ORACLE_PRICE_SCALE} from "morpho-blue/src/libraries/ConstantsLib.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MorphoBalancesLib} from "morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

/// @title MorphoCoverVault
/// @notice Cover for depositors in Morpho Blue markets. Underwriters deposit the loan
/// token and earn premium. A policy covers one holder's supply shares in one listed
/// market. When the market's supply share price falls below its level at inception,
/// anyone can call `claim` and the vault pays the holder the loss on the covered shares,
/// less a deductible, up to the policy limit. No keeper, no vote.
/// @dev The trigger is Morpho's own supply share price, `totalSupplyAssets /
/// totalSupplyShares` with the virtual shares and assets of `SharesMathLib`. Interest
/// only ever raises it. It falls only when `liquidate` writes off bad debt, which anyone
/// can force once a borrower is underwater. Interest earned since inception absorbs a
/// loss first: cover protects the value of the shares on the day it was bought.
///
/// Principal and premium are kept in separate books, as in `CoverVault`. A claim only
/// ever reduces `totalPrincipal`, so premium owed to underwriters never pays a loss.
/// Every policy runs for the same `policyTerm`, so premium streams end in the order they
/// start and a queue is enough to stream them.
contract MorphoCoverVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    /// @notice Fixed-point scale for premium rates and `premiumPerShare`.
    uint256 public constant PRECISION = 1e18;
    /// @notice Scale of `sharePriceOf`: loan token base units per supply share times
    /// 1e36. Supply shares start at 1e6 per base unit, so a fresh market reads 1e30.
    /// For display only. Claims value shares with Morpho's own `toAssetsDown`.
    uint256 public constant PRICE_SCALE = 1e36;
    /// @notice Basis points in one.
    uint256 public constant BPS = 10_000;
    /// @notice Year used to turn an annual premium rate into a premium for one term.
    uint256 public constant YEAR = 365 days;

    // ------------------------------------------------------------------ terms

    /// @notice The loan token of every listed market. Capital, premium and claims are
    /// all paid in it.
    IERC20 public immutable asset;
    /// @notice The Morpho Blue instance whose markets this vault covers.
    IMorpho public immutable morpho;
    /// @notice Length of every policy, in seconds.
    uint256 public immutable policyTerm;
    /// @notice How long after its end a policy can still be claimed, so a loss realised
    /// late in the term has time to be claimed.
    uint256 public immutable claimWindow;
    /// @notice Notice an underwriter must give before withdrawing. Longer than
    /// `claimWindow`, so capital cannot leave between a loss and its claim.
    uint256 public immutable withdrawalNotice;
    /// @notice How long a withdrawal stays open once its notice has run. After that the
    /// underwriter must give notice again, so one request is not a standing exit option.
    uint256 public immutable withdrawalWindow;
    /// @notice Smallest amount a claim pays. Below this a claim reverts.
    uint256 public immutable dustThreshold;

    // ---------------------------------------------------------------- markets

    /// @notice Parameters of every market ever listed, kept after delisting so its
    /// policies can still be claimed.
    mapping(Id id => MarketParams) internal _marketParams;
    /// @notice True while new policies can be bought on the market.
    mapping(Id id => bool) public isListed;
    /// @notice Annual premium on a listed market, in basis points of the policy limit.
    mapping(Id id => uint256) public premiumBps;
    /// @notice Supply shares of `holder` in market `id` already under live policies.
    /// Stops the same shares being covered twice.
    mapping(Id id => mapping(address holder => uint256)) public coveredSharesOf;

    // --------------------------------------------------------------- policies

    struct Policy {
        address holder; // whose Morpho supply is covered, and who is paid
        uint64 start;
        uint64 end;
        bool released; // capacity and covered shares handed back after the claim window
        Id marketId;
        // The market's supply totals at inception. Their ratio, with Morpho's virtual
        // shares and assets, is the start share price, kept exact rather than rounded.
        uint128 startSupplyAssets;
        uint128 startSupplyShares;
        uint256 coveredShares; // Morpho supply shares
        uint256 limit; // most the policy ever pays, in loan token units
        uint256 deductible; // loss the holder keeps before cover pays
        uint256 paid; // paid so far. Claims pay the increase over this.
    }

    /// @notice Number of policies written. Ids run from 1.
    uint256 public policyCount;
    mapping(uint256 policyId => Policy) internal _policies;
    /// @notice Sum of `limit - paid` over policies not yet released. The vault backs
    /// every live limit in full when it sells a policy.
    uint256 public activeLimit;

    // -------------------------------------------------------------- principal

    /// @notice Principal that can pay claims. Falls with claims and withdrawals.
    uint256 public totalPrincipal;
    /// @notice Shares outstanding.
    uint256 public totalShares;
    /// @notice Total paid on claims so far.
    uint256 public paidOut;
    /// @notice Shares held by each underwriter.
    mapping(address account => uint256) public sharesOf;

    struct WithdrawalRequest {
        uint256 shares;
        uint64 readyAt;
    }

    /// @notice Each underwriter's pending withdrawal. One at a time.
    mapping(address account => WithdrawalRequest) public withdrawalRequests;
    /// @notice Shares in pending withdrawal requests. Still at risk, but not sold again.
    uint256 public sharesUnderNotice;

    // ---------------------------------------------------------------- premium

    struct Stream {
        uint64 end;
        uint192 rate; // token units per second, scaled by PRECISION
    }

    /// @notice One premium stream per policy, in the order they end.
    Stream[] internal _streams;
    /// @notice First stream that has not ended yet.
    uint256 public streamHead;
    /// @notice Sum of the rates of streams still running.
    uint256 public premiumRate;
    /// @notice Last time the streams were accrued into `premiumPerShare`.
    uint256 public lastAccrual;
    /// @notice Premium earned per share since inception, scaled by `PRECISION`.
    uint256 public premiumPerShare;
    /// @notice All premium paid in by policyholders.
    uint256 public premiumFunded;
    /// @notice Premium handed to shareholders through the accumulator, scaled.
    uint256 public premiumAllocated;
    /// @notice Premium nobody earned (it streamed while no shares existed, or is
    /// rounding dust), scaled. The owner can sweep it.
    uint256 public premiumUnallocated;
    /// @notice Premium paid out to underwriters.
    uint256 public premiumClaimed;
    /// @notice Unallocated premium swept to the owner.
    uint256 public premiumSwept;
    /// @notice Each account's `premiumPerShare` at its last checkpoint.
    mapping(address account => uint256) public premiumPerSharePaid;
    /// @notice Premium credited to each account and not yet paid.
    mapping(address account => uint256) public accruedPremium;

    // ----------------------------------------------------------------- events

    event MarketListed(
        Id indexed id,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv,
        uint256 premiumBps
    );
    event MarketDelisted(Id indexed id);
    event Deposit(address indexed account, uint256 assets, uint256 shares);
    event WithdrawalRequested(address indexed account, uint256 shares, uint256 readyAt);
    event WithdrawalCancelled(address indexed account, uint256 shares);
    event Withdraw(address indexed account, uint256 shares, uint256 assets, uint256 premium);
    event PremiumClaimed(address indexed account, uint256 amount);
    event UnallocatedPremiumSwept(address indexed to, uint256 amount);
    event PolicyBought(
        uint256 indexed policyId,
        address indexed holder,
        Id indexed marketId,
        address buyer,
        uint256 coveredShares,
        uint256 limit,
        uint256 deductible,
        uint256 startPrice,
        uint256 end,
        uint256 premium
    );
    event Claimed(
        uint256 indexed policyId,
        address indexed holder,
        uint256 sharePrice,
        uint256 loss,
        uint256 amount,
        uint256 paidTotal
    );
    event PolicyReleased(uint256 indexed policyId, uint256 unusedLimit);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error NoticeTooShort(uint256 withdrawalNotice, uint256 claimWindow);
    error LoanTokenMismatch(address loanToken);
    error MarketNotCreated(Id id);
    error MarketNotListed(Id id);
    error InvalidPremiumRate(uint256 premiumBps);
    error SharesNotHeld(uint256 requested, uint256 uncovered);
    error CapacityExceeded(uint256 limit, uint256 available);
    error UnknownPolicy(uint256 policyId);
    error ClaimWindowClosed(uint256 policyId, uint256 closedAt);
    error ClaimWindowOpen(uint256 policyId, uint256 closesAt);
    error AlreadyReleased(uint256 policyId);
    error NoLoss(uint256 policyId);
    error BelowDust(uint256 amount, uint256 dustThreshold);
    error NoFreeCapital();
    error PrincipalWipedOut();
    error ZeroShares();
    error InsufficientShares(uint256 requested, uint256 held);
    error NoWithdrawalRequest();
    error NoticePending(uint256 readyAt);
    error WithdrawalExpired(uint256 expiredAt);
    error BorrowersNotSorted(uint256 index);

    constructor(
        IERC20 asset_,
        IMorpho morpho_,
        address owner_,
        uint256 policyTerm_,
        uint256 claimWindow_,
        uint256 withdrawalNotice_,
        uint256 withdrawalWindow_,
        uint256 dustThreshold_
    ) Ownable(owner_) {
        if (address(asset_) == address(0) || address(morpho_) == address(0)) {
            revert ZeroAddress();
        }
        if (policyTerm_ == 0 || withdrawalWindow_ == 0) revert ZeroAmount();
        if (withdrawalNotice_ <= claimWindow_) {
            revert NoticeTooShort(withdrawalNotice_, claimWindow_);
        }

        asset = asset_;
        morpho = morpho_;
        policyTerm = policyTerm_;
        claimWindow = claimWindow_;
        withdrawalNotice = withdrawalNotice_;
        withdrawalWindow = withdrawalWindow_;
        dustThreshold = dustThreshold_;
        lastAccrual = block.timestamp;
    }

    // -------------------------------------------------------------------- owner

    /// @notice Lists a Morpho market for new policies at `premiumBps` a year, or
    /// changes the rate of a listed one. The market id is the hash of all five
    /// parameters, so listing an id also pins its oracle, IRM and LLTV.
    function listMarket(MarketParams calldata params, uint256 premiumBps_) external onlyOwner {
        if (params.loanToken != address(asset)) revert LoanTokenMismatch(params.loanToken);
        if (premiumBps_ == 0 || premiumBps_ > BPS) revert InvalidPremiumRate(premiumBps_);
        Id id = params.id();
        if (morpho.market(id).lastUpdate == 0) revert MarketNotCreated(id);

        _marketParams[id] = params;
        isListed[id] = true;
        premiumBps[id] = premiumBps_;
        emit MarketListed(
            id, params.collateralToken, params.oracle, params.irm, params.lltv, premiumBps_
        );
    }

    /// @notice Stops new policies on market `id`. Policies already sold stay claimable.
    function delistMarket(Id id) external onlyOwner {
        if (!isListed[id]) revert MarketNotListed(id);
        isListed[id] = false;
        emit MarketDelisted(id);
    }

    /// @notice Sends premium nobody earned to the owner. Anyone can call it.
    /// Returns 0 and does nothing when there is nothing to sweep.
    function sweepUnallocatedPremium() external nonReentrant returns (uint256 amount) {
        _accrue();
        amount = premiumUnallocated / PRECISION;
        if (amount == 0) return 0;
        premiumUnallocated -= amount * PRECISION;
        premiumSwept += amount;
        address to = owner();
        asset.safeTransfer(to, amount);
        emit UnallocatedPremiumSwept(to, amount);
    }

    // -------------------------------------------------------------- underwriters

    /// @notice Deposits `assets` of principal and mints shares at the current
    /// principal per share (1:1 when the vault is empty). Shares are at risk at once.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (totalShares > 0 && totalPrincipal == 0) revert PrincipalWipedOut();

        _checkpoint(msg.sender);
        shares = totalShares == 0 ? assets : Math.mulDiv(assets, totalShares, totalPrincipal);
        if (shares == 0) revert ZeroShares();

        sharesOf[msg.sender] += shares;
        totalShares += shares;
        totalPrincipal += assets;

        asset.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposit(msg.sender, assets, shares);
    }

    /// @notice Gives notice to withdraw `shares`. They stay at risk and keep earning
    /// premium until withdrawn. A new request replaces the old one and restarts the clock.
    function requestWithdrawal(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        uint256 held = sharesOf[msg.sender];
        if (shares > held) revert InsufficientShares(shares, held);

        uint256 readyAt = block.timestamp + withdrawalNotice;
        sharesUnderNotice = sharesUnderNotice - withdrawalRequests[msg.sender].shares + shares;
        withdrawalRequests[msg.sender] = WithdrawalRequest(shares, SafeCast.toUint64(readyAt));
        emit WithdrawalRequested(msg.sender, shares, readyAt);
    }

    /// @notice Withdraws the caller's pending request.
    function cancelWithdrawal() external {
        uint256 shares = withdrawalRequests[msg.sender].shares;
        if (shares == 0) revert NoWithdrawalRequest();
        sharesUnderNotice -= shares;
        delete withdrawalRequests[msg.sender];
        emit WithdrawalCancelled(msg.sender, shares);
    }

    /// @notice Once the notice has run, burns the requested shares for their part of
    /// the principal left after any claims, and pays all of the caller's premium.
    function withdraw() external nonReentrant returns (uint256 assets, uint256 premium) {
        WithdrawalRequest memory request = withdrawalRequests[msg.sender];
        if (request.shares == 0) revert NoWithdrawalRequest();
        if (block.timestamp < request.readyAt) revert NoticePending(request.readyAt);
        uint256 expiresAt = uint256(request.readyAt) + withdrawalWindow;
        if (block.timestamp > expiresAt) revert WithdrawalExpired(expiresAt);

        uint256 shares = request.shares;
        sharesUnderNotice -= shares;
        delete withdrawalRequests[msg.sender];

        _checkpoint(msg.sender);
        assets = Math.mulDiv(shares, totalPrincipal, totalShares);
        sharesOf[msg.sender] -= shares;
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

    // ------------------------------------------------------------ policyholders

    /// @notice Buys a policy on `coveredShares` of `holder`'s supply in market `id`,
    /// for `policyTerm` from now. The caller pays the premium, `premiumFor(id, limit)`,
    /// which streams to underwriters over the term. The share price is read after
    /// accruing interest and recorded as the policy's start price.
    function buyPolicy(
        Id id,
        address holder,
        uint256 coveredShares,
        uint256 limit,
        uint256 deductible
    ) external nonReentrant returns (uint256 policyId) {
        if (!isListed[id]) revert MarketNotListed(id);
        if (holder == address(0)) revert ZeroAddress();
        if (coveredShares == 0 || limit == 0) revert ZeroAmount();

        (uint128 startAssets, uint128 startShares) = _underwrite(id, holder, coveredShares, limit);
        uint256 premium = _startStream(id, limit);

        policyId = ++policyCount;
        _policies[policyId] = Policy({
            holder: holder,
            start: SafeCast.toUint64(block.timestamp),
            end: SafeCast.toUint64(block.timestamp + policyTerm),
            released: false,
            marketId: id,
            coveredShares: coveredShares,
            limit: limit,
            deductible: deductible,
            startSupplyAssets: startAssets,
            startSupplyShares: startShares,
            paid: 0
        });
        coveredSharesOf[id][holder] += coveredShares;
        activeLimit += limit;

        asset.safeTransferFrom(msg.sender, address(this), premium);
        emit PolicyBought(
            policyId,
            holder,
            id,
            msg.sender,
            coveredShares,
            limit,
            deductible,
            sharePriceOf(startAssets, startShares),
            block.timestamp + policyTerm,
            premium
        );
    }

    /// @notice Pays policy `policyId`'s loss to its holder. Anyone can call it, from
    /// the policy's start until `claimWindow` after its end. Accrues interest on Morpho,
    /// reads the supply share price and pays `coveredShares * (startPrice - price)`, less
    /// the deductible, capped by the limit, minus what the policy has already been paid.
    /// The payment is capped again by the vault's free capital. Both prices are applied
    /// as Morpho's `toAssetsDown`, so the loss is the fall in what the shares redeem for.
    /// @dev Covered shares are capped at what the holder still supplies, so a holder who
    /// withdrew before the loss is not paid for it. Claims can repeat as losses grow.
    function claim(uint256 policyId) external nonReentrant returns (uint256 amount) {
        Policy storage p = _policies[policyId];
        if (p.holder == address(0)) revert UnknownPolicy(policyId);
        uint256 closesAt = uint256(p.end) + claimWindow;
        if (block.timestamp > closesAt) revert ClaimWindowClosed(policyId, closesAt);

        morpho.accrueInterest(_marketParams[p.marketId]);
        Market memory m = morpho.market(p.marketId);
        uint256 held = morpho.position(p.marketId, p.holder).supplyShares;
        (uint256 loss, uint256 due) = _due(p, m.totalSupplyAssets, m.totalSupplyShares, held);
        if (due <= p.paid) revert NoLoss(policyId);

        amount = due - p.paid;
        if (amount < dustThreshold) revert BelowDust(amount, dustThreshold);
        amount = Math.min(amount, totalPrincipal);
        if (amount == 0) revert NoFreeCapital();

        p.paid += amount;
        activeLimit -= amount;
        totalPrincipal -= amount;
        paidOut += amount;

        asset.safeTransfer(p.holder, amount);
        emit Claimed(
            policyId,
            p.holder,
            sharePriceOf(m.totalSupplyAssets, m.totalSupplyShares),
            loss,
            amount,
            p.paid
        );
    }

    /// @notice Once a policy's claim window has closed, hands its unused limit back to
    /// capacity and its shares back to the holder's uncovered supply. Anyone can call it.
    function release(uint256 policyId) external {
        Policy storage p = _policies[policyId];
        if (p.holder == address(0)) revert UnknownPolicy(policyId);
        if (p.released) revert AlreadyReleased(policyId);
        uint256 closesAt = uint256(p.end) + claimWindow;
        if (block.timestamp <= closesAt) revert ClaimWindowOpen(policyId, closesAt);

        p.released = true;
        uint256 unused = p.limit - p.paid;
        activeLimit -= unused;
        coveredSharesOf[p.marketId][p.holder] -= p.coveredShares;
        emit PolicyReleased(policyId, unused);
    }

    // -------------------------------------------------------------------- views

    /// @notice Morpho's supply share price for the given totals, scaled by
    /// `PRICE_SCALE`, with the same virtual shares and assets as `SharesMathLib`.
    function sharePriceOf(uint256 totalSupplyAssets, uint256 totalSupplyShares)
        public
        pure
        returns (uint256)
    {
        return Math.mulDiv(
            totalSupplyAssets + SharesMathLib.VIRTUAL_ASSETS,
            PRICE_SCALE,
            totalSupplyShares + SharesMathLib.VIRTUAL_SHARES
        );
    }

    /// @notice Market `id`'s supply share price now, with interest accrued in the view.
    function sharePrice(Id id) public view returns (uint256) {
        (uint256 assets, uint256 shares,,) = morpho.expectedMarketBalances(_marketParams[id]);
        return sharePriceOf(assets, shares);
    }

    /// @notice What `claim(policyId)` would pay right now, before the free capital cap
    /// and the dust threshold. 0 once the claim window has closed.
    function claimable(uint256 policyId) external view returns (uint256) {
        Policy storage p = _policies[policyId];
        if (p.holder == address(0)) return 0;
        if (block.timestamp > uint256(p.end) + claimWindow) return 0;
        uint256 held = morpho.position(p.marketId, p.holder).supplyShares;
        (uint256 assets, uint256 shares,,) =
            morpho.expectedMarketBalances(_marketParams[p.marketId]);
        (, uint256 due) = _due(p, assets, shares, held);
        return due > p.paid ? due - p.paid : 0;
    }

    /// @notice Market `id`'s unrealised shortfall over `borrowers` now, with interest
    /// accrued in the view: each borrower's debt less its collateral at the oracle
    /// price, where positive, summed. `borrowers` must be strictly increasing.
    function marketShortfall(Id id, address[] calldata borrowers) external view returns (uint256) {
        MarketParams memory mp = _marketParams[id];
        if (mp.loanToken == address(0)) revert MarketNotListed(id);
        (,, uint256 borrowAssets, uint256 borrowShares) = morpho.expectedMarketBalances(mp);
        return _shortfall(id, mp.oracle, borrowers, borrowAssets, borrowShares);
    }

    /// @notice Premium for a policy with `limit` on market `id`, rounded up.
    function premiumFor(Id id, uint256 limit) public view returns (uint256) {
        return Math.mulDiv(limit, premiumBps[id] * policyTerm, BPS * YEAR, Math.Rounding.Ceil);
    }

    /// @notice Largest limit a new policy can have now: principal not already backing a
    /// live limit and not under withdrawal notice.
    function capacity() public view returns (uint256) {
        uint256 committed = activeLimit + principalUnderNotice();
        return totalPrincipal > committed ? totalPrincipal - committed : 0;
    }

    /// @notice Principal that can pay claims. Premium is never part of it.
    function freeCapital() external view returns (uint256) {
        return totalPrincipal;
    }

    /// @notice Principal behind shares under withdrawal notice.
    function principalUnderNotice() public view returns (uint256) {
        uint256 shares = totalShares;
        return shares == 0 ? 0 : Math.mulDiv(sharesUnderNotice, totalPrincipal, shares);
    }

    /// @notice `account`'s share of the principal still in the vault.
    function principalOf(address account) external view returns (uint256) {
        uint256 shares = totalShares;
        return shares == 0 ? 0 : Math.mulDiv(sharesOf[account], totalPrincipal, shares);
    }

    /// @notice Policy `policyId`. All fields are zero for an unknown id.
    function policy(uint256 policyId) external view returns (Policy memory) {
        return _policies[policyId];
    }

    /// @notice Parameters of market `id` as listed.
    function marketParams(Id id) external view returns (MarketParams memory) {
        return _marketParams[id];
    }

    /// @notice Premium `account` could claim right now.
    function pendingPremium(address account) external view returns (uint256) {
        uint256 pps = premiumPerShare;
        uint256 shares = totalShares;
        if (shares > 0) {
            uint256 from = lastAccrual;
            uint256 rate = premiumRate;
            uint256 n = _streams.length;
            for (uint256 i = streamHead; i < n && _streams[i].end <= block.timestamp; ++i) {
                pps += rate * (_streams[i].end - from) / shares;
                from = _streams[i].end;
                rate -= _streams[i].rate;
            }
            pps += rate * (block.timestamp - from) / shares;
        }
        uint256 earned = sharesOf[account] * (pps - premiumPerSharePaid[account]) / PRECISION;
        return accruedPremium[account] + earned;
    }

    /// @notice Premium tokens the vault still holds: owed to underwriters, still to
    /// stream, or unallocated. Never available for claims.
    function premiumReserve() public view returns (uint256) {
        return premiumFunded - premiumClaimed - premiumSwept;
    }

    // ----------------------------------------------------------------- internal

    /// @dev Checks a new policy against the holder's uncovered supply and the vault's
    /// capacity, and returns the market's supply totals to record as its start price.
    function _underwrite(Id id, address holder, uint256 coveredShares, uint256 limit)
        internal
        returns (uint128 startAssets, uint128 startShares)
    {
        // Accrue first so the start price carries all interest earned so far, and so
        // the holder's supply shares are final.
        morpho.accrueInterest(_marketParams[id]);

        // A holder who withdrew from Morpho after buying cover can hold fewer shares
        // than are covered. Nothing is uncovered then.
        uint256 held = morpho.position(id, holder).supplyShares;
        uint256 covered = coveredSharesOf[id][holder];
        uint256 uncovered = held > covered ? held - covered : 0;
        if (coveredShares > uncovered) revert SharesNotHeld(coveredShares, uncovered);
        uint256 available = capacity();
        if (limit > available) revert CapacityExceeded(limit, available);

        Market memory m = morpho.market(id);
        (startAssets, startShares) = (m.totalSupplyAssets, m.totalSupplyShares);
    }

    /// @dev Prices a policy with `limit` on market `id` and starts its premium stream
    /// over the term. The part of the premium that does not divide into a whole rate
    /// per second is left unallocated.
    function _startStream(Id id, uint256 limit) internal returns (uint256 premium) {
        _accrue();
        premium = premiumFor(id, limit);
        uint256 rate = premium * PRECISION / policyTerm;
        _streams.push(
            Stream(SafeCast.toUint64(block.timestamp + policyTerm), SafeCast.toUint192(rate))
        );
        premiumRate += rate;
        premiumFunded += premium;
        premiumUnallocated += premium * PRECISION - rate * policyTerm;
    }

    /// @dev The policy's loss on the covered shares the holder still supplies, at the
    /// market's supply totals now, and what the policy owes in total for it. The loss is
    /// what the shares redeemed for at inception less what they redeem for now, both
    /// rounded down as Morpho rounds a withdrawal.
    function _due(Policy storage p, uint256 supplyAssets, uint256 supplyShares, uint256 held)
        internal
        view
        returns (uint256 loss, uint256 due)
    {
        uint256 shares = Math.min(p.coveredShares, held);
        uint256 atStart =
            SharesMathLib.toAssetsDown(shares, p.startSupplyAssets, p.startSupplyShares);
        uint256 atNow = SharesMathLib.toAssetsDown(shares, supplyAssets, supplyShares);
        if (atNow >= atStart) return (0, 0);
        loss = atStart - atNow;
        if (loss <= p.deductible) return (loss, 0);
        due = Math.min(loss - p.deductible, p.limit);
    }

    /// @dev Market `id`'s unrealised shortfall over `borrowers`: the sum, over each
    /// borrower, of its debt less its collateral at the oracle price, where that is
    /// positive. This is the bad debt Morpho would book if the collateral were sold at the
    /// oracle price, and a lower bound on what `liquidate` books, since a liquidator
    /// seizes collateral worth the repaid debt times the incentive. Both sides round
    /// against the claimant: the debt is `toAssetsDown` of the borrow shares (Morpho's
    /// health check rounds it up, against the borrower) and the collateral value is
    /// rounded up. `borrowers` must be strictly increasing, so no position counts twice.
    function _shortfall(
        Id id,
        address oracle,
        address[] calldata borrowers,
        uint256 totalBorrowAssets,
        uint256 totalBorrowShares
    ) internal view returns (uint256 shortfall) {
        if (borrowers.length == 0) return 0;
        uint256 price = IOracle(oracle).price();
        address prev;
        for (uint256 i; i < borrowers.length; ++i) {
            address b = borrowers[i];
            if (b <= prev) revert BorrowersNotSorted(i);
            prev = b;
            Position memory pos = morpho.position(id, b);
            uint256 debt =
                SharesMathLib.toAssetsDown(pos.borrowShares, totalBorrowAssets, totalBorrowShares);
            uint256 value =
                Math.mulDiv(pos.collateral, price, ORACLE_PRICE_SCALE, Math.Rounding.Ceil);
            if (debt > value) shortfall += debt - value;
        }
    }

    /// @dev Moves every premium stream forward to now, retiring streams as they end.
    function _accrue() internal {
        uint256 to = block.timestamp;
        uint256 from = lastAccrual;
        if (to <= from) return;

        uint256 n = _streams.length;
        uint256 head = streamHead;
        while (head < n && _streams[head].end <= to) {
            Stream memory s = _streams[head];
            _allocate(premiumRate * (s.end - from));
            from = s.end;
            premiumRate -= s.rate;
            ++head;
        }
        streamHead = head;
        _allocate(premiumRate * (to - from));
        lastAccrual = to;
    }

    /// @dev Spreads `streamed` (scaled) over the shares outstanding. What does not
    /// divide evenly, or streams while no shares exist, is left unallocated.
    function _allocate(uint256 streamed) internal {
        if (streamed == 0) return;
        uint256 shares = totalShares;
        if (shares == 0) {
            premiumUnallocated += streamed;
            return;
        }
        uint256 perShare = streamed / shares;
        premiumPerShare += perShare;
        premiumAllocated += perShare * shares;
        premiumUnallocated += streamed - perShare * shares;
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
