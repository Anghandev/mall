// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {V2Types} from "./types/V2Types.sol";

contract PolicyRegistryV2 is AccessControl, EIP712 {
    bytes32 public constant POLICY_PUBLISHER_ROLE = keccak256("POLICY_PUBLISHER_ROLE");
    bytes32 public constant PUBLICATION_TYPEHASH =
        keccak256("PolicyPublication(bytes32 policyHash,bytes32 operationsHash,uint256 nonce,uint64 deadline)");
    uint256 public constant MAX_OPERATIONS_ACCOUNTS = 32;

    address public immutable safe;
    address public immutable secondarySigner;
    uint64 public latestVersion;

    mapping(uint64 version => V2Types.Policy policy) private _policies;
    mapping(uint64 version => address[] accounts) private _operationsAccounts;
    mapping(uint64 version => uint16[] weights) private _operationsWeights;
    mapping(uint256 nonce => bool used) public usedPublicationNonce;

    error InvalidAddress();
    error InvalidChain();
    error InvalidPolicy();
    error InvalidLaunchPolicy();
    error InvalidOperations();
    error InvalidSecondarySignature();
    error PublicationExpired();
    error PublicationReplay();
    error SafeExecutionRequired();
    error UnknownPolicy(uint64 version);

    event PolicyPublished(
        uint64 indexed version,
        bytes32 indexed policyHash,
        bytes32 indexed operationsHash,
        bytes32 decisionEvidenceHash,
        address safeExecutor
    );

    constructor(address safe_, address secondarySigner_) EIP712("Abu24KPolicyRegistry", "2") {
        if (block.chainid != V2Types.BSC_CHAIN_ID) revert InvalidChain();
        if (safe_ == address(0) || secondarySigner_ == address(0) || safe_ == secondarySigner_) {
            revert InvalidAddress();
        }
        safe = safe_;
        secondarySigner = secondarySigner_;
        _grantRole(DEFAULT_ADMIN_ROLE, safe_);
        _grantRole(POLICY_PUBLISHER_ROLE, safe_);
    }

    function publishPolicy(
        V2Types.Policy calldata policy,
        address[] calldata operationsAccounts,
        uint16[] calldata operationsWeights,
        uint256 nonce,
        uint64 deadline,
        bytes calldata secondarySignature
    ) external onlyRole(POLICY_PUBLISHER_ROLE) {
        if (msg.sender != safe) revert SafeExecutionRequired();
        if (block.timestamp > deadline) revert PublicationExpired();
        if (usedPublicationNonce[nonce]) revert PublicationReplay();

        _validatePolicy(policy);
        bytes32 operationsHash = _validateOperations(operationsAccounts, operationsWeights, policy.beneficiarySetHash);
        bytes32 policyHash = keccak256(abi.encode(policy));
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(PUBLICATION_TYPEHASH, policyHash, operationsHash, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNowCalldata(secondarySigner, digest, secondarySignature)) {
            revert InvalidSecondarySignature();
        }

        usedPublicationNonce[nonce] = true;
        latestVersion = policy.version;
        _policies[policy.version] = policy;
        for (uint256 i; i < operationsAccounts.length; ++i) {
            _operationsAccounts[policy.version].push(operationsAccounts[i]);
            _operationsWeights[policy.version].push(operationsWeights[i]);
        }

        emit PolicyPublished(policy.version, policyHash, operationsHash, policy.decisionEvidenceHash, msg.sender);
    }

    function getPolicy(uint64 version) external view returns (V2Types.Policy memory) {
        V2Types.Policy memory policy = _policies[version];
        if (policy.version == 0) revert UnknownPolicy(version);
        return policy;
    }

    function getOperations(uint64 version) external view returns (address[] memory accounts, uint16[] memory weights) {
        if (_policies[version].version == 0) revert UnknownPolicy(version);
        return (_operationsAccounts[version], _operationsWeights[version]);
    }

    function hashPublication(
        V2Types.Policy calldata policy,
        address[] calldata operationsAccounts,
        uint16[] calldata operationsWeights,
        uint256 nonce,
        uint64 deadline
    ) external view returns (bytes32) {
        bytes32 operationsHash = keccak256(abi.encode(operationsAccounts, operationsWeights));
        return _hashTypedDataV4(
            keccak256(abi.encode(PUBLICATION_TYPEHASH, keccak256(abi.encode(policy)), operationsHash, nonce, deadline))
        );
    }

    function _validatePolicy(V2Types.Policy calldata policy) private view {
        if (policy.version != latestVersion + 1 || policy.decisionEvidenceHash == bytes32(0)) revert InvalidPolicy();
        if (
            policy.usdtPaymentBps != V2Types.LAUNCH_USDT_PAYMENT_BPS
                || policy.nplPaymentBps != V2Types.LAUNCH_NPL_PAYMENT_BPS
                || policy.nplBurnListPriceBps + policy.nplRewardListPriceBps != policy.nplPaymentBps
        ) revert InvalidPolicy();
        if (
            policy.usdtCustodySafe == address(0) || policy.nplRewardSafe == address(0)
                || policy.operationsTreasurySafe == address(0) || policy.circulationPool == address(0)
                || policy.genesisCredential == address(0)
                || policy.genesisCredentialStandard == V2Types.CredentialStandard.None
                || policy.usdtCustodySafe == policy.nplRewardSafe
                || policy.usdtCustodySafe == policy.operationsTreasurySafe
                || policy.nplRewardSafe == policy.operationsTreasurySafe || policy.relayInitial == 0
                || policy.relayIncrement == 0 || policy.relayCap == 0 || policy.seckillMainDuration == 0
                || policy.relayInitial > policy.relayCap || policy.relayCap > policy.seckillMainDuration
                || policy.oracleVersion == bytes32(0) || policy.rulesContentHash == bytes32(0)
                || policy.concessionDestinationSetHash == bytes32(0)
        ) revert InvalidPolicy();

        uint256 rewardsBps = uint256(policy.genesisBps) + policy.directReferralBps + policy.districtBps + policy.cityBps
            + policy.provinceBps + policy.regionBps + policy.operationsBps;
        if (rewardsBps != policy.nplRewardListPriceBps) revert InvalidPolicy();
        if (uint256(policy.platformFeeBps) + policy.seckillPrizeBps > V2Types.BPS) revert InvalidPolicy();
        if (
            policy.oracleMaxAge != V2Types.ORACLE_MAX_AGE
                || policy.oracleMinLiquidity != V2Types.ORACLE_MIN_USDT_LIQUIDITY
                || policy.merchantGuaranteeMinimum < V2Types.MERCHANT_GUARANTEE_MINIMUM
        ) revert InvalidPolicy();

        if (policy.version == 1) {
            if (
                policy.nplBurnListPriceBps != V2Types.NPL_BURN_LIST_PRICE_BPS
                    || policy.nplRewardListPriceBps != V2Types.NPL_REWARD_LIST_PRICE_BPS || policy.genesisBps != 200
                    || policy.directReferralBps != 100 || policy.districtBps != 120 || policy.cityBps != 80
                    || policy.provinceBps != 60 || policy.regionBps != 40 || policy.operationsBps != 400
                    || policy.seckillMainDuration != 60 minutes || policy.relayInitial != 60 seconds
                    || policy.relayIncrement != 30 seconds || policy.relayCap != 60 seconds
                    || policy.merchantGuaranteeMinimum != V2Types.MERCHANT_GUARANTEE_MINIMUM
            ) revert InvalidLaunchPolicy();
        }
    }

    function _validateOperations(address[] calldata accounts, uint16[] calldata weights, bytes32 expectedHash)
        private
        pure
        returns (bytes32 operationsHash)
    {
        if (accounts.length == 0 || accounts.length > MAX_OPERATIONS_ACCOUNTS || accounts.length != weights.length) revert InvalidOperations();
        uint256 totalWeight;
        address previous;
        for (uint256 i; i < accounts.length; ++i) {
            if (accounts[i] == address(0) || accounts[i] <= previous || weights[i] == 0) revert InvalidOperations();
            previous = accounts[i];
            totalWeight += weights[i];
        }
        if (totalWeight != V2Types.BPS) revert InvalidOperations();
        operationsHash = keccak256(abi.encode(accounts, weights));
        if (expectedHash == bytes32(0) || expectedHash != operationsHash) revert InvalidOperations();
    }
}
