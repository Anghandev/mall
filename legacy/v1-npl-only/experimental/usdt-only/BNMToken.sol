// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract BNMToken is ERC20, Ownable, Pausable {
    mapping(address account => bool allowed) public minters;

    event MinterSet(address indexed account, bool allowed);
    event BnmPaused(address indexed account);
    event BnmUnpaused(address indexed account);

    error NotMinter();
    error InvalidAddress();
    error OwnershipRenounceDisabled();

    constructor(address initialOwner) ERC20("24K BNM Rebate", "BNM") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    function setMinter(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        minters[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function mint(address to, uint256 amount) external onlyMinter whenNotPaused {
        if (to == address(0)) revert InvalidAddress();
        _mint(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
        emit BnmPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit BnmUnpaused(msg.sender);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }

    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        super._update(from, to, value);
    }
}
