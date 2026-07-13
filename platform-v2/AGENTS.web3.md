# Web3 Mainnet Micro-Test Agent Rules

These rules apply to EVM/Web3 projects that use this template. They are designed for real mainnet micro-tests with strict budget limits.

## Activation

Only enter execution mode when the user explicitly says one of:

- 开始做
- 开工
- 创建这个 Web3 项目
- 开始构造合约
- 开始部署
- 开始测试
- 执行 mainnet micro test
- 按 mainnet micro-test 流程执行

Normal discussion, planning, copywriting, and mechanism review do not create files, deploy contracts, or send transactions.

## Env Initialization

When execution mode starts in a Web3/EVM project and `.env` does not exist:

1. Create `.env` from `.env.example` if possible.
2. Ensure `.gitignore` ignores `.env`, `.env.*`, and `test-artifacts/`, while allowing `.env.example`.
3. Run `chmod 600 .env`.
4. Open `.env` locally for the user to fill secrets.

Never ask the user to paste `PRIVATE_KEY` into chat.
Never print `PRIVATE_KEY` in logs, reports, terminal output summaries, or final responses.
It is OK to print the derived wallet address.

Default supported chains:

- BSC: chainId `56`
- Ethereum: chainId `1`
- Base: chainId `8453`

Default free explorer API key:

```env
EXPLORER_API_KEY=REMOVED_FROM_GITHUB
```

Use it as the default for explorer verification/querying unless the project overrides it.
RPC URLs are separate and must be supplied in `.env`.

## Mandatory Circuit Breaker Rules

Every contract design, tokenomics setting, deployment plan, and mainnet micro-test must include an emergency termination / Circuit Breaker plan by default.

Before deployment or test execution, verify and document:

- the breaker mechanism name, such as `pause`, `emergencyStop`, `tradingEnabled`, withdrawal lock, or another project-specific stop control
- which user-facing functions are blocked when triggered
- which recovery/admin functions remain callable
- who can trigger and clear the breaker: owner, multisig, timelock, guardian, or no-admin immutable design
- required events emitted on trigger and recovery
- tests proving activation, blocked actions, allowed recovery actions, resume/unpause, and unauthorized-call reverts

The breaker must be transparent and narrowly scoped, not a hidden rug/backdoor. If a breaker is intentionally not possible because the contract is immutable or fully permissionless, mark it explicitly as `N/A - immutable/no-admin`, explain the residual risk, and do not silently omit it.

## Mandatory Mainnet Safety Rules

Before any mainnet transaction, check:

- `TARGET_CHAIN`
- expected `CHAIN_ID`
- actual RPC `chainId`
- RPC URL exists and responds
- `PRIVATE_KEY` exists
- deployer address derived from `PRIVATE_KEY`
- deployer balance
- `DEV_WALLET` exists
- `MARKETING_WALLET` exists
- `MICRO_TEST=true`
- contract/deployment name contains `TEST` or `MicroTest`
- deployment parameters are micro-test parameters

Do not use production large-value parameters.
Do not auto-increase budget limits.
Do not use a primary wallet for testing.
Do not modify production deployment/config files unless a backup is created first.

Budget limits:

- Max native value per tx: `0.0001`
- Max total native spend budget: `0.001`
- Max gas cost per tx: configured by `MAX_GAS_COST_PER_TX_NATIVE`
- Stop if estimated gas + already spent exceeds total budget
- Stop if gas is unusually high

Important: native `value` and gas cost are different. A transaction with `value=0` still spends gas.

## Transaction Preflight Print

Before every transaction, print:

- operation name
- function call
- target contract
- native value
- estimated gas units
- max fee / gas price
- estimated max gas cost
- current cumulative spend
- expected result

If any assertion fails, stop immediately and do not continue spending gas.

## Deployment Rules

Mainnet micro-test deployment must:

- use a contract name containing `TEST` or `MicroTest`
- use tiny mint price / tiny cap / tiny hard cap
- preserve real logic for wallet limit, tax, rewards, burn, marketing wallet, LP and liquidity mechanisms
- never overwrite production deployment files
- save deployment data to `deployments/mainnet-micro-test.json`

If estimated deployment gas exceeds budget, stop and report. Do not deploy.

## Contract Test Rules

Inspect source, ABI, tests, and docs first. Test every feature that exists or is claimed by the project:

- deploy
- mint 1 unit
- same-wallet mint limit
- over-limit mint revert
- hard cap stop
- transfer
- approve
- buy
- sell
- tax distribution
- marketing wallet receipt
- reward/dividend accounting
- claim reward
- burn
- buyback/burn
- LP / liquidity / pool balance changes
- only token burn, not native pool burn
- owner/dev permissions
- pause/unpause if present
- withdraw if present

For each test, record:

- balances before
- balances after
- tx hash
- assertions
- failure reason if any

If a feature does not exist, mark `N/A`.
If a feature is claimed but cannot be verified, mark `FAIL`.

## Frontend Connectivity Test Rules

Check:

- frontend reads the micro-test contract address
- ABI matches deployed bytecode/interface
- wallet connection works
- current network is correct
- page data reads from chain
- mint/buy/sell/claim buttons call expected functions
- error messages are readable

Do not overwrite production frontend config. Use `.env.microtest.local` or equivalent test config when needed.

## Real Browser Human-Click Test Rules

Use Playwright or an equivalent browser tool when available.

Test:

- open the site
- connect wallet
- switch network
- click mint/buy/sell/claim main buttons
- confirm transaction when safe
- wait for chain confirmation
- refresh page and confirm data changed
- save screenshots to `test-artifacts/screenshots/`
- save trace/video to `test-artifacts/` when available

If wallet popup confirmation cannot be automated safely, pause for manual user confirmation and clearly record it in the report.

## Residual Exposure Check

After tests, check and report:

- deployer remaining test token balance
- deployer remaining LP token balance
- test contract native balance
- expected marketing/dev wallet receipts
- V2 LP residue
- Pancake Infinity / CL / Seeder-style residual positions if relevant
- whether residuals are removable, who controls them, and approximate value

Do not assume cleanup is complete only because the deployer token balance is zero.

## Final Report

Generate `MAINNET_MICRO_TEST_REPORT.md` with:

- chain
- chainId
- deployment address
- test wallet address
- total estimated and actual spend
- each tx hash
- each function test result
- frontend screenshots
- trace/video paths
- failed items
- risk points
- residual exposure check
- whether it can proceed to production deployment
- next recommended steps

Final conclusion must be one of:

- PASS
- FAIL
- PARTIAL - FIX REQUIRED
