import { readFile } from 'node:fs/promises';
import { Interface, type InterfaceAbi, type LogDescription } from 'ethers';
import { CoreError } from '../api/errors.ts';

interface AbiBundle {
  artifactVersion: string;
  contracts: Record<string, InterfaceAbi>;
}

export interface IndexedLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  logIndex: number;
}

export interface DecodedDomainEvent {
  artifactVersion: string;
  contract: string;
  eventName: string;
  eventSignature: string;
  resourceId: string;
  contractAddress: string;
  eventHash: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  logIndex: number;
  values: Record<string, string>;
}

export class AbiEventDecoder {
  readonly #artifactVersion: string;
  readonly #contracts = new Map<string, { name: string; interface: Interface }>();

  private constructor(bundle: AbiBundle, deployments: Readonly<Record<string, string>>) {
    this.#artifactVersion = bundle.artifactVersion;
    for (const [name, address] of Object.entries(deployments)) {
      const abi = bundle.contracts[name];
      if (!abi) throw new CoreError('ArtifactVersionMismatch', `ABI missing for ${name}`, 500);
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new CoreError('ExternalBlocked', `Address missing for ${name}`, 503);
      this.#contracts.set(address.toLowerCase(), { name, interface: new Interface(abi) });
    }
  }

  static async load(path: string, deployments: Readonly<Record<string, string>>) {
    const bundle = JSON.parse(await readFile(path, 'utf8')) as AbiBundle;
    return new AbiEventDecoder(bundle, deployments);
  }

  decode(log: IndexedLog): DecodedDomainEvent | undefined {
    const deployment = this.#contracts.get(log.address.toLowerCase());
    if (!deployment) return undefined;
    let parsed: LogDescription | null;
    try {
      parsed = deployment.interface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      throw new CoreError('InvalidFinality', 'Log does not match the frozen ABI', 409, {
        address: log.address,
        transactionHash: log.transactionHash,
      });
    }
    if (!parsed) return undefined;
    const values: Record<string, string> = {};
    for (let index = 0; index < parsed.fragment.inputs.length; index += 1) {
      const input = parsed.fragment.inputs[index];
      if (!input) continue;
      const value = parsed.args[index];
      values[input.name || String(index)] = typeof value === 'bigint' ? value.toString() : String(value);
    }
    const first = parsed.args[0];
    const resourceId = typeof first === 'string' ? first : String(first);
    return {
      artifactVersion: this.#artifactVersion,
      contract: deployment.name,
      eventName: parsed.name,
      eventSignature: parsed.signature,
      resourceId,
      contractAddress: log.address.toLowerCase(),
      eventHash: log.topics[0] ?? '',
      transactionHash: log.transactionHash,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      values,
    };
  }
}
