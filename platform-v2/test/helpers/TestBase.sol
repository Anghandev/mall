// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address caller) external;
    function startPrank(address caller) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata code) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function assume(bool condition) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function assertFalse(bool value) internal pure {
        require(!value, "assertFalse failed");
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "assertEq(uint256) failed");
    }

    function assertEq(address left, address right) internal pure {
        require(left == right, "assertEq(address) failed");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "assertEq(bytes32) failed");
    }

    function assertEq(bool left, bool right) internal pure {
        require(left == right, "assertEq(bool) failed");
    }

    function bound(uint256 value, uint256 minimum, uint256 maximum) internal pure returns (uint256) {
        require(minimum <= maximum, "invalid bounds");
        if (value >= minimum && value <= maximum) return value;
        return minimum + (value % (maximum - minimum + 1));
    }
}
