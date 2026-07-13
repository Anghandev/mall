# 24K External Dependency Register

Frozen: 2026-07-13

These inputs are required for production deployment or real-world acceptance. Code must not invent or bypass them.

| dependencyId | Required input or service | Used by | Current state | Completion evidence |
|---|---|---|---|---|
| EXT-001 | Production API domain with HTTPS certificate | API, wallet browser, CORS, SIWE | Missing | Public health/readiness over HTTPS |
| EXT-002 | Production app/wallet entry HTTPS domain | C app and QR | Missing | Opens in target mobile wallet |
| EXT-003 | Reliable BSC RPC HTTPS endpoint | API, indexer, entitlement, tx polling | Missing | Receipt/finality and height checks pass |
| EXT-004 | Explorer API access | Independent height monitor | Explorer key available; production wiring missing | RPC vs explorer lag check passes |
| EXT-005 | Escrow production multisig owner contract | Escrow deployment | Missing | Contract code exists and owner() matches |
| EXT-006 | RewardLedger/BNM production multisig owner contract | Rewards deployment | Missing | Contract code exists and owner() matches |
| EXT-007 | Seckill production multisig owner contract | Seckill deployment | Missing | Contract code exists and owner() matches |
| EXT-008 | Platform, region, referral, prize, circulation, burn and retained receiver addresses | Escrow split/refund | Missing | Reviewed split event and receiver checks |
| EXT-009 | Merchant settlement receiver/approved seller address | Orders and seller whitelist | Missing | Seller approval event indexed |
| EXT-010 | Admin SIWE wallet | Platform backstage | Missing | Production SIWE login succeeds |
| EXT-011 | External order signer address and HTTPS signer service/token | EIP-712 order authorization | Missing | Signer health and signature verification pass |
| EXT-012 | External owner/multisig transaction execution service | Automatic settlement and privileged actions | Missing | Intent submit, approval and tx status audited |
| EXT-013 | Genesis credential contract, token standard and ERC1155 token id if applicable | Genesis reward visibility | Missing | Real holder/non-holder entitlement checks |
| EXT-014 | Reown project id | Mobile wallet UI | Missing | Wallet connect on device |
| EXT-015 | Deployment wallet with bounded BNB gas budget | Contract deployment/micro tests | Wallet has BNB; final budget not approved | Preflight reports budget within cap |
| EXT-016 | Deployment/test wallet with minimal NPL | Pay, refund, prize and claim test | Balance is zero | Balance covers only approved micro tests |
| EXT-017 | AMap web-service key | Store geocoding | Missing | Real coordinate-to-region test passes |
| EXT-018 | Electronic waybill provider URL/token/account | Waybill | Missing | Real tracking number accepted |
| EXT-019 | Shipment provider URL/token and callback secret | Logistics tracking/settlement | Missing | Delivered callback creates settlement |
| EXT-020 | Cloud printer provider URL/token and physical device id | Waybill/pickup receipts | Missing | Real one-copy and two-copy jobs pass |
| EXT-021 | Notification provider URL/token and channel accounts | SMS/email/push | Missing | Provider delivery receipts pass |
| EXT-022 | Redis endpoint and credentials | Cache/operations | Missing | Authenticated PING and metrics pass |
| EXT-023 | MQ endpoint, credentials and management health endpoint | Settlement/integration jobs/operations | Missing | Authenticated health and backlog checks pass |
| EXT-024 | Chainlink feed address, decimals, heartbeat, deviation threshold and approved reference source | Oracle monitoring | Missing | Fresh price and deviation alert tests pass |
| EXT-025 | Physical iOS/Android phone with target wallet | Device acceptance | Missing | All 14 checklist rows marked PASS |
| EXT-026 | Production server persistent business DB path and separate audit DB path | Runtime/data recovery | Missing | Backup/restore and append-only tests pass |

Current known deployment wallet address: `0x7003BBCE2b3f83F5b2dDC5A8C1b9b5b5289a1b83`.

Private keys, seed phrases, provider secrets and webhook tokens must only be entered into local protected environment files or the target secret manager. They must never be pasted into chat, committed to Git, emitted in reports or stored in the production API database.
