// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSD} from "../src/MockUSD.sol";

contract MockUSDTest is Test {
    MockUSD internal usd;

    function setUp() public {
        usd = new MockUSD();
    }

    function test_metadata() public view {
        assertEq(usd.name(), "Test Dollar");
        assertEq(usd.symbol(), "tUSD");
        assertEq(usd.decimals(), 6);
    }

    function test_anyoneCanMintUpToCap() public {
        address judge = makeAddr("judge");
        vm.prank(judge);
        usd.mint(judge, usd.MAX_MINT());
        assertEq(usd.balanceOf(judge), 100_000e6);
    }

    function test_mintAboveCapReverts() public {
        uint256 cap = usd.MAX_MINT();
        vm.expectRevert(abi.encodeWithSelector(MockUSD.MintCapExceeded.selector, cap + 1, cap));
        usd.mint(address(this), cap + 1);
    }
}
