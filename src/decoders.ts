import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Manual Borsh decoders for marketplace accounts that are NOT in the runtime's
 * bundled (legacy) IDL: TaskJobSpec, TaskValidationConfig, TaskSubmission and
 * TaskModeration. Adapted from agenc-public-explorer task-validation.ts.
 *
 * Discriminators verified against agenc-protocol artifacts/anchor IDL
 * (2026-06-11): TaskJobSpec [249,63,211,94,228,165,3,196],
 * TaskValidationConfig [101,204,19,0,210,2,191,0],
 * TaskSubmission [111,64,190,132,148,33,215,63] (273 bytes),
 * TaskModeration [170,214,132,159,229,119,11,43].
 */

const TASK_VALIDATION_SEED = Buffer.from('task_validation');
const TASK_SUBMISSION_SEED = Buffer.from('task_submission');
const TASK_JOB_SPEC_SEED = Buffer.from('task_job_spec');
const TASK_MODERATION_SEED = Buffer.from('task_moderation');
const TASK_MODERATION_V2_SEED = Buffer.from('task_moderation_v2');

/**
 * P1.2 surface trust list for moderation projections: the global moderation
 * authority + the public attestation service (attest.agenc.ag), extendable
 * via TRUSTED_MODERATORS (comma-separated pubkeys). Records by anyone else
 * are not projected — mirroring what agenc.ag treats as hireable/claimable.
 */
export function trustedModerationModerators(): string[] {
  const extra = (process.env.TRUSTED_MODERATORS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [
    ...new Set([
      '9UEu2Gv9Q7DwBtumR2rUSq5g8v7b6mxn26ZNQCky82RJ', // global moderation authority
      '13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v', // attest.agenc.ag roster attestor
      ...extra,
    ]),
  ];
}

const TASK_VALIDATION_CONFIG_DISCRIMINATOR = Buffer.from([101, 204, 19, 0, 210, 2, 191, 0]);
const TASK_SUBMISSION_DISCRIMINATOR = Buffer.from([111, 64, 190, 132, 148, 33, 215, 63]);
const TASK_JOB_SPEC_DISCRIMINATOR = Buffer.from([249, 63, 211, 94, 228, 165, 3, 196]);
const TASK_MODERATION_DISCRIMINATOR = Buffer.from([170, 214, 132, 159, 229, 119, 11, 43]);

export const TASK_SUBMISSION_ACCOUNT_SIZE = 273;
const MAX_MULTIPLE_ACCOUNT_FETCH = 100;

export const MANUAL_VALIDATION_SENTINEL = Buffer.from('agenc-manual-validation-v2-seed!');

/** task_moderation_status constants (programs/agenc-coordination/src/state.rs). */
export const MODERATION_STATUS_CLEAN = 0;
export const MODERATION_STATUS_HUMAN_APPROVED = 4;

export type ValidationModeKey = 'auto' | 'creator_review' | 'validator_quorum' | 'external_attestation';

export type SubmissionStatusKey = 'idle' | 'submitted' | 'accepted' | 'rejected';

export type DecodedTaskValidationConfig = {
  pda: string;
  task: string;
  creator: string;
  modeKey: ValidationModeKey;
  reviewWindowSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type DecodedTaskSubmission = {
  pda: string;
  task: string;
  claim: string;
  worker: string;
  statusKey: SubmissionStatusKey;
  proofHashHex: string;
  submissionCount: number;
  submittedAt: number;
  reviewDeadlineAt: number;
  acceptedAt: number;
  rejectedAt: number;
};

export type DecodedTaskJobSpec = {
  pda: string;
  task: string;
  creator: string;
  jobSpecHash: Buffer;
  jobSpecHashHex: string;
  jobSpecUri: string;
  createdAt: number;
  updatedAt: number;
};

export type DecodedTaskModeration = {
  pda: string;
  task: string;
  creator: string;
  jobSpecHashHex: string;
  status: number;
  riskScore: number;
  recordedAt: number;
  expiresAt: number;
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function readPubkey(buffer: Buffer, offset: number): PublicKey {
  return new PublicKey(buffer.subarray(offset, offset + 32));
}

function readI64(buffer: Buffer, offset: number): number {
  return Number(buffer.readBigInt64LE(offset));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function assertDiscriminator(buffer: Buffer, discriminator: Buffer, accountName: string, pda: string): void {
  if (buffer.length < discriminator.length) {
    throw new Error(`${accountName} ${pda} is shorter than its discriminator`);
  }
  if (!buffer.subarray(0, discriminator.length).equals(discriminator)) {
    throw new Error(`${accountName} ${pda} discriminator mismatch`);
  }
}

function mapValidationMode(value: number): ValidationModeKey {
  switch (value) {
    case 0:
      return 'auto';
    case 1:
      return 'creator_review';
    case 2:
      return 'validator_quorum';
    case 3:
      return 'external_attestation';
    default:
      throw new Error(`Unknown validation mode tag: ${value}`);
  }
}

function mapSubmissionStatus(value: number): SubmissionStatusKey {
  switch (value) {
    case 0:
      return 'idle';
    case 1:
      return 'submitted';
    case 2:
      return 'accepted';
    case 3:
      return 'rejected';
    default:
      throw new Error(`Unknown submission status tag: ${value}`);
  }
}

export function decodeTaskValidationConfig(pda: PublicKey, buffer: Buffer): DecodedTaskValidationConfig {
  assertDiscriminator(buffer, TASK_VALIDATION_CONFIG_DISCRIMINATOR, 'TaskValidationConfig', pda.toBase58());

  let offset = TASK_VALIDATION_CONFIG_DISCRIMINATOR.length;
  const task = readPubkey(buffer, offset);
  offset += 32;
  const creator = readPubkey(buffer, offset);
  offset += 32;
  const modeKey = mapValidationMode(buffer.readUInt8(offset));
  offset += 1;
  const reviewWindowSeconds = readI64(buffer, offset);
  offset += 8;
  const createdAt = readI64(buffer, offset);
  offset += 8;
  const updatedAt = readI64(buffer, offset);

  return {
    pda: pda.toBase58(),
    task: task.toBase58(),
    creator: creator.toBase58(),
    modeKey,
    reviewWindowSeconds,
    createdAt,
    updatedAt,
  };
}

export function decodeTaskSubmission(pda: PublicKey, buffer: Buffer): DecodedTaskSubmission {
  assertDiscriminator(buffer, TASK_SUBMISSION_DISCRIMINATOR, 'TaskSubmission', pda.toBase58());

  let offset = TASK_SUBMISSION_DISCRIMINATOR.length;
  const task = readPubkey(buffer, offset);
  offset += 32;
  const claim = readPubkey(buffer, offset);
  offset += 32;
  const worker = readPubkey(buffer, offset);
  offset += 32;
  const statusKey = mapSubmissionStatus(buffer.readUInt8(offset));
  offset += 1;
  const proofHash = buffer.subarray(offset, offset + 32);
  offset += 32; // proof_hash
  offset += 64; // result_data
  const submissionCount = buffer.readUInt16LE(offset);
  offset += 2;
  const submittedAt = readI64(buffer, offset);
  offset += 8;
  const reviewDeadlineAt = readI64(buffer, offset);
  offset += 8;
  const acceptedAt = readI64(buffer, offset);
  offset += 8;
  const rejectedAt = readI64(buffer, offset);

  return {
    pda: pda.toBase58(),
    task: task.toBase58(),
    claim: claim.toBase58(),
    worker: worker.toBase58(),
    statusKey,
    proofHashHex: proofHash.some((byte) => byte !== 0) ? toHex(proofHash) : '',
    submissionCount,
    submittedAt,
    reviewDeadlineAt,
    acceptedAt,
    rejectedAt,
  };
}

export function decodeTaskJobSpec(pda: PublicKey, buffer: Buffer): DecodedTaskJobSpec {
  assertDiscriminator(buffer, TASK_JOB_SPEC_DISCRIMINATOR, 'TaskJobSpec', pda.toBase58());

  let offset = TASK_JOB_SPEC_DISCRIMINATOR.length;
  const task = readPubkey(buffer, offset);
  offset += 32;
  const creator = readPubkey(buffer, offset);
  offset += 32;
  const jobSpecHash = Buffer.from(buffer.subarray(offset, offset + 32));
  offset += 32;
  const uriLength = buffer.readUInt32LE(offset);
  offset += 4;
  if (offset + uriLength > buffer.length) {
    throw new Error(`TaskJobSpec ${pda.toBase58()} job_spec_uri exceeds account data length`);
  }
  const jobSpecUri = buffer.subarray(offset, offset + uriLength).toString('utf8');
  offset += uriLength;
  const createdAt = readI64(buffer, offset);
  offset += 8;
  const updatedAt = readI64(buffer, offset);

  return {
    pda: pda.toBase58(),
    task: task.toBase58(),
    creator: creator.toBase58(),
    jobSpecHash,
    jobSpecHashHex: toHex(jobSpecHash),
    jobSpecUri,
    createdAt,
    updatedAt,
  };
}

export function decodeTaskModeration(pda: PublicKey, buffer: Buffer): DecodedTaskModeration {
  assertDiscriminator(buffer, TASK_MODERATION_DISCRIMINATOR, 'TaskModeration', pda.toBase58());

  let offset = TASK_MODERATION_DISCRIMINATOR.length;
  const task = readPubkey(buffer, offset);
  offset += 32;
  const creator = readPubkey(buffer, offset);
  offset += 32;
  const jobSpecHash = buffer.subarray(offset, offset + 32);
  offset += 32;
  const status = buffer.readUInt8(offset);
  offset += 1;
  const riskScore = buffer.readUInt8(offset);
  offset += 1;
  offset += 8; // category_mask
  offset += 32; // policy_hash
  offset += 32; // scanner_hash
  const recordedAt = readI64(buffer, offset);
  offset += 8;
  const expiresAt = readI64(buffer, offset);

  return {
    pda: pda.toBase58(),
    task: task.toBase58(),
    creator: creator.toBase58(),
    jobSpecHashHex: toHex(jobSpecHash),
    status,
    riskScore,
    recordedAt,
    expiresAt,
  };
}

export function isModerationPass(moderation: DecodedTaskModeration, nowUnix: number): boolean {
  const statusOk =
    moderation.status === MODERATION_STATUS_CLEAN || moderation.status === MODERATION_STATUS_HUMAN_APPROVED;
  const unexpired = moderation.expiresAt === 0 || moderation.expiresAt > nowUnix;
  return statusOk && unexpired;
}

export function isManualValidationConstraintHash(value: Uint8Array | null | undefined): boolean {
  if (!value || value.length !== MANUAL_VALIDATION_SENTINEL.length) {
    return false;
  }
  return Buffer.from(value).equals(MANUAL_VALIDATION_SENTINEL);
}

export function isPrivateConstraintHash(value: Uint8Array | null | undefined): boolean {
  if (!value?.length) {
    return false;
  }
  if (!value.some((byte) => byte !== 0)) {
    return false;
  }
  return !isManualValidationConstraintHash(value);
}

export function deriveTaskValidationConfigPda(taskPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TASK_VALIDATION_SEED, taskPda.toBuffer()], programId)[0];
}

export function deriveTaskSubmissionPda(claimPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TASK_SUBMISSION_SEED, claimPda.toBuffer()], programId)[0];
}

export function deriveTaskJobSpecPda(taskPda: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([TASK_JOB_SPEC_SEED, taskPda.toBuffer()], programId)[0];
}

export function deriveTaskModerationPda(
  taskPda: PublicKey,
  jobSpecHash: Buffer,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [TASK_MODERATION_SEED, taskPda.toBuffer(), jobSpecHash],
    programId,
  )[0];
}

/**
 * All the addresses a trusted moderation record for (task, hash) can live at
 * post-P1.2, in trust order: the v2 moderator-keyed PDA for each trusted
 * moderator, then the FROZEN pre-upgrade legacy PDA (grace window).
 */
export function deriveTaskModerationCandidatePdas(
  taskPda: PublicKey,
  jobSpecHash: Buffer,
  programId: PublicKey,
): PublicKey[] {
  const v2 = trustedModerationModerators().map(
    (moderator) =>
      PublicKey.findProgramAddressSync(
        [
          TASK_MODERATION_V2_SEED,
          taskPda.toBuffer(),
          jobSpecHash,
          new PublicKey(moderator).toBuffer(),
        ],
        programId,
      )[0],
  );
  return [...v2, deriveTaskModerationPda(taskPda, jobSpecHash, programId)];
}

export async function fetchAccountsByPda(
  connection: Connection,
  pdas: readonly PublicKey[],
): Promise<Array<{ pda: PublicKey; data: Buffer }>> {
  const results: Array<{ pda: PublicKey; data: Buffer }> = [];
  const unique = new Map<string, PublicKey>();
  for (const pda of pdas) {
    unique.set(pda.toBase58(), pda);
  }

  for (const group of chunk([...unique.values()], MAX_MULTIPLE_ACCOUNT_FETCH)) {
    const infos = await connection.getMultipleAccountsInfo(group, 'confirmed');
    group.forEach((pda, index) => {
      const info = infos[index];
      if (!info) {
        return;
      }
      results.push({ pda, data: Buffer.from(info.data) });
    });
  }

  return results;
}
