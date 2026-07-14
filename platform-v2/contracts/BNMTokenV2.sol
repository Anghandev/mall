// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {V2Types} from "./types/V2Types.sol";

contract BNMTokenV2 is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    error InvalidAddress();

    constructor(address safe) ERC20("Abu 24K BNM", "BNM") {
        if (safe == address(0) || block.chainid != V2Types.BSC_CHAIN_ID) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, safe);
    }

    function mint(address account, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(account, amount);
    }
}
