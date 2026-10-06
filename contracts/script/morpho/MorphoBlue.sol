// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

// Pulls Morpho Blue into the build, compiled with its own pinned solc, so tests and
// scripts can deploy it from its artifact with `deployCode`. Nothing else imports this.
import {Morpho} from "morpho-blue/src/Morpho.sol";
