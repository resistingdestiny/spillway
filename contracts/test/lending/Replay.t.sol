// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IMorpho, Id} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {FixedRateIrm} from "../../src/lending/FixedRateIrm.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {DeployLending} from "../../script/lending/DeployLending.s.sol";
import {SeedMarket} from "../../script/lending/SeedMarket.s.sol";
import {Scenario} from "../../script/lending/Scenario.s.sol";
import {LendingConfig} from "../../script/lending/LendingConfig.sol";

/// @dev Runs the three lending scripts in memory, in order, on replay/example.json:
/// deploy, seed the book and buy cover, then a 25% depeg, liquidations and the claim.
contract ReplayTest is Test {
    function test_deploySeedAndScenario() public {
        // A replay runs in minutes, so its vault attaches cover at purchase.
        vm.setEnv("WAITING_PERIOD", "0");
        (IMorpho morpho, FixedRateIrm irm, MockUSD usd, MorphoCoverVault vault) =
            new DeployLending().run();
        assertTrue(morpho.isIrmEnabled(address(irm)));
        assertEq(vault.owner(), morpho.owner());
        assertEq(address(vault.asset()), address(usd));
        assertEq(vault.policyTerm(), LendingConfig.POLICY_TERM);
        assertEq(vault.waitingPeriod(), 0);
        assertGt(vault.withdrawalNotice(), vault.claimWindow());

        vm.setEnv("MORPHO", vm.toString(address(morpho)));
        vm.setEnv("IRM", vm.toString(address(irm)));
        vm.setEnv("USD", vm.toString(address(usd)));
        vm.setEnv("VAULT", vm.toString(address(vault)));
        vm.setEnv("REPLAY_JSON", "replay/example.json");
        vm.setEnv("REPLAY_STATE", "replay/state-test.json");
        vm.setEnv("DROP_BPS", "2500");

        (Id id, uint256 policyId) = new SeedMarket().run();
        assertTrue(vault.isListed(id));
        // The holder is supplier 0, with 1.5M of the book's 3M.
        MorphoCoverVault.Policy memory p = vault.policy(policyId);
        assertEq(p.limit, 1_500_000e6);
        assertEq(morpho.market(id).totalSupplyAssets, 3_000_000e6);
        assertEq(morpho.market(id).totalBorrowAssets, 2_580_000e6);

        Scenario.Result memory r = new Scenario().run();
        // Two of the four borrowers go under water at $3,000, a third is liquidated
        // with change to spare, the fourth stays healthy. The same book as the flow test.
        assertEq(r.liquidated, 3);
        assertApproxEqRel(r.badDebt, 238_000e6, 0.01e18);
        // No deductible and a limit above the loss: the cover pays the holder's loss in
        // full, which is half the bad debt.
        assertEq(r.paid, r.holderLoss);
        assertEq(r.paid, r.claimable);
        assertApproxEqAbs(r.holderLoss, r.badDebt / 2, 1);
        assertEq(vault.policy(policyId).paid, r.paid);
        assertLt(r.newPrice, r.oldPrice);
    }
}
