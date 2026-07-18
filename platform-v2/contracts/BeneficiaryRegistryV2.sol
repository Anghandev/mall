// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPolicyRegistryV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract BeneficiaryRegistryV2 is AccessControl, EIP712 {
    bytes32 public constant REGISTRY_EDITOR_ROLE = keccak256("REGISTRY_EDITOR_ROLE");
    bytes32 public constant REGION_PUBLICATION_TYPEHASH = keccak256(
        "RegionBeneficiaryPublication(uint64 policyVersion,bytes32 regionCodeHash,bytes32 beneficiariesHash,uint256 nonce,uint64 deadline)"
    );
    uint256 public constant MAX_REFERRAL_DEPTH = 64;

    struct RegionBeneficiaries {
        address district;
        address city;
        address province;
        address region;
    }

    IPolicyRegistryV2 public immutable policyRegistry;
    mapping(address member => address referrer) public referrerOf;
    mapping(uint64 policyVersion => mapping(bytes32 regionCodeHash => RegionBeneficiaries beneficiaries)) public
        regionBeneficiaries;
    mapping(uint64 policyVersion => mapping(bytes32 regionCodeHash => bool published)) public regionPublished;
    mapping(uint256 nonce => bool used) public usedRegionPublicationNonce;

    error InvalidAddress();
    error InvalidReferral();
    error ReferralCycle();
    error ReferralDepthExceeded();
    error BeneficiaryMismatch();
    error InvalidRegion();
    error InvalidSecondarySignature();
    error PublicationExpired();
    error PublicationReplay();
    error GovernanceWalletRequired();
    error PolicyVersionRequired();
    error RegionAlreadyPublished();

    event ReferralUpdated(address indexed member, address indexed oldReferrer, address indexed newReferrer);
    event RegionBeneficiariesUpdated(
        uint64 indexed policyVersion,
        bytes32 indexed regionCodeHash,
        address district,
        address city,
        address province,
        address region
    );

    constructor(IPolicyRegistryV2 policyRegistry_) EIP712("Abu24KBeneficiaryRegistry", "2") {
        if (address(policyRegistry_) == address(0)) revert InvalidAddress();
        policyRegistry = policyRegistry_;
        address governanceWallet_ = policyRegistry_.governanceWallet();
        _grantRole(DEFAULT_ADMIN_ROLE, governanceWallet_);
        _grantRole(REGISTRY_EDITOR_ROLE, governanceWallet_);
    }

    function setReferrer(address member, address referrer) external onlyRole(REGISTRY_EDITOR_ROLE) {
        if (member == address(0) || member == referrer) revert InvalidReferral();
        address cursor = referrer;
        for (uint256 depth; cursor != address(0); ++depth) {
            if (cursor == member) revert ReferralCycle();
            if (depth == MAX_REFERRAL_DEPTH) revert ReferralDepthExceeded();
            cursor = referrerOf[cursor];
        }
        address oldReferrer = referrerOf[member];
        referrerOf[member] = referrer;
        emit ReferralUpdated(member, oldReferrer, referrer);
    }

    function publishRegionBeneficiaries(
        uint64 policyVersion,
        bytes32 regionCodeHash,
        RegionBeneficiaries calldata beneficiaries,
        uint256 nonce,
        uint64 deadline,
        bytes calldata secondarySignature
    ) external onlyRole(REGISTRY_EDITOR_ROLE) {
        if (msg.sender != policyRegistry.governanceWallet()) revert GovernanceWalletRequired();
        if (regionCodeHash == bytes32(0)) revert InvalidRegion();
        if (policyVersion == 0 || policyVersion != policyRegistry.latestVersion() + 1) revert PolicyVersionRequired();
        if (block.timestamp > deadline) revert PublicationExpired();
        if (usedRegionPublicationNonce[nonce]) revert PublicationReplay();
        if (regionPublished[policyVersion][regionCodeHash]) revert RegionAlreadyPublished();
        bytes32 digest = hashRegionPublication(policyVersion, regionCodeHash, beneficiaries, nonce, deadline);
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, secondarySignature);
        if (recoverError != ECDSA.RecoverError.NoError || recovered != policyRegistry.secondarySigner()) {
            revert InvalidSecondarySignature();
        }
        usedRegionPublicationNonce[nonce] = true;
        regionPublished[policyVersion][regionCodeHash] = true;
        regionBeneficiaries[policyVersion][regionCodeHash] = beneficiaries;
        emit RegionBeneficiariesUpdated(
            policyVersion,
            regionCodeHash,
            beneficiaries.district,
            beneficiaries.city,
            beneficiaries.province,
            beneficiaries.region
        );
    }

    function hashRegionPublication(
        uint64 policyVersion,
        bytes32 regionCodeHash,
        RegionBeneficiaries calldata beneficiaries,
        uint256 nonce,
        uint64 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REGION_PUBLICATION_TYPEHASH,
                    policyVersion,
                    regionCodeHash,
                    keccak256(abi.encode(beneficiaries)),
                    nonce,
                    deadline
                )
            )
        );
    }

    function validateSnapshot(
        uint64 policyVersion,
        address buyer,
        address merchant,
        bytes32 regionCodeHash,
        V2Types.BeneficiarySnapshot calldata snapshot
    ) external view {
        if (buyer == address(0) || merchant == address(0) || buyer == snapshot.directReferral) {
            revert BeneficiaryMismatch();
        }
        if (snapshot.directReferral != referrerOf[buyer]) revert BeneficiaryMismatch();

        RegionBeneficiaries memory expected = regionBeneficiaries[policyVersion][regionCodeHash];
        if (
            snapshot.district != expected.district || snapshot.city != expected.city
                || snapshot.province != expected.province || snapshot.region != expected.region
        ) revert BeneficiaryMismatch();

        if (snapshot.genesis != address(0)) revert BeneficiaryMismatch();
    }
}
