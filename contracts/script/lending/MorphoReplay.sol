// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IMorpho, Id, MarketParams, Market, Position} from "morpho-blue/src/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/src/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {MathLib, WAD} from "morpho-blue/src/libraries/MathLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {
    ORACLE_PRICE_SCALE,
    LIQUIDATION_CURSOR,
    MAX_LIQUIDATION_INCENTIVE_FACTOR
} from "morpho-blue/src/libraries/ConstantsLib.sol";
import {FixedRateIrm} from "../../src/lending/FixedRateIrm.sol";
import {LendingConfig} from "./LendingConfig.sol";

/// @title MorphoReplay
/// @notice What the tests and the replay scripts share: deploying Morpho Blue, reading a
/// position's health and liquidating it the way a liquidator would.
/// @dev Morpho Blue is built with its own solc (0.8.19), so it is deployed from its
/// artifact. The health check and the liquidation sizing copy `Morpho.sol` line for
/// line, rounding included, so a liquidation never reverts on a rounding edge.
library MorphoReplay {
    using MathLib for uint256;
    using SharesMathLib for uint256;
    using MarketParamsLib for MarketParams;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Deploys Morpho Blue owned by `owner`, plus a FixedRateIrm, and enables
    /// that IRM and every LLTV in the config. `owner` must be the caller (or the
    /// broadcaster) so it can enable them.
    function deployMorpho(address owner) internal returns (IMorpho morpho, FixedRateIrm irm) {
        morpho = IMorpho(VM.deployCode("Morpho.sol:Morpho", abi.encode(owner)));
        irm = new FixedRateIrm(LendingConfig.BORROW_RATE_PER_SECOND);
        morpho.enableIrm(address(irm));
        uint256[6] memory lltvs = LendingConfig.lltvs();
        for (uint256 i; i < lltvs.length; ++i) {
            morpho.enableLltv(lltvs[i]);
        }
    }

    /// @notice Morpho's liquidation incentive factor for `lltv`, scaled by 1e18:
    /// `min(1.15, 1 / (1 - 0.3 * (1 - lltv)))`.
    function liquidationIncentiveFactor(uint256 lltv) internal pure returns (uint256) {
        uint256 lif = WAD.wDivDown(WAD - LIQUIDATION_CURSOR.wMulDown(WAD - lltv));
        return lif < MAX_LIQUIDATION_INCENTIVE_FACTOR ? lif : MAX_LIQUIDATION_INCENTIVE_FACTOR;
    }

    /// @notice Whether `borrower` is healthy at the oracle's price, as Morpho decides it.
    /// Uses the stored totals, so accrue interest first.
    function isHealthy(IMorpho morpho, MarketParams memory params, address borrower)
        internal
        view
        returns (bool)
    {
        Id id = params.id();
        Position memory pos = morpho.position(id, borrower);
        if (pos.borrowShares == 0) return true;
        Market memory m = morpho.market(id);
        uint256 borrowed =
            uint256(pos.borrowShares).toAssetsUp(m.totalBorrowAssets, m.totalBorrowShares);
        uint256 allowed = uint256(pos.collateral)
            .mulDivDown(IOracle(params.oracle).price(), ORACLE_PRICE_SCALE).wMulDown(params.lltv);
        return allowed >= borrowed;
    }

    /// @notice Most `borrower` can borrow against `collateral` at the oracle's price,
    /// less two units so Morpho's upward rounding of the debt still passes.
    function maxBorrow(MarketParams memory params, uint256 collateral)
        internal
        view
        returns (uint256)
    {
        uint256 max = collateral.mulDivDown(IOracle(params.oracle).price(), ORACLE_PRICE_SCALE)
            .wMulDown(params.lltv);
        return max > 2 ? max - 2 : 0;
    }

    /// @notice Liquidates `borrower` in full if it is unhealthy. The caller is the
    /// liquidator and must have approved Morpho for the loan token. If the collateral is
    /// worth less than the debt times the incentive, it seizes all of it and Morpho writes
    /// off the rest as bad debt. Otherwise it repays all the debt and the borrower keeps
    /// the change.
    /// @return repaid Loan tokens the liquidator paid.
    /// @return badDebt Fall in the market's total supply assets: the loss to suppliers.
    function liquidate(IMorpho morpho, MarketParams memory params, address borrower)
        internal
        returns (uint256 repaid, uint256 badDebt)
    {
        morpho.accrueInterest(params);
        if (isHealthy(morpho, params, borrower)) return (0, 0);

        Id id = params.id();
        Position memory pos = morpho.position(id, borrower);
        Market memory m = morpho.market(id);
        uint256 lif = liquidationIncentiveFactor(params.lltv);
        uint256 price = IOracle(params.oracle).price();

        // The shares Morpho would repay for all the collateral, rounded as it rounds.
        uint256 sharesForAll = uint256(pos.collateral).mulDivUp(price, ORACLE_PRICE_SCALE)
            .wDivUp(lif).toSharesUp(m.totalBorrowAssets, m.totalBorrowShares);

        uint256 supplyBefore = m.totalSupplyAssets;
        if (sharesForAll <= pos.borrowShares) {
            (, repaid) = morpho.liquidate(params, borrower, pos.collateral, 0, "");
        } else {
            (, repaid) = morpho.liquidate(params, borrower, 0, pos.borrowShares, "");
        }
        badDebt = supplyBefore - morpho.market(id).totalSupplyAssets;
    }
}
