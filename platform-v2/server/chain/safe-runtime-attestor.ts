import { getAddress, keccak256, toUtf8Bytes, type InterfaceAbi } from 'ethers';
import { CoreError } from '../api/errors.ts';
import type { SafeRuntimeEvidence } from '../data/settlement-service.ts';
import {
  MULTISEND_CALL_ONLY_ADDRESS,
  MULTISEND_CALL_ONLY_CODE_HASH,
  SAFE_L2_SINGLETON_ADDRESS,
  SAFE_L2_SINGLETON_CODE_HASH,
  SAFE_VERSION,
  ZERO_ADDRESS,
} from './safe-multisend.ts';

const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001';
const GUARD_STORAGE_SLOT = BigInt('0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8');
const FALLBACK_HANDLER_STORAGE_SLOT = BigInt('0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5');
const SAFE_ABI = [
  'function VERSION() view returns (string)',
  'function masterCopy() view returns (address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function getStorageAt(uint256 offset,uint256 length) view returns (bytes)',
];

export interface SafeRuntimeReader {
  chainId(): Promise<number>;
  codeHash(address: string): Promise<string>;
  call(address: string, abi: InterfaceAbi, method: string, args: readonly unknown[]): Promise<unknown>;
}

export interface SafeRuntimeExpectations {
  safeAddress: string;
  safeProxyCodeHash: string;
  ownerSetHash: string;
  threshold: number;
  guardAddress: string;
  fallbackHandlerAddress: string;
  modulesHash: string;
  tokenAddress: string;
  tokenCodeHash: string;
  tokenTransferConformanceEvidenceHash: string;
}

export class RpcSafeRuntimeAttestor {
  readonly #reader: SafeRuntimeReader;
  readonly #expected: SafeRuntimeExpectations;
  readonly #clock: () => Date;

  constructor(input: {
    reader: SafeRuntimeReader;
    expected: SafeRuntimeExpectations;
    clock?: () => Date;
  }) {
    this.#reader = input.reader;
    this.#expected = validateExpectations(input.expected);
    this.#clock = input.clock ?? (() => new Date());
  }

  async attest(): Promise<SafeRuntimeEvidence> {
    const safe = this.#expected.safeAddress;
    const [
      chainId,
      version,
      singleton,
      ownersValue,
      thresholdValue,
      nonceValue,
      modulesValue,
      guardStorage,
      fallbackStorage,
      safeProxyCode,
      singletonCode,
      multisendCode,
      tokenCode,
    ] = await Promise.all([
      this.#reader.chainId(),
      this.#reader.call(safe, SAFE_ABI, 'VERSION', []),
      this.#reader.call(safe, SAFE_ABI, 'masterCopy', []),
      this.#reader.call(safe, SAFE_ABI, 'getOwners', []),
      this.#reader.call(safe, SAFE_ABI, 'getThreshold', []),
      this.#reader.call(safe, SAFE_ABI, 'nonce', []),
      this.#reader.call(safe, SAFE_ABI, 'getModulesPaginated', [SENTINEL_MODULES, 100]),
      this.#reader.call(safe, SAFE_ABI, 'getStorageAt', [GUARD_STORAGE_SLOT, 1]),
      this.#reader.call(safe, SAFE_ABI, 'getStorageAt', [FALLBACK_HANDLER_STORAGE_SLOT, 1]),
      this.#reader.codeHash(safe),
      this.#reader.codeHash(SAFE_L2_SINGLETON_ADDRESS),
      this.#reader.codeHash(MULTISEND_CALL_ONLY_ADDRESS),
      this.#reader.codeHash(this.#expected.tokenAddress),
    ]);
    const owners = addresses(ownersValue, 'Safe owners').sort();
    const threshold = positiveInteger(thresholdValue, 'Safe threshold');
    const nonce = nonnegativeInteger(nonceValue, 'Safe nonce');
    const [modules, next] = modulePage(modulesValue);
    const guard = storageAddress(guardStorage, 'Safe guard');
    const fallbackHandler = storageAddress(fallbackStorage, 'Safe fallback handler');
    const ownerSetHash = hashJson({ owners, threshold });
    const modulesHash = hashJson(modules.slice().sort());
    const evidence = {
      chainId,
      safeAddress: safe,
      version: String(version),
      singleton: address(String(singleton), 'Safe singleton'),
      safeProxyCodeHash: runtimeHash(safeProxyCode, 'Safe proxy'),
      singletonCodeHash: runtimeHash(singletonCode, 'Safe singleton'),
      multisendAddress: MULTISEND_CALL_ONLY_ADDRESS,
      multisendCodeHash: runtimeHash(multisendCode, 'MultiSendCallOnly'),
      tokenAddress: this.#expected.tokenAddress,
      tokenCodeHash: runtimeHash(tokenCode, 'settlement token'),
      owners,
      ownerSetHash,
      threshold,
      nonce,
      modules,
      modulesHash,
      modulesNext: next,
      guard,
      fallbackHandler,
      tokenTransferConformanceEvidenceHash: this.#expected.tokenTransferConformanceEvidenceHash,
    };
    if (
      chainId !== 56
      || evidence.version !== SAFE_VERSION
      || evidence.singleton !== SAFE_L2_SINGLETON_ADDRESS
      || evidence.safeProxyCodeHash !== this.#expected.safeProxyCodeHash
      || evidence.singletonCodeHash !== SAFE_L2_SINGLETON_CODE_HASH
      || evidence.multisendCodeHash !== MULTISEND_CALL_ONLY_CODE_HASH
      || evidence.tokenCodeHash !== this.#expected.tokenCodeHash
      || ownerSetHash !== this.#expected.ownerSetHash
      || threshold !== this.#expected.threshold
      || modulesHash !== this.#expected.modulesHash
      || next !== SENTINEL_MODULES
      || guard !== this.#expected.guardAddress
      || fallbackHandler !== this.#expected.fallbackHandlerAddress
    ) throw new CoreError('ExternalBlocked', 'Safe runtime attestation does not match governed expectations', 503);
    const evidenceHash = hashJson(evidence);
    return {
      safeAddress: safe,
      safeVersion: SAFE_VERSION,
      singletonAddress: SAFE_L2_SINGLETON_ADDRESS,
      singletonCodeHash: SAFE_L2_SINGLETON_CODE_HASH,
      safeNonce: nonce,
      ownerSetHash,
      approvalThreshold: threshold,
      multisendAddress: MULTISEND_CALL_ONLY_ADDRESS,
      multisendCodeHash: MULTISEND_CALL_ONLY_CODE_HASH,
      tokenCodeHash: evidence.tokenCodeHash,
      tokenTransferConformanceEvidenceHash: this.#expected.tokenTransferConformanceEvidenceHash,
      evidenceHash,
      checkedAt: this.#clock(),
    };
  }
}

function validateExpectations(value: SafeRuntimeExpectations): SafeRuntimeExpectations {
  const result = {
    ...value,
    safeAddress: address(value.safeAddress, 'Safe'),
    guardAddress: address(value.guardAddress, 'Safe guard'),
    fallbackHandlerAddress: address(value.fallbackHandlerAddress, 'Safe fallback handler'),
    tokenAddress: address(value.tokenAddress, 'settlement token'),
    safeProxyCodeHash: hash(value.safeProxyCodeHash, 'Safe proxy code hash'),
    ownerSetHash: hash(value.ownerSetHash, 'Safe owner set hash'),
    modulesHash: hash(value.modulesHash, 'Safe modules hash'),
    tokenCodeHash: hash(value.tokenCodeHash, 'token code hash'),
    tokenTransferConformanceEvidenceHash: hash(
      value.tokenTransferConformanceEvidenceHash,
      'token transfer conformance evidence hash',
    ),
  };
  if (!Number.isSafeInteger(result.threshold) || result.threshold <= 0) {
    throw new CoreError('ExternalBlocked', 'Safe threshold expectation is unavailable', 503);
  }
  return result;
}

function modulePage(value: unknown): [string[], string] {
  if (!Array.isArray(value) || !Array.isArray(value[0]) || typeof value[1] !== 'string') {
    throw new CoreError('InvalidFinality', 'Safe module page is malformed', 409);
  }
  return [addresses(value[0], 'Safe modules'), address(value[1], 'Safe module cursor')];
}

function addresses(value: unknown, name: string) {
  if (!Array.isArray(value)) throw new CoreError('InvalidFinality', `${name} are malformed`, 409);
  const result = value.map((item) => address(String(item), name));
  if (new Set(result).size !== result.length) throw new CoreError('InvalidFinality', `${name} contain duplicates`, 409);
  return result;
}

function storageAddress(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new CoreError('InvalidFinality', `${name} storage is malformed`, 409);
  }
  return address(`0x${value.slice(-40)}`, name);
}

function positiveInteger(value: unknown, name: string) {
  const result = nonnegativeInteger(value, name);
  if (result === '0') throw new CoreError('InvalidFinality', `${name} must be positive`, 409);
  const number = Number(result);
  if (!Number.isSafeInteger(number)) throw new CoreError('InvalidFinality', `${name} is too large`, 409);
  return number;
}

function nonnegativeInteger(value: unknown, name: string) {
  const result = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new CoreError('InvalidFinality', `${name} is malformed`, 409);
  return result;
}

function runtimeHash(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new CoreError('ExternalBlocked', `${name} runtime code hash is unavailable`, 503);
  }
  return value.toLowerCase();
}

function address(value: string, name: string) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new CoreError('ExternalBlocked', `${name} address is unavailable`, 503);
  }
}

function hash(value: string, name: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new CoreError('ExternalBlocked', `${name} is unavailable`, 503);
  return value.toLowerCase();
}

function hashJson(value: unknown) {
  return keccak256(toUtf8Bytes(stableJson(value))).toLowerCase();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const emptySafeModulesHash = hashJson([]);
export const zeroSafeAddress = ZERO_ADDRESS;
