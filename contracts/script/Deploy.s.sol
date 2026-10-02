// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockBackstopAdapter} from "../src/MockBackstopAdapter.sol";
import {CoverVault} from "../src/CoverVault.sol";

/// @title Deploy
/// @notice Deploys the Spillway demo: MockUSD, a MockBackstopAdapter for one perpetual
/// and a CoverVault over it. Seeds the insurance fund, sets the runner, wires the
/// vault and (optionally) funds the premium. The broadcaster is the owner and the
/// sponsor.
///
/// Settings come from the environment. Money is in whole tUSD.
///   TERM_DAYS       cover term in days                    default 30
///   LIMIT           layer limit                           default 250000
///   INSURANCE_SEED  insurance fund seed, also the hint    default 178373
///   PREMIUM         premium funded at deploy, 0 to skip   default 5000
///   PERP_ID         perpetual the adapter mirrors         default 1 (BTC)
///   RUNNER          scenario runner address               default broadcaster
contract Deploy is Script {
    uint256 internal constant ONE = 1e6;

    function run() external returns (MockUSD usd, MockBackstopAdapter adapter, CoverVault vault) {
        uint256 termDays = vm.envOr("TERM_DAYS", uint256(30));
        uint256 limit = vm.envOr("LIMIT", uint256(250_000)) * ONE;
        uint256 seed = vm.envOr("INSURANCE_SEED", uint256(178_373)) * ONE;
        uint256 premium = vm.envOr("PREMIUM", uint256(5_000)) * ONE;
        uint256 perpId = vm.envOr("PERP_ID", uint256(1));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address runner = vm.envOr("RUNNER", deployer);

        usd = new MockUSD();
        adapter = new MockBackstopAdapter(usd, perpId, deployer);
        adapter.setRunner(runner);

        uint256 start = block.timestamp;
        vault =
            new CoverVault(usd, adapter, deployer, start, start + termDays * 1 days, limit, seed);
        adapter.setVault(address(vault));

        _mint(usd, deployer, seed + premium);
        if (seed > 0) {
            usd.approve(address(adapter), seed);
            adapter.fundInsurance(seed);
        }
        if (premium > 0) {
            usd.approve(address(vault), premium);
            vault.fundPremium(premium);
        }
        vm.stopBroadcast();

        console.log("chain id      ", block.chainid);
        console.log("MockUSD       ", address(usd));
        console.log("Adapter       ", address(adapter));
        console.log("CoverVault    ", address(vault));
        console.log("owner/sponsor ", deployer);
        console.log("runner        ", runner);
        console.log("term start    ", start);
        console.log("term end      ", start + termDays * 1 days);
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
