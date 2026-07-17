import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes, type InterfaceAbi } from 'ethers';
import type { RuntimeReadinessSnapshot } from '../api/config.ts';
import { CORE_ARTIFACT_VERSION, NPL_ADDRESS, NPL_USDT_PAIR_ADDRESS, USDT_ADDRESS } from '../api/enums.ts';
import type { PaymentIndexerStatus } from './payment-indexer-worker.ts';
import type { ContractReader } from './payment-sources.ts';

const ROUTER_ABI = [
  'function usdt() view returns (address)',
  'function npl() view returns (address)',
  'function policyRegistry() view returns (address)',
  'function beneficiaryRegistry() view returns (address)',
  'function oracle() view returns (address)',
  'function governanceSafe() view returns (address)',
  'function platformServiceFeeSafe() view returns (address)',
  'function usdtCustodySafe() view returns (address)',
  'function nplRewardSafe() view returns (address)',
  'function operationsTreasurySafe() view returns (address)',
  'function quoteSigner() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
];
const POLICY_ABI = [
  'function safe() view returns (address)',
  'function secondarySigner() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
];
const BENEFICIARY_ABI = [
  'function policyRegistry() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
];
const ORACLE_ABI = ['function source() view returns (address)'];
const SOURCE_ABI = ['function pair() view returns (address)'];
const DEFAULT_ADMIN_ROLE = `0x${'0'.repeat(64)}`;

export interface RuntimeCodeReader extends ContractReader {
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
  safeAdminVerified: boolean;
  signerBindingsVerified: boolean;
  oracleDeploymentVerified: boolean;
  rpcChain56Healthy: boolean;
}

export class RpcPaymentRuntimeAttestor {
  readonly #reader: RuntimeCodeReader;
  readonly #deployments: readonly RuntimeDeploymentExpectation[];
  readonly #addresses: {
    router: string;
    policyRegistry: string;
    beneficiaryRegistry: string;
    oracle: string;
    twapSource: string;
    governanceSafe: string;
    platformServiceFeeSafe: string;
    usdtCustodySafe: string;
    nplRewardSafe: string;
    operationsTreasurySafe: string;
    secondarySigner: string;
    quoteSigner: string;
  };
  readonly #twapSourceCodeHash: string;

  constructor(input: {
    reader: RuntimeCodeReader;
    deployments: readonly RuntimeDeploymentExpectation[];
    router: string;
    policyRegistry: string;
    beneficiaryRegistry: string;
    oracle: string;
    twapSource: string;
    twapSourceCodeHash: string;
    governanceSafe: string;
    platformServiceFeeSafe: string;
    usdtCustodySafe: string;
    nplRewardSafe: string;
    operationsTreasurySafe: string;
    secondarySigner: string;
    quoteSigner: string;
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
      oracle: normalizedAddress(input.oracle),
      twapSource: normalizedAddress(input.twapSource),
      governanceSafe: normalizedAddress(input.governanceSafe),
      platformServiceFeeSafe: normalizedAddress(input.platformServiceFeeSafe),
      usdtCustodySafe: normalizedAddress(input.usdtCustodySafe),
      nplRewardSafe: normalizedAddress(input.nplRewardSafe),
      operationsTreasurySafe: normalizedAddress(input.operationsTreasurySafe),
      secondarySigner: normalizedAddress(input.secondarySigner),
      quoteSigner: normalizedAddress(input.quoteSigner),
    };
    this.#twapSourceCodeHash = normalizedHash(input.twapSourceCodeHash);
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
    const sourceCodeVerified = codeHash(await this.#reader.code(this.#addresses.twapSource))
      === this.#twapSourceCodeHash;

    const [
      routerUsdt,
      routerNpl,
      routerPolicy,
      routerBeneficiary,
      routerOracle,
      routerGovernanceSafe,
      routerPlatformServiceFeeSafe,
      routerUsdtSafe,
      routerNplSafe,
      routerOperationsSafe,
      routerQuoteSigner,
      policySafe,
      policySecondarySigner,
      beneficiaryPolicy,
      oracleSource,
      sourcePair,
    ] = await Promise.all([
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'usdt'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'npl'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'policyRegistry'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'beneficiaryRegistry'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'oracle'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'governanceSafe'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'platformServiceFeeSafe'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'usdtCustodySafe'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'nplRewardSafe'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'operationsTreasurySafe'),
      callAddress(this.#reader, this.#addresses.router, ROUTER_ABI, 'quoteSigner'),
      callAddress(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, 'safe'),
      callAddress(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, 'secondarySigner'),
      callAddress(this.#reader, this.#addresses.beneficiaryRegistry, BENEFICIARY_ABI, 'policyRegistry'),
      callAddress(this.#reader, this.#addresses.oracle, ORACLE_ABI, 'source'),
      callAddress(this.#reader, this.#addresses.twapSource, SOURCE_ABI, 'pair'),
    ]);

    const safeAdminVerified = routerGovernanceSafe === this.#addresses.governanceSafe
      && policySafe === this.#addresses.governanceSafe
      && routerPlatformServiceFeeSafe === this.#addresses.platformServiceFeeSafe
      && routerUsdtSafe === this.#addresses.usdtCustodySafe
      && routerNplSafe === this.#addresses.nplRewardSafe
      && routerOperationsSafe === this.#addresses.operationsTreasurySafe;
    const signerBindingsVerified = routerQuoteSigner === this.#addresses.quoteSigner
      && policySecondarySigner === this.#addresses.secondarySigner;
    const oracleDeploymentVerified = sourceCodeVerified
      && routerOracle === this.#addresses.oracle
      && oracleSource === this.#addresses.twapSource
      && sourcePair === NPL_USDT_PAIR_ADDRESS;
    const contractBindingsVerified = routerUsdt === USDT_ADDRESS
      && routerNpl === NPL_ADDRESS
      && routerPolicy === this.#addresses.policyRegistry
      && routerBeneficiary === this.#addresses.beneficiaryRegistry
      && beneficiaryPolicy === this.#addresses.policyRegistry;

    const roleChecks = await Promise.all([
      hasRole(this.#reader, this.#addresses.router, ROUTER_ABI, DEFAULT_ADMIN_ROLE, this.#addresses.governanceSafe),
      hasRole(this.#reader, this.#addresses.router, ROUTER_ABI, role('PAUSER_ROLE'), this.#addresses.governanceSafe),
      hasRole(this.#reader, this.#addresses.router, ROUTER_ABI, role('SESSION_ADMIN_ROLE'), this.#addresses.governanceSafe),
      hasRole(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, DEFAULT_ADMIN_ROLE, this.#addresses.governanceSafe),
      hasRole(this.#reader, this.#addresses.policyRegistry, POLICY_ABI, role('POLICY_PUBLISHER_ROLE'), this.#addresses.governanceSafe),
      hasRole(this.#reader, this.#addresses.beneficiaryRegistry, BENEFICIARY_ABI, DEFAULT_ADMIN_ROLE, this.#addresses.governanceSafe),
      hasRole(this.#reader, this.#addresses.beneficiaryRegistry, BENEFICIARY_ABI, role('REGISTRY_EDITOR_ROLE'), this.#addresses.governanceSafe),
    ]);

    return {
      deployedRuntimeCodeVerified: deployedRuntimeCodeVerified && contractBindingsVerified,
      roleGrantsVerified: roleChecks.every(Boolean),
      safeAdminVerified,
      signerBindingsVerified,
      oracleDeploymentVerified,
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
    safeAdminVerified: false,
    signerBindingsVerified: false,
    oracleDeploymentVerified: false,
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
