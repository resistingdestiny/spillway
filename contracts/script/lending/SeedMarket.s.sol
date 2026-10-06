// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IMorpho, Id, MarketParams, Market} from "morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/src/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/src/libraries/SharesMathLib.sol";
import {MockUSD} from "../../src/MockUSD.sol";
import {TestToken} from "../../src/lending/TestToken.sol";
import {MockOracle} from "../../src/lending/MockOracle.sol";
import {MorphoCoverVault} from "../../src/lending/MorphoCoverVault.sol";
import {MorphoReplay} from "./MorphoReplay.sol";
import {ReplayBorrower} from "./ReplayBorrower.sol";
import {LendingConfig} from "./LendingConfig.sol";

/// @title SeedMarket
/// @notice Replay, step one. Creates a Morpho Blue market with a MockOracle at the
/// book's price, copies the book's suppliers and borrowers into it, lists it in the
/// cover vault at the book's annual premium rate, puts up underwriting capital and buys
/// cover for one supplier.
/// @dev The input is a `spillway.morpho-replay/1` JSON file (see replay/example.json and
/// the README). Amounts are already scaled to testnet tokens, in base units, as decimal
/// strings. The broadcaster must own the vault. It pays for everything: it mints tUSD
/// from the faucet and supplies on behalf of each supplier, and each borrower is a
/// ReplayBorrower contract that mints its own test collateral. Borrows above what the
/// oracle allows are trimmed to the most Morpho accepts, and logged.
///
/// Settings come from the environment. Money is in whole tUSD.
///   MORPHO, IRM, USD, VAULT   from DeployLending                    required
///   REPLAY_JSON   the book                          default replay/example.json
///   REPLAY_STATE  where to write what Scenario needs  default replay/state-<chain id>.json
///   HOLDER        who holds the covered supply        default broadcaster
///   CAPITAL       underwriting capital to deposit     default the holder's supply
///   COVER_LIMIT   policy limit                        default the holder's supply
///   DEDUCTIBLE    policy deductible                   default 0
contract SeedMarket is Script {
    using MarketParamsLib for MarketParams;

    uint256 internal constant ONE = 1e6;

    struct Env {
        IMorpho morpho;
        address irm;
        MockUSD usd;
        MorphoCoverVault vault;
        address me;
        address holder;
    }

    struct Seeded {
        MarketParams params;
        uint256 supplyAssets;
        uint256 borrowAssets;
        uint256 trimmed;
        uint256 policyId;
        address[] suppliers;
        address[] borrowers;
    }

    function run() external returns (Id id, uint256 policyId) {
        string memory json = vm.readFile(vm.envOr("REPLAY_JSON", string("replay/example.json")));
        string memory statePath = vm.envOr(
            "REPLAY_STATE", string.concat("replay/state-", vm.toString(block.chainid), ".json")
        );

        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        Env memory env = Env({
            morpho: IMorpho(vm.envAddress("MORPHO")),
            irm: vm.envAddress("IRM"),
            usd: MockUSD(vm.envAddress("USD")),
            vault: MorphoCoverVault(vm.envAddress("VAULT")),
            me: me,
            holder: vm.envOr("HOLDER", me)
        });
        Seeded memory s = _createMarket(env, json);
        _seedSuppliers(env, json, s);
        _seedBorrowers(env, json, s);
        _cover(env, s);
        vm.stopBroadcast();

        id = s.params.id();
        policyId = s.policyId;
        _writeState(env, s, statePath);

        console.log("market id");
        console.logBytes32(Id.unwrap(id));
        console.log("oracle        ", s.params.oracle);
        console.log("collateral    ", s.params.collateralToken);
        console.log("suppliers     ", s.suppliers.length);
        console.log("borrowers     ", s.borrowers.length);
        console.log("supplied      ", s.supplyAssets);
        console.log("borrowed      ", s.borrowAssets);
        console.log("trimmed       ", s.trimmed);
        console.log("policy id     ", policyId);
        console.log("state written ", statePath);
    }

    function _createMarket(Env memory env, string memory json) internal returns (Seeded memory s) {
        TestToken collateral = new TestToken(
            vm.parseJsonString(json, ".collateral.name"),
            vm.parseJsonString(json, ".collateral.symbol"),
            uint8(vm.parseJsonUint(json, ".collateral.decimals")),
            LendingConfig.COLLATERAL_MAX_MINT
        );
        MockOracle oracle = new MockOracle(vm.parseJsonUint(json, ".oraclePrice"), env.me);
        s.params = MarketParams({
            loanToken: address(env.usd),
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: env.irm,
            lltv: vm.parseJsonUint(json, ".lltv")
        });
        env.morpho.createMarket(s.params);
        // The engine prices each market and writes the rate into the book. A book
        // without one is listed at the config's placeholder.
        uint256 premiumBps = vm.keyExistsJson(json, ".premiumBps")
            ? vm.parseJsonUint(json, ".premiumBps")
            : LendingConfig.PREMIUM_BPS;
        env.vault.listMarket(s.params, premiumBps);
    }

    function _seedSuppliers(Env memory env, string memory json, Seeded memory s) internal {
        uint256 n = _count(json, ".suppliers");
        uint256 holderIndex = vm.parseJsonUint(json, ".holderIndex");
        s.suppliers = new address[](n);
        bytes32 salt = Id.unwrap(s.params.id());
        for (uint256 i; i < n; ++i) {
            uint256 assets = vm.parseJsonUint(json, _key(".suppliers", i, ".assets"));
            // Everyone but the holder gets an address nobody has a key to. Their
            // supply only needs to sit in the market and share the loss.
            address onBehalf = i == holderIndex
                ? env.holder
                : address(uint160(uint256(keccak256(abi.encode("spillway.replay", salt, i)))));
            _mint(env.usd, env.me, assets);
            env.usd.approve(address(env.morpho), assets);
            env.morpho.supply(s.params, assets, 0, onBehalf, "");
            s.suppliers[i] = onBehalf;
            s.supplyAssets += assets;
        }
    }

    function _seedBorrowers(Env memory env, string memory json, Seeded memory s) internal {
        uint256 n = _count(json, ".borrowers");
        s.borrowers = new address[](n);
        for (uint256 i; i < n; ++i) {
            uint256 collateral = vm.parseJsonUint(json, _key(".borrowers", i, ".collateral"));
            uint256 wanted = vm.parseJsonUint(json, _key(".borrowers", i, ".borrowAssets"));
            uint256 max = MorphoReplay.maxBorrow(s.params, collateral);
            uint256 borrow = wanted > max ? max : wanted;
            if (borrow < wanted) {
                console.log("borrower %s trimmed from %s to %s", i, wanted, borrow);
                s.trimmed += wanted - borrow;
            }
            s.borrowers[i] =
                address(new ReplayBorrower(env.morpho, s.params, collateral, borrow, env.me));
            s.borrowAssets += borrow;
        }
    }

    function _cover(Env memory env, Seeded memory s) internal {
        Id id = s.params.id();
        uint256 holderAssets = _holderAssets(env, s);
        uint256 capital = vm.envOr("CAPITAL", holderAssets / ONE) * ONE;
        uint256 limit = vm.envOr("COVER_LIMIT", holderAssets / ONE) * ONE;
        uint256 deductible = vm.envOr("DEDUCTIBLE", uint256(0)) * ONE;

        _mint(env.usd, env.me, capital);
        env.usd.approve(address(env.vault), capital);
        env.vault.deposit(capital);

        uint256 premium = env.vault.premiumFor(id, limit);
        _mint(env.usd, env.me, premium);
        env.usd.approve(address(env.vault), premium);
        uint256 shares = env.morpho.position(id, env.holder).supplyShares;
        // Every borrower in the book goes through the purchase-time health check.
        s.policyId = env.vault.buyPolicy(id, env.holder, shares, limit, deductible, s.borrowers);
    }

    function _holderAssets(Env memory env, Seeded memory s) internal view returns (uint256) {
        Id id = s.params.id();
        Market memory m = env.morpho.market(id);
        return SharesMathLib.toAssetsDown(
            env.morpho.position(id, env.holder).supplyShares,
            m.totalSupplyAssets,
            m.totalSupplyShares
        );
    }

    function _writeState(Env memory env, Seeded memory s, string memory path) internal {
        string memory k = "state";
        vm.serializeString(k, "schema", "spillway.morpho-replay-state/1");
        vm.serializeAddress(k, "morpho", address(env.morpho));
        vm.serializeAddress(k, "vault", address(env.vault));
        vm.serializeAddress(k, "loanToken", s.params.loanToken);
        vm.serializeAddress(k, "collateralToken", s.params.collateralToken);
        vm.serializeAddress(k, "oracle", s.params.oracle);
        vm.serializeAddress(k, "irm", s.params.irm);
        vm.serializeUint(k, "lltv", s.params.lltv);
        vm.serializeBytes32(k, "marketId", Id.unwrap(s.params.id()));
        vm.serializeAddress(k, "holder", env.holder);
        vm.serializeUint(k, "policyId", s.policyId);
        vm.serializeAddress(k, "suppliers", s.suppliers);
        string memory out = vm.serializeAddress(k, "borrowers", s.borrowers);
        vm.writeJson(out, path);
    }

    /// @dev Length of the JSON array at `path`.
    function _count(string memory json, string memory path) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(path, "[", vm.toString(n), "]"))) {
            ++n;
        }
    }

    function _key(string memory array, uint256 i, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat(array, "[", vm.toString(i), "]", field);
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
