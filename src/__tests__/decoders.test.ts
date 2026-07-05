/**
 * Manual Borsh decoder tests: every fixture account is ENCODED WITH THE SDK's
 * Codama-generated encoders (never hand-crafted bytes), then decoded through
 * the indexer's manual offset readers — so any drift between the on-chain
 * layout the SDK pins and the manual offsets here goes red.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  findTaskJobSpecPda,
  findTaskSubmissionPda,
  findTaskValidationConfigPda,
  getTaskJobSpecEncoder,
  getTaskModerationEncoder,
  getTaskSubmissionEncoder,
  getTaskSubmissionSize,
  getTaskValidationConfigEncoder,
  SubmissionStatus,
  ValidationMode,
} from '@tetsuo-ai/marketplace-sdk';
import {
  decodeTaskJobSpec,
  decodeTaskModeration,
  decodeTaskSubmission,
  decodeTaskValidationConfig,
  deriveTaskJobSpecPda,
  deriveTaskModerationCandidatePdas,
  deriveTaskModerationPda,
  deriveTaskSubmissionPda,
  deriveTaskValidationConfigPda,
  isManualValidationConstraintHash,
  isModerationPass,
  isPrivateConstraintHash,
  MANUAL_VALIDATION_SENTINEL,
  MODERATION_STATUS_CLEAN,
  MODERATION_STATUS_HUMAN_APPROVED,
  TASK_SUBMISSION_ACCOUNT_SIZE,
  trustedModerationModerators,
} from '../decoders.js';

const PROGRAM_ID = new PublicKey('HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK');
const TASK = 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2';
const CREATOR = 'AtPmace7uiCiTGeVuiP2dRsmDRKv1rTLR6zUE5caErBE';
const CLAIM = '13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v';
const WORKER = '9UEu2Gv9Q7DwBtumR2rUSq5g8v7b6mxn26ZNQCky82RJ';
const PDA = new PublicKey('GzdRn2tjuhDNLvg5U1gr1fyJDBVj9iAGJxM14qwkF6jD');

const HASH_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const HASH_HEX = Buffer.from(HASH_BYTES).toString('hex');

// -- TaskJobSpec ---------------------------------------------------------------

function encodeJobSpec(overrides: Partial<Parameters<ReturnType<typeof getTaskJobSpecEncoder>['encode']>[0]> = {}): Buffer {
  return Buffer.from(
    getTaskJobSpecEncoder().encode({
      task: TASK as never,
      creator: CREATOR as never,
      jobSpecHash: HASH_BYTES,
      jobSpecUri: 'https://example.com/spec.json',
      createdAt: 1_780_000_000n,
      updatedAt: 1_780_000_100n,
      bump: 254,
      reserved: new Uint8Array(7),
      ...overrides,
    }),
  );
}

test('decodeTaskJobSpec round-trips SDK-encoded bytes', () => {
  const decoded = decodeTaskJobSpec(PDA, encodeJobSpec());
  assert.deepEqual(decoded, {
    pda: PDA.toBase58(),
    task: TASK,
    creator: CREATOR,
    jobSpecHash: Buffer.from(HASH_BYTES),
    jobSpecHashHex: HASH_HEX,
    jobSpecUri: 'https://example.com/spec.json',
    createdAt: 1_780_000_000,
    updatedAt: 1_780_000_100,
  });
});

test('decodeTaskJobSpec rejects wrong discriminators and truncated buffers', () => {
  const wrong = encodeJobSpec();
  wrong[0] ^= 0xff;
  assert.throws(() => decodeTaskJobSpec(PDA, wrong), /discriminator mismatch/);
  assert.throws(() => decodeTaskJobSpec(PDA, Buffer.from([1, 2])), /shorter than its discriminator/);
});

test('decodeTaskJobSpec rejects a uri length that overruns the account data', () => {
  const bytes = encodeJobSpec();
  // Corrupt the SDK-encoded u32 uri length prefix (offset 8 + 32 + 32 + 32).
  bytes.writeUInt32LE(60_000, 104);
  assert.throws(() => decodeTaskJobSpec(PDA, bytes), /job_spec_uri exceeds account data length/);
});

// -- TaskValidationConfig --------------------------------------------------------

function encodeValidationConfig(mode: number): Buffer {
  return Buffer.from(
    getTaskValidationConfigEncoder().encode({
      task: TASK as never,
      creator: CREATOR as never,
      mode,
      reviewWindowSecs: 86_400n,
      createdAt: 1_780_000_000n,
      updatedAt: 1_780_000_200n,
      bump: 255,
      reserved: new Uint8Array(16),
    }),
  );
}

test('decodeTaskValidationConfig round-trips and maps all four modes', () => {
  const decoded = decodeTaskValidationConfig(PDA, encodeValidationConfig(ValidationMode.CreatorReview));
  assert.deepEqual(decoded, {
    pda: PDA.toBase58(),
    task: TASK,
    creator: CREATOR,
    modeKey: 'creator_review',
    reviewWindowSeconds: 86_400,
    createdAt: 1_780_000_000,
    updatedAt: 1_780_000_200,
  });

  const expectations = [
    [ValidationMode.Auto, 'auto'],
    [ValidationMode.CreatorReview, 'creator_review'],
    [ValidationMode.ValidatorQuorum, 'validator_quorum'],
    [ValidationMode.ExternalAttestation, 'external_attestation'],
  ] as const;
  for (const [mode, key] of expectations) {
    assert.equal(decodeTaskValidationConfig(PDA, encodeValidationConfig(mode)).modeKey, key);
  }
});

test('decodeTaskValidationConfig rejects an unknown mode tag', () => {
  const bytes = encodeValidationConfig(ValidationMode.Auto);
  bytes[8 + 32 + 32] = 9; // corrupt the mode byte
  assert.throws(() => decodeTaskValidationConfig(PDA, bytes), /Unknown validation mode tag: 9/);
});

// -- TaskSubmission ----------------------------------------------------------------

function encodeSubmission(overrides: { status?: number; proofHash?: Uint8Array } = {}): Buffer {
  return Buffer.from(
    getTaskSubmissionEncoder().encode({
      task: TASK as never,
      claim: CLAIM as never,
      worker: WORKER as never,
      status: overrides.status ?? SubmissionStatus.Submitted,
      proofHash: overrides.proofHash ?? HASH_BYTES,
      resultData: new Uint8Array(64),
      submissionCount: 3,
      submittedAt: 1_780_001_000n,
      reviewDeadlineAt: 1_780_087_400n,
      acceptedAt: 0n,
      rejectedAt: 0n,
      rejectionHash: new Uint8Array(32),
      bump: 253,
      reserved: new Uint8Array(5),
    }),
  );
}

test('SDK TaskSubmission size matches the manual 273-byte layout constant', () => {
  assert.equal(getTaskSubmissionSize(), TASK_SUBMISSION_ACCOUNT_SIZE);
  assert.equal(encodeSubmission().length, TASK_SUBMISSION_ACCOUNT_SIZE);
});

test('decodeTaskSubmission round-trips SDK-encoded bytes', () => {
  const decoded = decodeTaskSubmission(PDA, encodeSubmission());
  assert.deepEqual(decoded, {
    pda: PDA.toBase58(),
    task: TASK,
    claim: CLAIM,
    worker: WORKER,
    statusKey: 'submitted',
    proofHashHex: HASH_HEX,
    submissionCount: 3,
    submittedAt: 1_780_001_000,
    reviewDeadlineAt: 1_780_087_400,
    acceptedAt: 0,
    rejectedAt: 0,
  });
});

test('decodeTaskSubmission maps all statuses and blanks an all-zero proof hash', () => {
  const expectations = [
    [SubmissionStatus.Idle, 'idle'],
    [SubmissionStatus.Submitted, 'submitted'],
    [SubmissionStatus.Accepted, 'accepted'],
    [SubmissionStatus.Rejected, 'rejected'],
  ] as const;
  for (const [status, key] of expectations) {
    assert.equal(decodeTaskSubmission(PDA, encodeSubmission({ status })).statusKey, key);
  }
  assert.equal(
    decodeTaskSubmission(PDA, encodeSubmission({ proofHash: new Uint8Array(32) })).proofHashHex,
    '',
  );
  const bad = encodeSubmission();
  bad[8 + 96] = 7; // corrupt the status byte
  assert.throws(() => decodeTaskSubmission(PDA, bad), /Unknown submission status tag: 7/);
});

// -- TaskModeration ------------------------------------------------------------------

function encodeModeration(overrides: { status?: number; riskScore?: number; expiresAt?: bigint } = {}): Buffer {
  return Buffer.from(
    getTaskModerationEncoder().encode({
      task: TASK as never,
      creator: CREATOR as never,
      jobSpecHash: HASH_BYTES,
      status: overrides.status ?? MODERATION_STATUS_CLEAN,
      riskScore: overrides.riskScore ?? 12,
      categoryMask: 0n,
      policyHash: new Uint8Array(32),
      scannerHash: new Uint8Array(32),
      recordedAt: 1_780_002_000n,
      expiresAt: overrides.expiresAt ?? 1_790_000_000n,
      moderator: WORKER as never,
      bump: 252,
      reserved: new Uint8Array(16),
    }),
  );
}

test('decodeTaskModeration round-trips SDK-encoded bytes', () => {
  const decoded = decodeTaskModeration(PDA, encodeModeration());
  assert.deepEqual(decoded, {
    pda: PDA.toBase58(),
    task: TASK,
    creator: CREATOR,
    jobSpecHashHex: HASH_HEX,
    status: MODERATION_STATUS_CLEAN,
    riskScore: 12,
    recordedAt: 1_780_002_000,
    expiresAt: 1_790_000_000,
  });
  const wrong = encodeModeration();
  wrong[3] ^= 0x01;
  assert.throws(() => decodeTaskModeration(PDA, wrong), /discriminator mismatch/);
});

test('isModerationPass gates on status and expiry', () => {
  const now = 1_785_000_000;
  const clean = decodeTaskModeration(PDA, encodeModeration());
  assert.equal(isModerationPass(clean, now), true);

  const humanApproved = decodeTaskModeration(PDA, encodeModeration({ status: MODERATION_STATUS_HUMAN_APPROVED }));
  assert.equal(isModerationPass(humanApproved, now), true);

  const flagged = decodeTaskModeration(PDA, encodeModeration({ status: 2 }));
  assert.equal(isModerationPass(flagged, now), false);

  const expired = decodeTaskModeration(PDA, encodeModeration({ expiresAt: 10n }));
  assert.equal(isModerationPass(expired, now), false);

  const neverExpires = decodeTaskModeration(PDA, encodeModeration({ expiresAt: 0n }));
  assert.equal(isModerationPass(neverExpires, now), true);
});

// -- constraint-hash classification -----------------------------------------------------

test('constraint-hash helpers classify manual sentinel vs private vs zero', () => {
  assert.equal(isManualValidationConstraintHash(MANUAL_VALIDATION_SENTINEL), true);
  assert.equal(isManualValidationConstraintHash(new Uint8Array(32)), false);
  assert.equal(isManualValidationConstraintHash(new Uint8Array(5)), false);
  assert.equal(isManualValidationConstraintHash(null), false);

  assert.equal(isPrivateConstraintHash(HASH_BYTES), true);
  assert.equal(isPrivateConstraintHash(new Uint8Array(32)), false); // all-zero = none
  assert.equal(isPrivateConstraintHash(MANUAL_VALIDATION_SENTINEL), false); // sentinel != private
  assert.equal(isPrivateConstraintHash(null), false);
});

// -- PDA derivation (cross-checked against the SDK's Codama-generated finders) ----------

test('derive*Pda helpers agree with the SDK PDA finders', async () => {
  const task = new PublicKey(TASK);
  const claim = new PublicKey(CLAIM);
  const programAddress = PROGRAM_ID.toBase58() as never;

  const [jobSpec] = await findTaskJobSpecPda({ task: TASK as never }, { programAddress });
  assert.equal(deriveTaskJobSpecPda(task, PROGRAM_ID).toBase58(), jobSpec);

  const [validation] = await findTaskValidationConfigPda({ task: TASK as never }, { programAddress });
  assert.equal(deriveTaskValidationConfigPda(task, PROGRAM_ID).toBase58(), validation);

  const [submission] = await findTaskSubmissionPda({ claim: CLAIM as never }, { programAddress });
  assert.equal(deriveTaskSubmissionPda(claim, PROGRAM_ID).toBase58(), submission);
});

test('trustedModerationModerators honors TRUSTED_MODERATORS and dedupes', () => {
  const previous = process.env.TRUSTED_MODERATORS;
  try {
    delete process.env.TRUSTED_MODERATORS;
    const base = trustedModerationModerators();
    assert.deepEqual(base, [
      '9UEu2Gv9Q7DwBtumR2rUSq5g8v7b6mxn26ZNQCky82RJ',
      '13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v',
    ]);

    process.env.TRUSTED_MODERATORS = ` ${TASK} , ${base[0]} ,, `;
    const extended = trustedModerationModerators();
    assert.deepEqual(extended, [...base, TASK]);
  } finally {
    if (previous === undefined) {
      delete process.env.TRUSTED_MODERATORS;
    } else {
      process.env.TRUSTED_MODERATORS = previous;
    }
  }
});

test('deriveTaskModerationCandidatePdas lists v2 per-moderator PDAs then the legacy PDA', () => {
  const task = new PublicKey(TASK);
  const hash = Buffer.from(HASH_BYTES);
  const candidates = deriveTaskModerationCandidatePdas(task, hash, PROGRAM_ID);
  const moderators = trustedModerationModerators();
  assert.equal(candidates.length, moderators.length + 1);
  // Last entry is the frozen legacy PDA.
  assert.equal(
    candidates[candidates.length - 1].toBase58(),
    deriveTaskModerationPda(task, hash, PROGRAM_ID).toBase58(),
  );
  // v2 PDAs are moderator-keyed: all distinct, none equal to the legacy PDA.
  const unique = new Set(candidates.map((pda) => pda.toBase58()));
  assert.equal(unique.size, candidates.length);
});
