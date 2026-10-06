// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {FixedRateIrm} from "../../src/lending/FixedRateIrm.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "./MorphoReplay.sol";
import {LendingConfig} from "./LendingConfig.sol";

/// @title DeployLending
/// @notice Deploys the lending cover stack: Morpho Blue (from the pinned morpho-blue
/// submodule) with a FixedRateIrm and every mainnet LLTV enabled, and a
/// MorphoCoverVault in tUSD. The broadcaster owns Morpho and the vault.
/// @dev Monad testnet has no Morpho Blue, so we deploy our own. Markets are created by
/// `SeedMarket`. Terms come from `LendingConfig`.
///
/// Settings come from the environment.
///   USD             an existing MockUSD to reuse (the Perpl demo's tUSD)   default: deploy a new one
///   WAITING_PERIOD  seconds before cover attaches   default LendingConfig.WAITING_PERIOD
contract DeployLending is Script {
    function run()
        external
        returns (IMorpho morpho, FixedRateIrm irm, MockUSD usd, MorphoCoverVault vault)
    {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        address existing = vm.envOr("USD", address(0));
        usd = existing == address(0) ? new MockUSD() : MockUSD(existing);
        (morpho, irm) = MorphoReplay.deployMorpho(deployer);
        vault = new MorphoCoverVault(
            IERC20(address(usd)),
            morpho,
            deployer,
            LendingConfig.POLICY_TERM,
            vm.envOr("WAITING_PERIOD", LendingConfig.WAITING_PERIOD),
            LendingConfig.CLAIM_WINDOW,
            LendingConfig.WITHDRAWAL_NOTICE,
            LendingConfig.WITHDRAWAL_WINDOW,
            LendingConfig.DUST_THRESHOLD
        );
        vm.stopBroadcast();

        console.log("chain id          ", block.chainid);
        console.log("owner             ", deployer);
        console.log("export MORPHO=%s", address(morpho));
        console.log("export IRM=%s", address(irm));
        console.log("export USD=%s", address(usd));
        console.log("export VAULT=%s", address(vault));
    }
}
