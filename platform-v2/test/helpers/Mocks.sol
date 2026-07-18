// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract MockERC20 is ERC20 {
    uint16 public feeBps;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setFeeBps(uint16 feeBps_) external {
        require(feeBps_ <= 1_000, "fee too high");
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = value * feeBps / 10_000;
            super._update(from, address(0xfee), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract CallbackERC20 is MockERC20 {
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackEnabled;
    bool public callbackSucceeded;
    bool private _insideCallback;

    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_) {}

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackEnabled = true;
        callbackSucceeded = false;
    }

    function disableCallback() external {
        callbackEnabled = false;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (callbackEnabled && !_insideCallback) {
            _insideCallback = true;
            (callbackSucceeded,) = callbackTarget.call(callbackData);
            _insideCallback = false;
        }
        return super.transferFrom(from, to, value);
    }
}

contract MockCredential is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("Mock Genesis", "MGEN") {}

    function mint(address account) external returns (uint256 tokenId) {
        tokenId = _nextId++;
        _mint(account, tokenId);
    }
}

contract Mock1271Wallet is IERC1271 {
    using ECDSA for bytes32;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return hash.recover(signature) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function approveToken(address token, address spender, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "approve failed");
    }
}
