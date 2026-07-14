// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IPolicyRegistryV2} from "./interfaces/IV2Core.sol";
import {V2Types} from "./types/V2Types.sol";

contract BeneficiaryRegistryV2 is AccessControl {
    bytes32 public constant REGISTRY_EDITOR_ROLE = keccak256("REGISTRY_EDITOR_ROLE");
    uint256 public constant MAX_REFERRAL_DEPTH = 64;

    struct RegionBeneficiaries {
        address district;
        address city;
        address province;
        address region;
    }

    IPolicyRegistryV2 public immutable policyRegistry;
    mapping(address member => address referrer) public referrerOf;
    mapping(bytes32 regionCodeHash => RegionBeneficiaries beneficiaries) public regionBeneficiaries;

    error InvalidAddress();
    error InvalidReferral();
    error ReferralCycle();
    error ReferralDepthExceeded();
    error BeneficiaryMismatch();
    error InvalidRegion();
    error InvalidGenesisCredential();

    event ReferralUpdated(address indexed member, address indexed oldReferrer, address indexed newReferrer);
    event RegionBeneficiariesUpdated(
        bytes32 indexed regionCodeHash, address district, address city, address province, address region
    );

    constructor(IPolicyRegistryV2 policyRegistry_) {
        if (address(policyRegistry_) == address(0)) revert InvalidAddress();
        policyRegistry = policyRegistry_;
        address safe_ = policyRegistry_.safe();
        _grantRole(DEFAULT_ADMIN_ROLE, safe_);
        _grantRole(REGISTRY_EDITOR_ROLE, safe_);
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

    function setRegionBeneficiaries(bytes32 regionCodeHash, RegionBeneficiaries calldata beneficiaries)
        external
        onlyRole(REGISTRY_EDITOR_ROLE)
    {
        if (regionCodeHash == bytes32(0)) revert InvalidRegion();
        regionBeneficiaries[regionCodeHash] = beneficiaries;
        emit RegionBeneficiariesUpdated(
            regionCodeHash, beneficiaries.district, beneficiaries.city, beneficiaries.province, beneficiaries.region
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

        RegionBeneficiaries memory expected = regionBeneficiaries[regionCodeHash];
        if (
            snapshot.district != expected.district || snapshot.city != expected.city
                || snapshot.province != expected.province || snapshot.region != expected.region
        ) revert BeneficiaryMismatch();

        bool buyerGenesisEligible = _isGenesisEligible(policyVersion, buyer);
        if (
            (buyerGenesisEligible && snapshot.genesis != buyer)
                || (!buyerGenesisEligible && snapshot.genesis != address(0))
        ) {
            revert InvalidGenesisCredential();
        }
    }

    function isGenesisEligible(uint64 policyVersion, address account) external view returns (bool) {
        return _isGenesisEligible(policyVersion, account);
    }

    function _isGenesisEligible(uint64 policyVersion, address account) private view returns (bool) {
        if (account == address(0)) return false;
        V2Types.Policy memory policy = policyRegistry.getPolicy(policyVersion);
        if (policy.genesisCredentialStandard == V2Types.CredentialStandard.ERC721) {
            try IERC721(policy.genesisCredential).ownerOf(policy.genesisTokenId) returns (address owner) {
                return owner == account;
            } catch {
                return false;
            }
        }
        if (policy.genesisCredentialStandard == V2Types.CredentialStandard.ERC1155) {
            return IERC1155(policy.genesisCredential).balanceOf(account, policy.genesisTokenId) > 0;
        }
        return false;
    }
}
