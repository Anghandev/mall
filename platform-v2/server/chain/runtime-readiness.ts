import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes, type InterfaceAbi } from 'ethers';
import type { RuntimeReadinessSnapshot } from '../api/config.ts';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, NPL_USDT_PAIR_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import type { PaymentIndexerStatus } from './payment-indexer-worker.ts';
import type { ContractReader, PairReserveReader } from './payment-sources.ts';

const ROUTER_ABI = [
  'function usdt() view returns (address)',
  'function npl() view returns (address)',
  'function policyRegistry() view returns (address)',
  'function beneficiaryRegistry() view returns (address)',
  'function governanceWallet() view returns (address)',
  'function platformServiceFeeWallet() view returns (address)',
  'function usdtSettlementWallet() view returns (address)',
  'function nplRewardWallet() view returns (address)',
  'function operationsWallet() view returns (address)',
  'function quoteSigner() view returns (address)',
];
const POLICY_ABI = [
  'function governanceWallet() view returns (address)',
  'function secondarySigner() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
];
const BENEFICIARY_ABI = [
  'function policyRegistry() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
];
const DEFAULT_ADMIN_ROLE = `0x${'0'.repeat(64)}`;

export interface RuntimeCodeReader extends PairReserveReader {
  chainId(): Promise<number>;
  code(address: string): Promise<string>;
}

export interface RuntimeDeploymentExpectation {
  name: string;
  address: string;
  deployedCodeHash: string;
}

export interface PaymentRuntimeAttestation {
  deployedRuntimeCodeVerified: boolean;
  roleGrantsVerified: boolean;
  walletRolesVerified: boolean;
  signerBindingsVerified: boolean;
  nplQuoteSourceHealthy: boolean;
  rpcChain56Healthy: boolean;
}

export class RpcPaymentRuntimeAttestor {
  readonly #reader: RuntimeCodeReader;
  readonly #deployments: readonly RuntimeDeploymentExpectation[];
  readonly #addresses: {
    router: string;
    policyRegistry: string;
    beneficiaryRegistry: string;
    governanceWallet: string;
    platformServiceFeeWallet: string;
    usdtSettlementWallet: string;
    nplRewardWallet: string;
    operationsWallet: string;
  };

  constructor(input: {
    reader: RuntimeCodeReader;
    deployments: readonly RuntimeDeploymentExpectation[];
    router: string;
    policyRegistry: string;
    beneficiaryRegistry: string;
    governanceWallet: string;
    platformServiceFeeWallet: string;
    usdtSettlementWallet: string;
    nplRewardWallet: string;
    operationsWallet: string;
  }) {
    this.#reader = input.reader;
    this.#deployments = input.deployments.map((deployment) => ({
      name: deployment.name,
      address: normalizedAddress(deployment.address),
      deployedCodeHash: normalizedHash(deployment.deployedCodeHash),
    }));
    if (this.#deployments.length === 0) throw new Error('Runtime deployments are unavailable');
    this.#addresses = {
      router: normalizedAddress(input.router),
      policyRegistry: normalizedAddress(input.policyRegistry),
      beneficiaryRegistry: normalizedAddress(input.beneficiaryRegistry),
      governanceWallet: normalizedAddress(input.governanceWallet),
      platformServiceFeeWallet: normalizedAddress(input.platformServiceFeeWallet),
      usdtSettlementWallet: normalizedAddress(input.usdtSettlementWallet),
      nplRewardWallet: normalizedAddress(input.nplRewardWallet),
      operationsWallet: normalizedAddress(input.operationsWallet),
    };
  }

  async attest(): Promise<PaymentRuntimeAttestation> {
    const rpcChain56Healthy = await this.#reader.chainId() === 56;
    const codeEntries = await Promise.all(this.#deployments.map(async (deployment) => ({
      ...deployment,
      actual: codeHash(await this.#reader.code(deployment.address)),
    })));
    const deployedRuntimeCodeVerified = codeEntries.every(
      (deployment) => deployment.actual === deployment.deployedCodeHash,
    );
    const [
      routerUsdt,
      routerNpl,
      routerPolicy,
      routerBeneficiary,
      routerGovernanceWallet,
      routerPlatformServiceFeeWallet,
      routerUsdtWallet,
      routerNplWallet,
      routerOperationsWallet,
      routerQuoteSigner,
      policyGovernanceWallet,
      policySecondarySigner,
      beneficiaryPolicy,
    ] = await Promise.all([
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'usdt'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'npl'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'policyRegistry'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'beneficiaryRegistry'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'governanceWallet'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'platformServiceFeeWallet'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'usdtSettlementWallet'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'nplRewardWallet'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'operationsWallet'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'quoteSigner'),
      callAddress(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, 'governanceWallet'),
      callAddress(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, 'secondarySigner'),
      callAddress(this.#reader, this.#addresses.beneficiaryRegistry, BENEFICIARY_ABI, 'policyRegistry'),
    ]);

    const pair = await this.#reader.pairReserves(NPL_USDT_PAIR_ADDRESS);
    const token0 = pair.token0.toLowerCase();
    const token1 = pair.token1.toLowerCase();
    const pairMatches = (token0 === USDT_ADDRESS && token1 === NPL_ADDRESS)
      || (token0 === NPL_ADDRESS && token1 === USDT_ADDRESS);
    const usdtLiquidity = token0 === USDT_ADDRESS ? pair.reserve0 : pair.reserve1;
    const nplQuoteSourceHealthy = pairMatches && pair.reserve0 > 0n && pair.reserve1 > 0n
      && usdtLiquidity >= 50_000n * 10n ** 18n;

    const roleAddresses = [
      this.#addresses.governanceWallet,
      this.#addresses.platformServiceFeeWallet,
      this.#addresses.usdtSettlementWallet,
      this.#addresses.nplRewardWallet,
      this.#addresses.operationsWallet,
    ];
    const roleCodes = await Promise.all(roleAddresses.map((address) => this.#reader.code(address)));
    const walletRolesVerified = roleCodes.every((code) => code === '0x')
      && routerGovernanceWallet === this.#addresses.governanceWallet
      && policyGovernanceWallet === this.#addresses.governanceWallet
      && routerPlatformServiceFeeWallet === this.#addresses.platformServiceFeeWallet
      && routerUsdtWallet === this.#addresses.usdtSettlementWallet
      && routerNplWallet === this.#addresses.nplRewardWallet
      && routerOperationsWallet === this.#addresses.operationsWallet;
    const signerBindingsVerified = routerQuoteSigner === this.#addresses.governanceWallet
      && policySecondarySigner === this.#addresses.governanceWallet;
    const contractBindingsVerified = routerUsdt === USDT_ADDRESS
      && routerNpl === NPL_ADDRESS
      && routerPolicy === this.#addresses.policyRegistry
      && routerBeneficiary === this.#addresses.beneficiaryRegistry
      && beneficiaryPolicy === this.#addresses.policyRegistry;

    const roleChecks = await Promise.all([
      hasRole(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, DEFAULT_ADMIN_ROLE, this.#addresses.governanceWallet),
      hasRole(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, role('POLICY_PUBLISHER_ROLE'), this.#addresses.governanceWallet),
      hasRole(this.#reader, this.#addresses.beneficiaryRegistry, BENEFICIARY_ABI, DEFAULT_ADMIN_ROLE, this.#addresses.governanceWallet),
      hasRole(this.#reader, this.#addresses.beneficiaryRegistry, BENEFICIARY_ABI, role('REGISTRY_EDITOR_ROLE'), this.#addresses.governanceWallet),
    ]);

    return {
      deployedRuntimeCodeVerified: deployedRuntimeCodeVerified && contractBindingsVerified,
      roleGrantsVerified: roleChecks.every(Boolean),
      walletRolesVerified,
      signerBindingsVerified,
      nplQuoteSourceHealthy,
      rpcChain56Healthy,
    };
  }
}

export class PaymentRuntimeReadinessMonitor {
  readonly #attest: () => Promise<PaymentRuntimeAttestation>;
  readonly #componentHashesVerified: () => Promise<boolean>;
  readonly #databaseHealthy: () => Promise<boolean>;
  readonly #redisHealthy: () => Promise<boolean>;
  readonly #signerHealthy: () => Promise<boolean>;
  readonly #indexerStatus: () => Readonly<PaymentIndexerStatus>;
  readonly #clock: () => Date;
  readonly #intervalMs: number;
  #base: Omit<RuntimeReadinessSnapshot, 'indexerHealthy'> | undefined;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(input: {
    attest: () => Promise<PaymentRuntimeAttestation>;
    componentHashesVerified: () => Promise<boolean>;
    databaseHealthy: () => Promise<boolean>;
    redisHealthy: () => Promise<boolean>;
    signerHealthy: () => Promise<boolean>;
    indexerStatus: () => Readonly<PaymentIndexerStatus>;
    clock?: () => Date;
    intervalMs?: number;
  }) {
    this.#attest = input.attest;
    this.#componentHashesVerified = input.componentHashesVerified;
    this.#databaseHealthy = input.databaseHealthy;
    this.#redisHealthy = input.redisHealthy;
    this.#signerHealthy = input.signerHealthy;
    this.#indexerStatus = input.indexerStatus;
    this.#clock = input.clock ?? (() => new Date());
    this.#intervalMs = input.intervalMs ?? 30_000;
  }

  snapshot(): RuntimeReadinessSnapshot | undefined {
    if (!this.#base) return undefined;
    const indexer = this.#indexerStatus();
    return Object.freeze({ ...this.#base, indexerHealthy: indexer.healthy && indexer.caughtUp });
  }

  async pollOnce() {
    const [attestation, componentHashesVerified, databaseHealthy, redisHealthy, signerHealthy] = await Promise.all([
      this.#attest().catch(() => failedAttestation()),
      booleanProbe(this.#componentHashesVerified),
      booleanProbe(this.#databaseHealthy),
      booleanProbe(this.#redisHealthy),
      booleanProbe(this.#signerHealthy),
    ]);
    const checkedAt = this.#clock();
    this.#base = {
      artifactVersion: CORE_ARTIFACT_VERSION,
      checkedAt: checkedAt.toISOString(),
      expiresAt: new Date(checkedAt.getTime() + this.#intervalMs * 2).toISOString(),
      componentHashesVerified,
      ...attestation,
      databaseHealthy,
      redisHealthy,
      signerHealthy,
    };
    return this.snapshot()!;
  }

  start() {
    if (this.#running) return;
    this.#controller = new AbortController();
    this.#running = this.#run(this.#controller.signal);
  }

  async stop() {
    this.#controller?.abort();
    await this.#running;
    this.#controller = undefined;
    this.#running = undefined;
  }

  async #run(signal: AbortSignal) {
    while (!signal.aborted) {
      await delay(this.#intervalMs, signal);
      if (!signal.aborted) await this.pollOnce();
    }
  }
}

export async function verifyArtifactChecksums(artifactRoot: string) {
  const checksumFile = await readFile(join(artifactRoot, 'SHA256SUMS'), 'utf8');
  const entries = checksumFile.trim().split('\n').filter(Boolean);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    const match = entry.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match?.[1] || !match[2] || match[2].includes('..')) return false;
    const actual = createHash('sha256').update(await readFile(join(artifactRoot, match[2]))).digest('hex');
    if (actual !== match[1]) return false;
  }
  return true;
}

function failedAttestation(): PaymentRuntimeAttestation {
  return {
    deployedRuntimeCodeVerified: false,
    roleGrantsVerified: false,
    walletRolesVerified: false,
    signerBindingsVerified: false,
    nplQuoteSourceHealthy: false,
    rpcChain56Healthy: false,
  };
}

async function booleanProbe(probe: () => Promise<boolean>) {
  try {
    return await probe() === true;
  } catch {
    return false;
  }
}

async function callAddress(
  reader: ContractReader,
  address: string,
  abi: InterfaceAbi,
  method: string,
) {
  return normalizedAddress(String(await reader.call(address, abi, method, [])));
}

async function hasRole(
  reader: ContractReader,
  address: string,
  abi: InterfaceAbi,
  roleHash: string,
  account: string,
) {
  return Boolean(await reader.call(address, abi, 'hasRole', [roleHash, account]));
}

function role(name: string) {
  return keccak256(toUtf8Bytes(name));
}

function codeHash(code: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(code) || code === '0x') return '';
  return keccak256(code).toLowerCase();
}

function normalizedAddress(value: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Invalid runtime address');
  return value.toLowerCase();
}

function normalizedHash(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid runtime code hash');
  return value.toLowerCase();
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
