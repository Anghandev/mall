// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library V2Types {
    uint16 internal constant BPS = 10_000;
    uint16 internal constant LAUNCH_USDT_PAYMENT_BPS = 7_000;
    uint16 internal constant LAUNCH_NPL_PAYMENT_BPS = 3_000;
    uint16 internal constant PLATFORM_SERVICE_FEE_LIST_PRICE_BPS = 100;
    uint16 internal constant NPL_BURN_LIST_PRICE_BPS = 2_000;
    uint16 internal constant NPL_REWARD_LIST_PRICE_BPS = 1_000;
    uint32 internal constant ORACLE_WINDOW = 30 minutes;
    uint16 internal constant ORACLE_MAX_DEVIATION_BPS = 500;
    uint64 internal constant ORACLE_MAX_AGE = 10 minutes;
    uint64 internal constant QUOTE_VALIDITY = 5 minutes;
    uint128 internal constant ORACLE_MIN_USDT_LIQUIDITY = 50_000 ether;
    uint128 internal constant MERCHANT_GUARANTEE_MINIMUM = 1_000 ether;
    uint32 internal constant REQUIRED_CONFIRMATIONS = 15;
    uint256 internal constant BSC_CHAIN_ID = 56;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant NPL = 0x4E8277AB31e4956b2CD48449793a57656DfC03D2;
    address internal constant NPL_USDT_PAIR = 0x2955e33bb120714aBf11ACE2766E614E6E5955B2;
    address internal constant NPL_BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    enum FulfillmentMode {
        Delivery,
        Pickup
    }

    enum PaymentClassification {
        Ordinary,
        Seckill,
        FallbackRetail
    }

    struct Policy {
        uint64 version;
        uint16 usdtPaymentBps;
        uint16 nplPaymentBps;
        uint16 nplBurnListPriceBps;
        uint16 nplRewardListPriceBps;
        uint16 genesisBps;
        uint16 directReferralBps;
        uint16 districtBps;
        uint16 cityBps;
        uint16 provinceBps;
        uint16 regionBps;
        uint16 operationsBps;
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
        address usdtCustodySafe;
        address nplRewardSafe;
        address operationsTreasurySafe;
        address circulationPool;
        bytes32 beneficiarySetHash;
        bytes32 concessionDestinationSetHash;
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
    }

    struct PaymentIntent {
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
        uint64 issuedAt;
        uint64 deadline;
        uint256 nonce;
        uint256 listPriceUsdt;
        uint256 productUsdtPaymentAmount;
        uint256 platformServiceFeeUsdt;
        uint256 custodyProductUsdt;
        uint256 freightUsdt;
        uint256 usdtPaymentAmount;
        uint256 nplQuoteAmount;
        uint256 nplPaymentAmount;
        uint256 nplBurnAmount;
        uint256 nplRewardAmount;
        uint256 merchantBaseReceivableUsdt;
        uint16 merchantConcessionBps;
        uint256 merchantConcessionAmount;
        uint256 merchantNetReceivableUsdt;
        bytes32 concessionAllocationHash;
        uint256 bnmAmount;
        bool seckill;
        bytes32 sessionId;
        BeneficiarySnapshot beneficiaries;
    }

    struct SeckillIntent {
        bytes32 sessionId;
        PaymentIntent seckillPayment;
        PaymentIntent fallbackPayment;
    }
}
