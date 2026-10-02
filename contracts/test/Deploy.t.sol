// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockBackstopAdapter} from "../src/MockBackstopAdapter.sol";
import {CoverVault} from "../src/CoverVault.sol";

/// @dev Runs the deploy script in memory and checks the wiring.
contract DeployTest is Test {
    function test_deployWiresEverything() public {
        (MockUSD usd, MockBackstopAdapter adapter, CoverVault vault) = new Deploy().run();

        uint256 termDays = vm.envOr("TERM_DAYS", uint256(30));
        uint256 limit = vm.envOr("LIMIT", uint256(250_000)) * 1e6;
        uint256 seed = vm.envOr("INSURANCE_SEED", uint256(178_373)) * 1e6;
        uint256 premium = vm.envOr("PREMIUM", uint256(5_000)) * 1e6;

        assertEq(adapter.vault(), address(vault));
        assertEq(adapter.runner(), vm.envOr("RUNNER", adapter.owner()));
        assertEq(adapter.asset(), address(usd));
        assertEq(address(vault.adapter()), address(adapter));
        assertEq(vault.sponsor(), adapter.owner());
        assertEq(vault.termEnd() - vault.termStart(), termDays * 1 days);
        assertEq(vault.limit(), limit);
        assertEq(vault.attachmentHint(), seed);
        assertEq(adapter.insuranceFund(), seed);
        assertEq(vault.premiumFunded(), premium);
        assertEq(usd.balanceOf(address(vault)), premium);
        assertTrue(vault.isCoverActive());
    }
}
