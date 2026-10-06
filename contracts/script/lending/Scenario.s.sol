// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho, Id, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "./MorphoReplay.sol";

/// @title Scenario
/// @notice Replay, step two. Breaks the collateral, clears the book and claims. Moves
/// the market's MockOracle down by `DROP_BPS`, liquidates every unhealthy borrower as a
/// funded liquidator, then calls `claim` on the policy SeedMarket bought. Prints the bad
/// debt Morpho wrote off, the holder's loss and what the cover paid.
/// @dev Reads the state file SeedMarket wrote. The broadcaster must own the oracle (it
/// does if it ran SeedMarket). It funds the liquidations from the tUSD faucet. Anyone
/// could call `claim`; here the broadcaster does.
///
/// Settings come from the environment.
///   REPLAY_STATE  SeedMarket's state file    default replay/state-<chain id>.json
///   DROP_BPS      oracle move, in bps down   default 3000 (30%)
contract Scenario is Script {
    struct State {
        IMorpho morpho;
        MorphoCoverVault vault;
        MarketParams params;
        Id id;
        address holder;
        uint256 policyId;
        address[] borrowers;
    }

    struct Result {
        uint256 oldPrice;
        uint256 newPrice;
        uint256 badDebt;
        uint256 liquidated;
        uint256 repaid;
        uint256 holderLoss;
        uint256 claimable;
        uint256 paid;
    }

    function run() external returns (Result memory r) {
        State memory s = _load(
            vm.envOr(
                "REPLAY_STATE", string.concat("replay/state-", vm.toString(block.chainid), ".json")
            )
        );
        uint256 dropBps = vm.envOr("DROP_BPS", uint256(3000));
        require(dropBps < 10_000, "DROP_BPS must be under 10000");

        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        uint256 valueBefore = _assetsOf(s, s.holder);

        MockOracle oracle = MockOracle(s.params.oracle);
        r.oldPrice = oracle.price();
        r.newPrice = r.oldPrice * (10_000 - dropBps) / 10_000;
        oracle.setPrice(r.newPrice);

        _liquidateAll(s, me, r);

        uint256 valueAfter = _assetsOf(s, s.holder);
        r.holderLoss = valueBefore > valueAfter ? valueBefore - valueAfter : 0;
        r.claimable = s.vault.claimable(s.policyId);
        if (r.claimable >= s.vault.dustThreshold() && s.vault.totalPrincipal() > 0) {
            r.paid = s.vault.claim(s.policyId);
        }
        vm.stopBroadcast();

        console.log("oracle price  ", r.oldPrice, "->", r.newPrice);
        console.log("liquidated    ", r.liquidated, "of", s.borrowers.length);
        console.log("repaid        ", r.repaid);
        console.log("bad debt      ", r.badDebt);
        console.log("holder loss   ", r.holderLoss);
        console.log("claimable     ", r.claimable);
        console.log("cover paid    ", r.paid);
    }

    /// @dev Funds the liquidator with the market's whole debt at most, then liquidates
    /// every borrower that is unhealthy at the new price.
    function _liquidateAll(State memory s, address me, Result memory r) internal {
        MockUSD usd = MockUSD(s.params.loanToken);
        uint256 debt = s.morpho.market(s.id).totalBorrowAssets;
        uint256 balance = usd.balanceOf(me);
        if (balance < debt) _mint(usd, me, debt - balance);
        usd.approve(address(s.morpho), type(uint256).max);

        for (uint256 i; i < s.borrowers.length; ++i) {
            (uint256 repaid, uint256 badDebt) =
                MorphoReplay.liquidate(s.morpho, s.params, s.borrowers[i]);
            if (repaid == 0 && badDebt == 0) continue;
            ++r.liquidated;
            r.repaid += repaid;
            r.badDebt += badDebt;
        }
    }

    function _load(string memory path) internal view returns (State memory s) {
        string memory json = vm.readFile(path);
        s.morpho = IMorpho(vm.parseJsonAddress(json, ".morpho"));
        s.vault = MorphoCoverVault(vm.parseJsonAddress(json, ".vault"));
        s.params = MarketParams({
            loanToken: vm.parseJsonAddress(json, ".loanToken"),
            collateralToken: vm.parseJsonAddress(json, ".collateralToken"),
            oracle: vm.parseJsonAddress(json, ".oracle"),
            irm: vm.parseJsonAddress(json, ".irm"),
            lltv: vm.parseJsonUint(json, ".lltv")
        });
        s.id = Id.wrap(vm.parseJsonBytes32(json, ".marketId"));
        s.holder = vm.parseJsonAddress(json, ".holder");
        s.policyId = vm.parseJsonUint(json, ".policyId");
        s.borrowers = vm.parseJsonAddressArray(json, ".borrowers");
    }

    /// @dev What `who`'s supply redeems for now, after accruing interest.
    function _assetsOf(State memory s, address who) internal returns (uint256) {
        s.morpho.accrueInterest(s.params);
        Market memory m = s.morpho.market(s.id);
        return SharesMathLib.toAssetsDown(
            s.morpho.position(s.id, who).supplyShares, m.totalSupplyAssets, m.totalSupplyShares
        );
    }

    /// @dev The faucet caps each call, so mint in chunks.
    function _mint(MockUSD usd, address to, uint256 amount) internal {
        uint256 cap = usd.MAX_MINT();
        while (amount > 0) {
            uint256 chunk = amount > cap ? cap : amount;
            usd.mint(to, chunk);
            amount -= chunk;
        }
    }
}
