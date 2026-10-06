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
/// Then seeds the book again and runs the depeg with nobody liquidating, and the
/// unrealised claim.
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
        // The annual rate comes from the book, not the config's placeholder.
        assertEq(vault.premiumBps(id), 300);
        assertTrue(vault.premiumBps(id) != LendingConfig.PREMIUM_BPS);
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

        // The same book again, as a second market with its own oracle, marked down the
        // same way. This time nobody liquidates, as when the collateral cannot be sold.
        // Run in this test, not another, because the scripts read process-wide settings.
        vm.setEnv("MODE", "unrealised");
        (Id id2, uint256 policy2) = new SeedMarket().run();
        Scenario.Result memory u = new Scenario().run();
        vm.setEnv("MODE", "liquidate");
        assertTrue(Id.unwrap(id2) != Id.unwrap(id));

        // Three borrowers are unhealthy. At $3,000 the first is 120k short and the second
        // 50k. The third's collateral still covers its debt, so it adds nothing.
        assertEq(u.liquidated, 0);
        assertEq(u.badDebt, 0);
        assertEq(u.unhealthy, 3);
        assertApproxEqAbs(u.shortfall, 170_000e6, 2);
        // The holder's Morpho balance has not moved, and the cover pays half the
        // shortfall, the holder's share of the supply.
        assertEq(u.holderLoss, 0);
        assertApproxEqAbs(u.paid, u.shortfall / 2, 1);
        assertEq(u.paid, u.claimable);
        assertEq(vault.policy(policy2).paid, u.paid);
    }
}
