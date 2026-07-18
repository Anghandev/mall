import { createHash, randomUUID } from 'node:crypto';
import { keccak256 } from 'ethers';
import { normalizeAddress } from '../api/auth.ts';
import { CORE_ARTIFACT_VERSION } from '../api/enums.ts';
import { CoreError } from '../api/errors.ts';
import { parsePaymentPolicySnapshot, paymentBeneficiarySetHash } from '../api/payment-policy.ts';
import {
  buildPolicyPublication,
  encodePolicyPublicationCalldata,
  verifyPolicyPublicationSignature,
} from '../api/policy-publication-signing.ts';
import {
  policyCalldataHash,
  type PolicyChainObservation,
  type PolicyEoaExecutor,
} from '../chain/policy-publication-worker.ts';
import type { FulfillmentActor } from './fulfillment-service.ts';
import type { SqlExecutor, SqlTransactionRunner } from './migrations.ts';
import { auditSourceId, enqueueAudit } from './audit-service.ts';

interface DraftPayload {
  rulesContentHash: string;
  policy: Record<string, unknown>;
}

interface PolicyDraftRow {
  draft_id: string;
  next_policy_version: string | number;
  base_policy_version: string | number | null;
  payload: DraftPayload;
  validation_errors: unknown[];
  state: DraftState;
  secondary_signature_hash: string | null;
  execution_evidence_hash: string | null;
  artifact_version: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  policy_hash: string | null;
  operations_hash: string | null;
  publication_digest: string | null;
  publication_nonce: string | number | null;
  publication_deadline: Date | string | null;
  secondary_signer: string | null;
  secondary_signature: string | null;
  governance_wallet_address: string | null;
  execution_calldata: string | null;
  execution_calldata_hash: string | null;
  execution_tx_hash: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_final_execution_tx_hash?: string | null;
  last_final_block_number?: string | number | null;
  last_final_block_hash?: string | null;
}

type DraftState =
  | 'DRAFT'
  | 'DECISION_BLOCKED'
  | 'SECONDARY_SIGNED'
  | 'SUBMITTED'
  | 'FINALITY_PENDING'
  | 'REORGED'
  | 'REJECTED'
  | 'PUBLISHED';

export class PolicyService {
  readonly #transactions: SqlTransactionRunner;
  readonly #executor: PolicyEoaExecutor;
  readonly #executionGasLimit: string;
  readonly #policyRegistryAddress: string;
  readonly #governanceWallet: string;
  readonly #secondarySigner: string;
  readonly #decisionBlocked: readonly string[];
  readonly #auditReady: () => boolean | Promise<boolean>;
  readonly #clock: () => Date;

  constructor(input: {
    transactions: SqlTransactionRunner;
    executor: PolicyEoaExecutor;
    executionGasLimit: string;
    policyRegistryAddress: string;
    governanceWallet: string;
    secondarySigner: string;
    decisionBlocked?: readonly string[];
    auditReady: () => boolean | Promise<boolean>;
    clock?: () => Date;
  }) {
    this.#transactions = input.transactions;
    this.#executor = input.executor;
    if (!/^[1-9][0-9]*$/.test(input.executionGasLimit)) {
      throw new CoreError('InvalidRequest', 'Policy execution Gas limit is invalid', 500);
    }
    this.#executionGasLimit = input.executionGasLimit;
    this.#policyRegistryAddress = normalizeAddress(input.policyRegistryAddress);
    this.#governanceWallet = normalizeAddress(input.governanceWallet);
    this.#secondarySigner = normalizeAddress(input.secondarySigner);
    this.#decisionBlocked = Object.freeze([...(input.decisionBlocked ?? [])]);
    this.#auditReady = input.auditReady;
    this.#clock = input.clock ?? (() => new Date());
  }

  createDraft(
    actor: FulfillmentActor,
    input: { payload: unknown; idempotencyKey: string; correlationId: string },
  ) {
    const wallet = normalizeAddress(actor.walletAddress);
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    validateIdempotencyKey(input.idempotencyKey);
    const payload = draftPayload(input.payload);
    const requestHash = hashJson({ wallet, payload });
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const existing = await executor.query<PolicyDraftRow>(
        `SELECT * FROM core.policy_drafts
         WHERE created_by = $1 AND idempotency_key = $2`,
        [wallet, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new CoreError('IdempotencyConflict', 'Policy draft idempotency conflict', 409);
        }
        return this.getDraftInTransaction(executor, existing.rows[0].draft_id);
      }
      const active = await latestCanonicalPolicy(executor);
      const nextPolicyVersion = (active?.policyVersion ?? 0) + 1;
      const basePolicyVersion = active?.policyVersion ?? null;
      const validation = await validateDraft(executor, payload, nextPolicyVersion, this.#decisionBlocked);
      const state: DraftState = validation.errors.length > 0 ? 'DECISION_BLOCKED' : 'DRAFT';
      const draftId = `policy-draft:${randomUUID()}`;
      const now = this.#clock();
      await executor.query(
        `INSERT INTO core.policy_drafts (
           draft_id, next_policy_version, base_policy_version, payload,
           validation_errors, state, created_by, created_at, updated_at,
           artifact_version, idempotency_key, request_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)`,
        [
          draftId,
          nextPolicyVersion,
          basePolicyVersion,
          JSON.stringify(payload),
          JSON.stringify(validation.errors),
          state,
          wallet,
          now,
          CORE_ARTIFACT_VERSION,
          input.idempotencyKey,
          requestHash,
        ],
      );
      await appendDraftTransition(executor, {
        draftId,
        fromState: null,
        toState: state,
        actorWallet: wallet,
        evidence: { requestHash, validationErrors: validation.errors },
        now,
      });
      await enqueuePolicyRbacAudit(executor, {
        eventType: 'PolicyDraftCreated',
        draftId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { nextPolicyVersion, basePolicyVersion, state, validationErrors: validation.errors },
        now,
      });
      return this.getDraftInTransaction(executor, draftId);
    });
  }

  updateDraft(actor: FulfillmentActor, draftId: string, input: { payload: unknown; correlationId: string }) {
    const wallet = normalizeAddress(actor.walletAddress);
    requireSessionRole(actor, 'ADMIN', 'OPERATOR');
    const payload = draftPayload(input.payload);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN', 'OPERATOR']);
      const row = await lockedDraft(executor, draftId);
      if (!['DRAFT', 'DECISION_BLOCKED'].includes(row.state)) {
        throw new CoreError('InvalidRequest', 'Signed policy draft cannot be edited', 409);
      }
      await assertStillNextVersion(executor, row);
      const validation = await validateDraft(executor, payload, Number(row.next_policy_version), this.#decisionBlocked);
      const nextState: DraftState = validation.errors.length > 0 ? 'DECISION_BLOCKED' : 'DRAFT';
      const requestHash = hashJson({ wallet, payload });
      const now = this.#clock();
      await executor.query(
        `UPDATE core.policy_drafts SET payload = $2, validation_errors = $3,
           state = $4, request_hash = $5, updated_at = $6 WHERE draft_id = $1`,
        [draftId, JSON.stringify(payload), JSON.stringify(validation.errors), nextState, requestHash, now],
      );
      if (row.state !== nextState) {
        await appendDraftTransition(executor, {
          draftId,
          fromState: row.state,
          toState: nextState,
          actorWallet: wallet,
          evidence: { requestHash, validationErrors: validation.errors },
          now,
        });
      }
      await enqueuePolicyRbacAudit(executor, {
        eventType: 'PolicyDraftUpdated',
        draftId,
        actorWallet: wallet,
        roles,
        correlationId: input.correlationId,
        requestHash,
        payload: { nextPolicyVersion: Number(row.next_policy_version), state: nextState, validationErrors: validation.errors },
        now,
      });
      return this.getDraftInTransaction(executor, draftId);
    });
  }

  approvalChallenge(
    actor: FulfillmentActor,
    draftId: string,
    input: { nonce: string; deadline: string },
  ) {
    const wallet = normalizeAddress(actor.walletAddress);
    requireSessionRole(actor, 'ADMIN');
    const nonce = unsigned(input.nonce, 'policy publication nonce');
    const deadline = unsigned(input.deadline, 'policy publication deadline');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedDraft(executor, draftId);
      await assertSignable(executor, row, this.#decisionBlocked);
      validateDeadline(deadline, this.#clock());
      const material = await publicationMaterial(executor, row);
      const publication = buildPolicyPublication(material, nonce, deadline, this.#policyRegistryAddress);
      return Object.freeze({
        draftId,
        policyVersion: Number(row.next_policy_version),
        signer: this.#secondarySigner,
        typedData: {
          domain: publication.domain,
          types: {
            PolicyPublication: [
              { name: 'policyHash', type: 'bytes32' },
              { name: 'operationsHash', type: 'bytes32' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint64' },
            ],
          },
          primaryType: 'PolicyPublication',
          message: {
            policyHash: publication.policyHash,
            operationsHash: publication.operationsHash,
            nonce: nonce.toString(),
            deadline: deadline.toString(),
          },
        },
        digest: publication.digest,
      });
    });
  }

  submitSecondarySignature(
    actor: FulfillmentActor,
    draftId: string,
    input: { nonce: string; deadline: string; signature: string; correlationId: string },
  ) {
    const wallet = normalizeAddress(actor.walletAddress);
    requireSessionRole(actor, 'ADMIN');
    const nonce = unsigned(input.nonce, 'policy publication nonce');
    const deadline = unsigned(input.deadline, 'policy publication deadline');
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedDraft(executor, draftId);
      await assertSignable(executor, row, this.#decisionBlocked);
      validateDeadline(deadline, this.#clock());
      const material = await publicationMaterial(executor, row);
      const publication = buildPolicyPublication(material, nonce, deadline, this.#policyRegistryAddress);
      const signer = verifyPolicyPublicationSignature(publication, input.signature, this.#secondarySigner);
      const calldata = encodePolicyPublicationCalldata(publication, input.signature);
      const calldataHash = policyCalldataHash(calldata);
      const signatureHash = keccak256(input.signature).toLowerCase();
      const now = this.#clock();
      await executor.query(
        `UPDATE core.policy_drafts SET state = 'SECONDARY_SIGNED',
           policy_hash = $2, operations_hash = $3, publication_digest = $4,
           publication_nonce = $5, publication_deadline = $6,
           secondary_signer = $7, secondary_signature = $8,
           secondary_signature_hash = $9, governance_wallet_address = $10,
           execution_calldata = $11, execution_calldata_hash = $12, updated_at = $13
         WHERE draft_id = $1`,
        [
          draftId,
          publication.policyHash,
          publication.operationsHash,
          publication.digest,
          nonce.toString(),
          new Date(Number(deadline) * 1_000),
          signer,
          input.signature,
          signatureHash,
          this.#governanceWallet,
          calldata,
          calldataHash,
          now,
        ],
      );
      await appendDraftTransition(executor, {
        draftId,
        fromState: row.state,
        toState: 'SECONDARY_SIGNED',
        actorWallet: wallet,
        evidence: { digest: publication.digest, nonce: nonce.toString(), deadline: deadline.toString(), signatureHash },
        now,
      });
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:policy', { draftId, state: 'SECONDARY_SIGNED', digest: publication.digest }),
        streamName: 'governance',
        evidenceProfile: 'SIGNED_OFFCHAIN',
        eventType: 'PolicySecondarySigned',
        resourceType: 'POLICY_DRAFT',
        resourceId: draftId,
        actorWallet: wallet,
        actorRole: roles[0]!,
        correlationId: input.correlationId,
        requestHash: publication.digest.slice(2),
        payload: {
          policyVersion: Number(row.next_policy_version),
          policyHash: publication.policyHash,
          operationsHash: publication.operationsHash,
          governanceWallet: this.#governanceWallet,
          calldataHash,
        },
        signatureEvidence: {
          scheme: 'EIP712',
          signatureHash,
          signer,
          digest: publication.digest,
          domain: policyAuditDomain(this.#policyRegistryAddress),
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
        createdAt: now,
      });
      return this.getDraftInTransaction(executor, draftId);
    });
  }

  async execute(actor: FulfillmentActor, draftId: string, correlationId: string) {
    const wallet = normalizeAddress(actor.walletAddress);
    requireSessionRole(actor, 'ADMIN');
    if (!await this.#auditReady()) {
      throw new CoreError('ExternalBlocked', 'Audit database is unavailable for policy publication', 503);
    }
    const proposal = await this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedDraft(executor, draftId);
      if (row.state !== 'SECONDARY_SIGNED') {
        if (['SUBMITTED', 'FINALITY_PENDING', 'PUBLISHED'].includes(row.state)) return null;
        throw new CoreError('InvalidRequest', 'Policy draft is not secondary-signed', 409);
      }
      assertSignedFields(row);
      if (new Date(row.publication_deadline!).getTime() <= this.#clock().getTime()) {
        throw new CoreError('NonceExpired', 'Policy publication signature expired', 401);
      }
      return {
        draftId,
        policyVersion: Number(row.next_policy_version),
        governanceWallet: row.governance_wallet_address!,
        policyRegistryAddress: this.#policyRegistryAddress,
        calldata: row.execution_calldata!,
        calldataHash: row.execution_calldata_hash!,
        policyHash: row.policy_hash!,
        operationsHash: row.operations_hash!,
        gasLimit: this.#executionGasLimit,
      };
    });
    if (!proposal) return this.getDraft(actor, draftId);
    const result = await this.#executor.execute(proposal);
    return this.#transactions.transaction(async (executor) => {
      const roles = await requireCurrentRole(executor, wallet, ['ADMIN']);
      const row = await lockedDraft(executor, draftId);
      if (row.state !== 'SECONDARY_SIGNED') {
        if (row.execution_tx_hash === result.executionTxHash) return this.getDraftInTransaction(executor, draftId);
        throw new CoreError('IdempotencyConflict', 'Policy draft changed while EOA execution was in flight', 409);
      }
      assertSignedFields(row);
      if (row.execution_calldata_hash !== proposal.calldataHash) {
        throw new CoreError('IdempotencyConflict', 'Policy calldata changed while EOA execution was in flight', 409);
      }
      const now = this.#clock();
      await executor.query(
        `UPDATE core.policy_drafts SET state = 'SUBMITTED', execution_tx_hash = $2,
           execution_evidence_hash = $3, updated_at = $4 WHERE draft_id = $1`,
        [draftId, result.executionTxHash.toLowerCase(), result.executionEvidenceHash.toLowerCase(), now],
      );
      await appendDraftTransition(executor, {
        draftId,
        fromState: 'SECONDARY_SIGNED',
        toState: 'SUBMITTED',
        actorWallet: wallet,
        evidence: result,
        now,
      });
      await enqueueAudit(executor, {
        sourceEventId: auditSourceId('audit:policy', {
          draftId,
          state: 'SUBMITTED',
          executionEvidenceHash: result.executionEvidenceHash,
        }),
        streamName: 'governance',
        evidenceProfile: 'CHAIN_OBSERVED',
        eventType: 'PolicyExecutionSubmitted',
        resourceType: 'POLICY_DRAFT',
        resourceId: draftId,
        actorWallet: wallet,
        actorRole: roles[0]!,
        correlationId,
        requestHash: row.publication_digest!.slice(2),
        payload: {
          policyVersion: Number(row.next_policy_version),
          governanceWallet: row.governance_wallet_address,
          executionTxHash: result.executionTxHash,
          executorNonce: result.executorNonce,
          executionEvidenceHash: result.executionEvidenceHash,
          calldataHash: row.execution_calldata_hash,
        },
        signatureEvidence: policySignatureEvidence(row, this.#policyRegistryAddress),
        transactionEvidence: {
          txHash: result.executionTxHash,
          chainId: 56,
          contractAddress: this.#policyRegistryAddress,
          selector: row.execution_calldata!.slice(0, 10),
          calldataHash: row.execution_calldata_hash!,
          resourceId: draftId,
          policyVersion: Number(row.next_policy_version),
        },
        createdAt: now,
      });
      return this.getDraftInTransaction(executor, draftId);
    });
  }

  getDraft(actor: FulfillmentActor, draftId: string) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, normalizeAddress(actor.walletAddress), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      return this.getDraftInTransaction(executor, draftId);
    });
  }

  listDrafts(actor: FulfillmentActor) {
    requireSessionRole(actor, 'ADMIN', 'OPERATOR', 'AUDITOR');
    return this.#transactions.transaction(async (executor) => {
      await requireCurrentRole(executor, normalizeAddress(actor.walletAddress), ['ADMIN', 'OPERATOR', 'AUDITOR']);
      const rows = await executor.query<PolicyDraftRow>(
        'SELECT * FROM core.policy_drafts ORDER BY created_at DESC, draft_id DESC LIMIT 100',
      );
      return rows.rows.map(draftProjection);
    });
  }

  pendingFinality(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('InvalidPolicyFinalityLimit');
    return this.#transactions.transaction(async (executor) => {
      const rows = await executor.query<PolicyDraftRow>(
        `SELECT draft.*,
                final.execution_tx_hash AS last_final_execution_tx_hash,
                final.block_number AS last_final_block_number,
                final.block_hash AS last_final_block_hash
         FROM core.policy_drafts draft
         LEFT JOIN LATERAL (
           SELECT execution_tx_hash, block_number, block_hash
           FROM core.policy_publication_transitions
           WHERE draft_id = draft.draft_id AND event_type = 'FINAL' AND canonical
           ORDER BY transition_sequence DESC
           LIMIT 1
         ) final ON true
         WHERE draft.state IN ('SUBMITTED', 'FINALITY_PENDING', 'REORGED', 'PUBLISHED')
         ORDER BY CASE WHEN draft.state IN ('PUBLISHED', 'REORGED') THEN 1 ELSE 0 END,
                  draft.updated_at, draft.draft_id
         LIMIT $1`,
        [limit],
      );
      return rows.rows.map((row) => {
        assertProposalFields(row);
        return Object.freeze({
          draftId: row.draft_id,
          policyVersion: Number(row.next_policy_version),
          executionTxHash: row.execution_tx_hash!,
          policyRegistryAddress: this.#policyRegistryAddress,
          executionCalldata: row.execution_calldata!,
          executionCalldataHash: row.execution_calldata_hash!,
          policyHash: row.policy_hash!,
          operationsHash: row.operations_hash!,
          decisionEvidenceHash: String(row.payload.policy.decisionEvidenceHash).toLowerCase(),
          governanceWallet: row.governance_wallet_address!,
          priorState: row.state as 'SUBMITTED' | 'FINALITY_PENDING' | 'REORGED' | 'PUBLISHED',
          ...(row.last_final_execution_tx_hash && row.last_final_block_number != null && row.last_final_block_hash
            ? {
              priorFinality: {
                executionTxHash: row.last_final_execution_tx_hash,
                blockNumber: Number(row.last_final_block_number),
                blockHash: row.last_final_block_hash,
              },
            }
            : {}),
        });
      });
    });
  }

  recordObservation(draftId: string, observation: PolicyChainObservation) {
    if (observation.state === 'NOT_FOUND') return Promise.resolve(undefined);
    return this.#transactions.transaction(async (executor) => {
      const row = await lockedDraft(executor, draftId);
      assertProposalFields(row);
      validateObservation(row, observation, this.#governanceWallet);
      const now = this.#clock();
      if (observation.state === 'MINED') {
        if (observation.confirmations >= 15) throw new CoreError('InvalidFinality', 'Mined policy must be reported FINAL at 15 confirmations');
        if (row.state === 'SUBMITTED' || row.state === 'REORGED') {
          await executor.query(
            "UPDATE core.policy_drafts SET state = 'FINALITY_PENDING', updated_at = $2 WHERE draft_id = $1",
            [draftId, now],
          );
          await appendDraftTransition(executor, {
            draftId,
            fromState: row.state,
            toState: 'FINALITY_PENDING',
            actorWallet: this.#governanceWallet,
            evidence: observation,
            now,
          });
        }
        await enqueuePolicyChainAudit(executor, row, observation, this.#policyRegistryAddress, now);
        return this.getDraftInTransaction(executor, draftId);
      }
      if (observation.state === 'REORGED') {
        const snapshot = await executor.query<{ policy_version: string | number }>(
          'SELECT policy_version FROM core.policy_snapshots WHERE policy_version = $1',
          [row.next_policy_version],
        );
        if (snapshot.rows[0]) {
          await insertPublicationTransition(executor, row, observation, now);
        }
        if (row.state !== 'REORGED') {
          await executor.query(
            "UPDATE core.policy_drafts SET state = 'REORGED', updated_at = $2 WHERE draft_id = $1",
            [draftId, now],
          );
          await appendDraftTransition(executor, {
            draftId,
            fromState: row.state,
            toState: 'REORGED',
            actorWallet: this.#governanceWallet,
            evidence: observation,
            now,
          });
        }
        await enqueuePolicyChainAudit(executor, row, observation, this.#policyRegistryAddress, now);
        return this.getDraftInTransaction(executor, draftId);
      }
      if (observation.confirmations < 15) throw new CoreError('FinalityPending', 'Policy publication has fewer than 15 confirmations', 409);
      const material = await publicationMaterial(executor, row);
      const publication = buildPolicyPublication(
        material,
        BigInt(String(row.publication_nonce)),
        BigInt(Math.floor(new Date(row.publication_deadline!).getTime() / 1_000)),
        this.#policyRegistryAddress,
      );
      const existing = await executor.query<{
        policy_hash: string;
        rules_content_hash: string;
        beneficiary_set_hash: string;
        payload: Record<string, unknown>;
      }>('SELECT * FROM core.policy_snapshots WHERE policy_version = $1', [row.next_policy_version]);
      if (existing.rows[0]) {
        if (
          existing.rows[0].policy_hash.toLowerCase() !== publication.policyHash
          || existing.rows[0].rules_content_hash.toLowerCase() !== material.rulesContentHash.toLowerCase()
          || existing.rows[0].beneficiary_set_hash.toLowerCase() !== material.beneficiarySetHash.toLowerCase()
          || canonicalJson(existing.rows[0].payload) !== canonicalJson(row.payload.policy)
        ) throw new CoreError('InvalidFinality', 'Existing policy snapshot conflicts with canonical publication', 409);
      } else {
        await executor.query(
          `INSERT INTO core.policy_snapshots (
             policy_version, artifact_version, policy_hash,
             rules_content_hash, beneficiary_set_hash, payload, publication_status,
             publication_tx_hash, effective_from, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'PUBLISHED',$7,$8,$8)`,
          [
            row.next_policy_version,
            CORE_ARTIFACT_VERSION,
            publication.policyHash,
            material.rulesContentHash.toLowerCase(),
            material.beneficiarySetHash.toLowerCase(),
            JSON.stringify(row.payload.policy),
            observation.executionTxHash.toLowerCase(),
            now,
          ],
        );
      }
      await insertPublicationTransition(executor, row, observation, now);
      if (row.state !== 'PUBLISHED') {
        await executor.query(
          "UPDATE core.policy_drafts SET state = 'PUBLISHED', updated_at = $2 WHERE draft_id = $1",
          [draftId, now],
        );
        await appendDraftTransition(executor, {
          draftId,
          fromState: row.state,
          toState: 'PUBLISHED',
          actorWallet: this.#governanceWallet,
          evidence: observation,
          now,
        });
      }
      await enqueuePolicyChainAudit(executor, row, observation, this.#policyRegistryAddress, now);
      return this.getDraftInTransaction(executor, draftId);
    });
  }

  private async getDraftInTransaction(executor: SqlExecutor, draftId: string) {
    const result = await executor.query<PolicyDraftRow>('SELECT * FROM core.policy_drafts WHERE draft_id = $1', [draftId]);
    if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Policy draft not found', 404);
    const transitions = await executor.query<{
      transition_id: string;
      from_state: string | null;
      to_state: string;
      evidence_hash: string;
      actor_wallet: string;
      created_at: Date | string;
    }>('SELECT * FROM core.policy_draft_transitions WHERE draft_id = $1 ORDER BY created_at, transition_id', [draftId]);
    return Object.freeze({ ...draftProjection(result.rows[0]), transitions: transitions.rows.map((item) => Object.freeze({
      transitionId: item.transition_id,
      fromState: item.from_state,
      toState: item.to_state,
      evidenceHash: item.evidence_hash,
      actorWallet: item.actor_wallet,
      createdAt: new Date(item.created_at).toISOString(),
    })) });
  }
}

async function validateDraft(
  executor: SqlExecutor,
  payload: DraftPayload,
  policyVersion: number,
  decisionBlocked: readonly string[],
) {
  const errors = decisionBlocked.map((item) => ({ code: 'DecisionBlocked', field: item }));
  let policy;
  try {
    policy = parsePaymentPolicySnapshot(policyVersion, payload.policy);
    buildPolicyPublication(
      {
        policy,
        rulesContentHash: payload.rulesContentHash,
        beneficiarySetHash: paymentBeneficiarySetHash(
          policy.genesisNodeDestinations,
          policy.operationsDestinations,
        ),
      },
      0n,
      1n,
      '0x0000000000000000000000000000000000000001',
    );
  } catch (error) {
    if (error instanceof CoreError && ['DecisionBlocked', 'ExternalBlocked'].includes(error.code)) {
      errors.push({ code: error.code, field: error.message });
      return { errors };
    }
    throw error;
  }
  const rules = await executor.query<{ version_id: string }>(
    `SELECT version.version_id FROM core.cms_versions version
     JOIN core.cms_entries entry ON entry.entry_id = version.entry_id
     WHERE entry.content_type = 'SECKILL_RULES' AND version.content_hash = $1
     LIMIT 1`,
    [payload.rulesContentHash.toLowerCase()],
  );
  if (!rules.rows[0]) errors.push({ code: 'DecisionBlocked', field: 'rulesContentHash' });
  return { errors, policy };
}

async function publicationMaterial(executor: SqlExecutor, row: PolicyDraftRow) {
  const validation = await validateDraft(executor, row.payload, Number(row.next_policy_version), []);
  if (validation.errors.length > 0 || !validation.policy) {
    throw new CoreError('DecisionBlocked', 'Policy draft still has unresolved publication inputs', 409, {
      validationErrors: validation.errors,
    });
  }
  return {
    policy: validation.policy,
    rulesContentHash: row.payload.rulesContentHash.toLowerCase(),
    beneficiarySetHash: paymentBeneficiarySetHash(
      validation.policy.genesisNodeDestinations,
      validation.policy.operationsDestinations,
    ),
  };
}

async function assertSignable(executor: SqlExecutor, row: PolicyDraftRow, decisionBlocked: readonly string[]) {
  if (!['DRAFT', 'DECISION_BLOCKED'].includes(row.state)) {
    throw new CoreError('InvalidRequest', 'Policy draft is not signable', 409);
  }
  await assertStillNextVersion(executor, row);
  const validation = await validateDraft(executor, row.payload, Number(row.next_policy_version), decisionBlocked);
  if (validation.errors.length > 0) {
    throw new CoreError('DecisionBlocked', 'Policy draft has unresolved decisions', 409, {
      validationErrors: validation.errors,
    });
  }
}

async function assertStillNextVersion(executor: SqlExecutor, row: PolicyDraftRow) {
  const latest = await latestCanonicalPolicy(executor);
  if ((latest?.policyVersion ?? 0) + 1 !== Number(row.next_policy_version)) {
    throw new CoreError('ArtifactVersionMismatch', 'Policy draft is no longer the next canonical version', 409);
  }
}

async function latestCanonicalPolicy(executor: SqlExecutor) {
  const result = await executor.query<{ policy_version: string | number }>(
    `SELECT policy_version FROM core.canonical_policy_publications
     WHERE effective_from IS NULL OR effective_from <= clock_timestamp()
     ORDER BY policy_version DESC LIMIT 1`,
  );
  return result.rows[0] ? { policyVersion: Number(result.rows[0].policy_version) } : undefined;
}

async function lockedDraft(executor: SqlExecutor, draftId: string) {
  const result = await executor.query<PolicyDraftRow>(
    'SELECT * FROM core.policy_drafts WHERE draft_id = $1 FOR UPDATE',
    [draftId],
  );
  if (!result.rows[0]) throw new CoreError('InvalidRequest', 'Policy draft not found', 404);
  return result.rows[0];
}

async function enqueuePolicyRbacAudit(executor: SqlExecutor, input: {
  eventType: string;
  draftId: string;
  actorWallet: string;
  roles: string[];
  correlationId: string;
  requestHash: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  const evidenceHash = hashJson({
    wallet: input.actorWallet,
    roles: [...input.roles].sort(),
    checkedAt: input.now.toISOString(),
  });
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:policy', {
      eventType: input.eventType,
      draftId: input.draftId,
      requestHash: input.requestHash,
    }),
    streamName: 'governance',
    evidenceProfile: 'RBAC',
    eventType: input.eventType,
    resourceType: 'POLICY_DRAFT',
    resourceId: input.draftId,
    actorWallet: input.actorWallet,
    actorRole: input.roles[0]!,
    correlationId: input.correlationId,
    requestHash: input.requestHash.slice(2),
    payload: input.payload,
    authorizationEvidence: {
      scheme: 'RBAC_ROLE_REVALIDATION',
      subject: input.actorWallet,
      roles: input.roles,
      evidenceHash,
      checkedAt: input.now.toISOString(),
    },
    createdAt: input.now,
  });
}

function policySignatureEvidence(row: PolicyDraftRow, policyRegistryAddress: string) {
  if (
    !row.secondary_signature_hash
    || !row.secondary_signer
    || !row.publication_digest
    || row.publication_nonce === null
    || !row.publication_deadline
  ) throw new CoreError('InvalidFinality', 'Policy signature audit evidence is incomplete', 409);
  return {
    scheme: 'EIP712' as const,
    signatureHash: row.secondary_signature_hash,
    signer: row.secondary_signer,
    digest: row.publication_digest,
    domain: policyAuditDomain(policyRegistryAddress),
    nonce: String(row.publication_nonce),
    deadline: String(Math.floor(new Date(row.publication_deadline).getTime() / 1_000)),
  };
}

function policyAuditDomain(verifyingContract: string) {
  return `Abu24KPolicyRegistry:2:56:${normalizeAddress(verifyingContract)}`;
}

async function enqueuePolicyChainAudit(
  executor: SqlExecutor,
  row: PolicyDraftRow,
  observation: Exclude<PolicyChainObservation, { state: 'NOT_FOUND' }>,
  policyRegistryAddress: string,
  now: Date,
) {
  assertSignedFields(row);
  const requestHash = hashJson(observation);
  await enqueueAudit(executor, {
    sourceEventId: auditSourceId('audit:policy-chain', {
      draftId: row.draft_id,
      state: observation.state,
      requestHash,
    }),
    streamName: 'governance',
    evidenceProfile: observation.state === 'FINAL' ? 'CHAIN_FINAL' : 'CHAIN_OBSERVED',
    eventType: `Policy${observation.state === 'MINED' ? 'Mined' : observation.state === 'FINAL' ? 'Finalized' : 'Reorged'}`,
    resourceType: 'POLICY_DRAFT',
    resourceId: row.draft_id,
    actorWallet: row.governance_wallet_address!,
    actorRole: 'GOVERNANCE_EOA',
    correlationId: `policy-finality:${row.draft_id}`,
    requestHash: requestHash.slice(2),
    payload: {
      policyVersion: observation.policyVersion,
      executionTxHash: observation.executionTxHash,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash,
      canonicalBlockHash: 'canonicalBlockHash' in observation ? observation.canonicalBlockHash : undefined,
      confirmations: observation.confirmations,
      canonical: observation.canonical,
      policyHash: observation.policyHash,
      operationsHash: observation.operationsHash,
      decisionEvidenceHash: observation.decisionEvidenceHash,
    },
    signatureEvidence: policySignatureEvidence(row, policyRegistryAddress),
    transactionEvidence: {
      txHash: observation.executionTxHash!,
      chainId: 56,
      contractAddress: policyRegistryAddress,
      selector: row.execution_calldata!.slice(0, 10),
      calldataHash: row.execution_calldata_hash!,
      resourceId: row.draft_id,
      policyVersion: observation.policyVersion,
      blockHash: observation.blockHash!,
      confirmations: observation.confirmations,
    },
    createdAt: now,
  });
}

async function requireCurrentRole(executor: SqlExecutor, wallet: string, allowed: readonly string[]) {
  const result = await executor.query<{ role: string }>(
    `SELECT role FROM core.wallet_role_bindings
     WHERE lower(wallet_address) = $1 AND status = 'ACTIVE' AND role = ANY($2::text[])`,
    [wallet, [...allowed]],
  );
  if (!result.rows[0]) throw new CoreError('Forbidden', 'Current wallet role cannot govern policy', 403);
  return result.rows.map((row) => row.role);
}

function requireSessionRole(actor: FulfillmentActor, ...allowed: string[]) {
  if (!actor.roles.some((role) => allowed.includes(role))) {
    throw new CoreError('Forbidden', 'Wallet session cannot govern policy', 403);
  }
}

function draftPayload(value: unknown): DraftPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreError('InvalidRequest', 'Policy draft payload must be an object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['rulesContentHash', 'policy'].includes(key))) {
    throw new CoreError('InvalidRequest', 'Policy draft payload contains unknown fields');
  }
  if (!isHash(input.rulesContentHash)) {
    throw new CoreError('InvalidRequest', 'Policy draft rules hash is invalid');
  }
  if (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy)) {
    throw new CoreError('DecisionBlocked', 'Policy draft is missing policy fields', 409);
  }
  return {
    rulesContentHash: input.rulesContentHash.toLowerCase(),
    policy: input.policy as Record<string, unknown>,
  };
}

function draftProjection(row: PolicyDraftRow) {
  return Object.freeze({
    draftId: row.draft_id,
    nextPolicyVersion: String(row.next_policy_version),
    basePolicyVersion: row.base_policy_version === null ? null : String(row.base_policy_version),
    artifactVersion: row.artifact_version,
    payload: row.payload,
    validationErrors: row.validation_errors,
    state: row.state,
    policyHash: row.policy_hash,
    operationsHash: row.operations_hash,
    publicationDigest: row.publication_digest,
    publicationNonce: row.publication_nonce === null ? null : String(row.publication_nonce),
    publicationDeadline: row.publication_deadline ? new Date(row.publication_deadline).toISOString() : null,
    secondarySigner: row.secondary_signer,
    secondarySignatureHash: row.secondary_signature_hash,
    governanceWallet: row.governance_wallet_address,
    executionCalldataHash: row.execution_calldata_hash,
    executionTxHash: row.execution_tx_hash,
    executionEvidenceHash: row.execution_evidence_hash,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function assertProposalFields(row: PolicyDraftRow) {
  if (
    !row.execution_tx_hash
  ) throw new CoreError('InvalidFinality', 'Policy EOA execution evidence is incomplete', 409);
  assertSignedFields(row);
}

function assertSignedFields(row: PolicyDraftRow) {
  if (
    !row.governance_wallet_address || !row.execution_calldata || !row.execution_calldata_hash
    || !row.policy_hash || !row.operations_hash
  ) throw new CoreError('InvalidFinality', 'Policy secondary-signature evidence is incomplete', 409);
}

function validateObservation(row: PolicyDraftRow, observation: Exclude<PolicyChainObservation, { state: 'NOT_FOUND' }>, governanceWallet: string) {
  if (
    observation.executionTxHash.toLowerCase() !== row.execution_tx_hash?.toLowerCase()
    || observation.policyVersion !== Number(row.next_policy_version)
    || observation.policyHash.toLowerCase() !== row.policy_hash?.toLowerCase()
    || observation.operationsHash.toLowerCase() !== row.operations_hash?.toLowerCase()
    || observation.decisionEvidenceHash.toLowerCase() !== String(row.payload.policy.decisionEvidenceHash).toLowerCase()
    || normalizeAddress(observation.governanceExecutor) !== governanceWallet
    || !isHash(observation.decisionEvidenceHash)
    || !Number.isSafeInteger(observation.confirmations)
    || observation.confirmations < 0
    || (observation.state === 'REORGED'
      && observation.canonicalBlockHash !== undefined
      && !isHash(observation.canonicalBlockHash))
  ) throw new CoreError('InvalidFinality', 'Policy publication observation does not match the frozen proposal', 409);
  if (
    !isHash(observation.executionTxHash)
    || !isHash(observation.blockHash)
    || !Number.isSafeInteger(observation.blockNumber)
    || observation.blockNumber! < 0
  ) {
    throw new CoreError('InvalidFinality', 'Policy publication chain evidence is incomplete', 409);
  }
}

async function insertPublicationTransition(
  executor: SqlExecutor,
  row: PolicyDraftRow,
  observation: Exclude<PolicyChainObservation, { state: 'NOT_FOUND' | 'MINED' }>,
  now: Date,
) {
  const evidenceHash = hashJson(observation);
  const transitionId = `policy-publication:${hashJson({ draftId: row.draft_id, evidenceHash }).slice(2)}`;
  await executor.query(
    `INSERT INTO core.policy_publication_transitions (
       transition_id, policy_version, draft_id, event_type, submitted_execution_tx_hash,
       execution_tx_hash, block_number, block_hash, confirmations, canonical,
       evidence_hash, evidence, observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (policy_version, evidence_hash) DO NOTHING`,
    [
      transitionId,
      row.next_policy_version,
      row.draft_id,
      observation.state === 'FINAL' ? 'FINAL' : 'REORGED',
      observation.executionTxHash.toLowerCase(),
      observation.executionTxHash?.toLowerCase() ?? null,
      observation.blockNumber ?? null,
      observation.blockHash?.toLowerCase() ?? null,
      observation.confirmations,
      observation.canonical,
      evidenceHash,
      JSON.stringify(observation),
      now,
    ],
  );
}

async function appendDraftTransition(
  executor: SqlExecutor,
  input: {
    draftId: string;
    fromState: DraftState | null;
    toState: DraftState;
    actorWallet: string;
    evidence: unknown;
    now: Date;
  },
) {
  const evidenceHash = hashJson(input.evidence);
  await executor.query(
    `INSERT INTO core.policy_draft_transitions (
       transition_id, draft_id, from_state, to_state, evidence_hash,
       actor_wallet, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (draft_id, evidence_hash) DO NOTHING`,
    [
      `policy-draft-transition:${randomUUID()}`,
      input.draftId,
      input.fromState,
      input.toState,
      evidenceHash,
      normalizeAddress(input.actorWallet),
      input.now,
    ],
  );
}

function validateDeadline(deadline: bigint, now: Date) {
  const epoch = BigInt(Math.floor(now.getTime() / 1_000));
  if (deadline <= epoch) throw new CoreError('NonceExpired', 'Policy publication deadline expired', 401);
  if (deadline > epoch + 60n * 60n) {
    throw new CoreError('InvalidRequest', 'Policy publication deadline cannot exceed one hour');
  }
}

function validateIdempotencyKey(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new CoreError('InvalidRequest', 'Invalid policy idempotency key');
}

function unsigned(value: string, name: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new CoreError('InvalidRequest', `Invalid ${name}`);
  return BigInt(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function hashJson(value: unknown) {
  return `0x${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
