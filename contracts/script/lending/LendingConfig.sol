// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LendingConfig
/// @notice Every assumption the lending scripts and tests make, in one place.
/// @dev Values marked "Morpho docs" come from docs.morpho.org or the morpho-blue source.
/// Values marked "snapshot" come from fixtures/morpho/monad-2026-10-06.json (Monad
/// mainnet, block 111058609). Values marked "assumption" are our judgement and are the
/// levers to argue about. Change them here, never inline. Scripts can override most of
/// them from the environment.
library LendingConfig {
    // ------------------------------------------------------- Morpho on mainnet

    /// @dev Morpho docs (addresses page): Morpho Blue on Monad mainnet, chain 143. The
    /// same page lists no Monad testnet deployment, and chain 10143 has no code at this
    /// address, so the testnet replay deploys its own Morpho Blue.
    address internal constant MORPHO_MONAD_MAINNET = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
    /// @dev Morpho docs: AdaptiveCurveIrm on Monad mainnet. Every listed market in the
    /// snapshot uses it.
    address internal constant ADAPTIVE_CURVE_IRM_MONAD_MAINNET =
        0x09475a3D6eA8c314c592b1a3799bDE044E2F400F;

    // -------------------------------------------------- our Morpho on testnet

    /// @dev Snapshot: every LLTV used by a Monad mainnet market (77%, 86%, 91.5%,
    /// 94.5%, 96.5%, 98%). Our deployment enables all of them so any market can be copied.
    function lltvs() internal pure returns (uint256[6] memory) {
        return [uint256(0.77e18), 0.86e18, 0.915e18, 0.945e18, 0.965e18, 0.98e18];
    }

    /// @dev Assumption: a fixed 5% a year borrow rate (per second, scaled by 1e18,
    /// simple interest, Morpho compounds it). Mainnet's AdaptiveCurveIrm starts at 4% and
    /// moves with utilisation. A replay lasts minutes, so the rate barely matters.
    uint256 internal constant BORROW_RATE_PER_SECOND = uint256(0.05e18) / 365 days;

    // --------------------------------------------------------------- the cover

    /// @dev Assumption: policies run 30 days, the same term as the Perpl layer.
    uint256 internal constant POLICY_TERM = 30 days;
    /// @dev Assumption: cover attaches two days after purchase. In the incidents in
    /// docs/RESEARCH.md the loss reached lenders within days of the first news (Stream's
    /// loss on 4 Nov 2025, Elixir shut on 6 Nov), so a buyer who reads the news cannot
    /// cover the markdown that follows. Two days of a 30-day term is the cost to an
    /// honest buyer. The replay deploys with 0, since it runs in minutes.
    uint256 internal constant WAITING_PERIOD = 2 days;
    /// @dev Assumption: a policy can be claimed for one day after it ends. Claims are
    /// permissionless and the trigger is on chain, so a day is ample for anyone to call.
    uint256 internal constant CLAIM_WINDOW = 1 days;
    /// @dev Assumption: three days' notice to withdraw, longer than the claim window as
    /// docs/LENDING.md requires.
    uint256 internal constant WITHDRAWAL_NOTICE = 3 days;
    /// @dev Assumption: a withdrawal stays open for two days once its notice has run.
    uint256 internal constant WITHDRAWAL_WINDOW = 2 days;
    /// @dev Assumption: claims under one dollar (six-decimal loan token) are not paid.
    uint256 internal constant DUST_THRESHOLD = 1e6;
    /// @dev Assumption: 2% a year of the limit, a placeholder for a replay book with no
    /// `premiumBps` of its own. The engine prices each market from its scenarios
    /// (docs/LENDING.md, "Premium") and writes the rate into the book.
    uint256 internal constant PREMIUM_BPS = 200;

    // ------------------------------------------------------------- the replay

    /// @dev Assumption: the test collateral copies wstETH, 18 decimals.
    uint8 internal constant COLLATERAL_DECIMALS = 18;
    /// @dev Assumption: the faucet cap for test collateral, one billion tokens a call.
    /// The seed script mints whatever the positions need.
    uint256 internal constant COLLATERAL_MAX_MINT = 1e9 * 1e18;
    /// @dev Morpho docs: oracles quote one base unit of collateral in base units of the
    /// loan token, scaled by 1e36.
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
}
