// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VaultFixture} from "./utils/VaultFixture.sol";

/// @dev Fuzzed payouts and premium splits.
contract CoverVaultFuzzTest is VaultFixture {
    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 m = a < b ? a : b;
        return m < c ? m : c;
    }

    /// @dev Each payout is exactly min(shortfall, remaining limit, principal), and the
    /// total never passes the limit.
    function testFuzz_payoutBoundedByLimitAndPrincipal(
        uint256 deposited,
        uint256 debt1,
        uint256 debt2,
        uint256 debt3
    ) public {
        deposited = bound(deposited, 1, LIMIT);
        _deposit(alice, deposited);
        _fundPremium(1_000e6);

        uint256[3] memory debts = [
            bound(debt1, 1, 1_000_000e6),
            bound(debt2, 1, 1_000_000e6),
            bound(debt3, 1, 1_000_000e6)
        ];
        for (uint256 i; i < 3; ++i) {
            vm.warp(block.timestamp + 1 days);
            _badDebt(debts[i]);

            uint256 shortfall = adapter.pendingShortfall();
            uint256 expected = _min3(shortfall, vault.remainingLimit(), vault.totalPrincipal());
            uint256 paid = vault.settle();

            assertEq(paid, expected, "payout != min(shortfall, remaining, principal)");
            assertLe(vault.paidOut(), LIMIT, "paid past the limit");
            assertLe(vault.paidOut(), deposited, "paid past the principal");
            assertLe(vault.totalPrincipal(), vault.remainingLimit(), "principal above limit");
            assertEq(adapter.pendingShortfall(), shortfall - paid);
            _assertSolvent();
        }
        assertEq(vault.paidOut() + vault.totalPrincipal(), deposited);
    }

    /// @dev Two holders never receive more premium than was funded, and holders plus
    /// sweep account for all of it up to rounding dust.
    function testFuzz_premiumSplitsWithoutLeaking(
        uint256 a,
        uint256 b,
        uint256 joinAfter,
        uint256 premium,
        uint256 loss
    ) public {
        a = bound(a, 1e6, LIMIT / 2);
        b = bound(b, 1e6, LIMIT / 2);
        joinAfter = bound(joinAfter, 0, TERM - 1);
        premium = bound(premium, 1e6, 1_000_000e6);
        loss = bound(loss, 0, 2 * LIMIT);

        _fundPremium(premium);
        _deposit(alice, a);
        vm.warp(START + joinAfter);
        _deposit(bob, b);
        if (loss > 0) {
            _badDebt(FUND + loss);
            vault.settle();
        }
        _assertSolvent();

        _warpToEnd();
        (, uint256 pa) = _withdrawAll(alice);
        (, uint256 pb) = _withdrawAll(bob);
        uint256 swept = vault.sweepUnearnedPremium();

        assertLe(pa + pb, premium, "holders paid more than funded");
        assertLe(pa + pb + swept, premium, "premium paid twice");
        assertApproxEqAbs(pa + pb + swept, premium, 2, "premium leaked");
        assertEq(vault.totalPrincipal(), 0);
        assertEq(vault.totalShares(), 0);
    }
}
