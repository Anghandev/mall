// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library V2Types {
    uint16 internal constant BPS = 10_000;
    uint32 internal constant ORACLE_WINDOW = 30 minutes;
    uint16 internal constant ORACLE_MAX_DEVIATION_BPS = 500;
    uint256 internal constant BSC_CHAIN_ID = 56;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant NPL = 0x4E8277AB31e4956b2CD48449793a57656DfC03D2;

    enum CredentialStandard {
        None,
        ERC721,
        ERC1155
    }

    enum FulfillmentMode {
        Delivery,
        Pickup
    }

    enum FulfillmentMethod {
        CustomerReceipt,
        PickupVerification,
        ForcedReceipt,
        Arbitration
    }

    enum ClaimRail {
        MerchantUsdt,
        RewardNpl,
        PrizeUsdt,
        Bnm
    }

    enum OrderState {
        None,
        Paid,
        Shipped,
        Delivered,
        Arbitration,
        Takeover,
        FulfillmentPending,
        Fulfilled
    }

    struct Policy {
        uint64 version;
        uint16 usdtPaymentBps;
        uint16 nplPaymentBps;
        uint16 burnBps;
        uint16 routeBps;
        uint16 genesisBps;
        uint16 directReferralBps;
        uint16 districtBps;
        uint16 cityBps;
        uint16 provinceBps;
        uint16 regionBps;
        uint16 operationsBps;
        uint16 merchantStoreBps;
        uint16 platformFeeBps;
        uint16 seckillPrizeBps;
        uint32 seckillMainDuration;
        uint32 relayInitial;
        uint32 relayIncrement;
        uint32 relayCap;
        bytes32 oracleVersion;
        uint64 oracleMaxAge;
        uint128 oracleMinLiquidity;
        uint128 merchantGuaranteeMinimum;
        uint128 platformRiskReserveMinimum;
        uint128 guaranteeTopupLine;
        address platformTreasury;
        address circulationPool;
        address usdtRemainderAccount;
        address genesisCredential;
        uint256 genesisTokenId;
        CredentialStandard genesisCredentialStandard;
        bytes32 beneficiarySetHash;
        bytes32 decisionEvidenceHash;
        bytes32 rulesContentHash;
    }

    struct BeneficiarySnapshot {
        address genesis;
        address directReferral;
        address district;
        address city;
        address province;
        address region;
        address merchantStore;
    }

    struct OrderIntent {
        bytes32 orderId;
        uint64 policyVersion;
        bytes32 oracleVersion;
        address buyer;
        address merchant;
        bytes32 productId;
        bytes32 skuId;
        uint32 quantity;
        FulfillmentMode fulfillmentMode;
        bytes32 fulfillmentTargetHash;
        bytes32 regionCodeHash;
        bytes32 productPolicyHash;
        bytes32 reservationId;
        bytes32 reservationHash;
        uint64 reservationDeadline;
        uint256 nonce;
        uint64 deadline;
        uint256 listPriceUsdt;
        uint256 usdtPaymentAmount;
        uint256 nplPaymentAmount;
        uint256 rewardBaseNpl;
        uint256 merchantUsdtAmount;
        uint256 platformUsdtAmount;
        uint256 prizeUsdtAmount;
        uint256 usdtRemainderAmount;
        uint256 bnmAmount;
        bool seckill;
        bytes32 sessionId;
        BeneficiarySnapshot beneficiaries;
    }

    struct SeckillIntent {
        bytes32 sessionId;
        OrderIntent seckillOrder;
        OrderIntent fallbackOrder;
        uint64 deadline;
    }

    struct FulfillmentAttestation {
        bytes32 orderId;
        FulfillmentMethod method;
        uint256 sourceChainId;
        address sourceContract;
        bytes32 sourceEventHash;
        bytes32 sourceTxHash;
        bytes32 blockHash;
        uint32 confirmations;
        uint8 status;
        uint256 nonce;
        uint64 deadline;
        bytes32 evidenceHash;
    }

    struct ClaimIntent {
        address claimant;
        ClaimRail rail;
        address asset;
        uint256 amount;
        uint256 nonce;
        uint64 deadline;
    }
}
