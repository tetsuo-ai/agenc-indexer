/**
 * T7 of the WP-C3 scale-target contract (agenc-protocol
 * docs/SCALE_COST_MODEL.md §7): the §1 account-size manifest is pinned in a
 * unit test so the cost model's numbers fail loudly on layout drift.
 *
 * Sizes come from the published `@tetsuo-ai/marketplace-sdk` generated
 * `get*Size()` helpers (bytes INCLUDING the 8-byte discriminator), asserted
 * against the manifest below, which is copied verbatim from
 * SCALE_COST_MODEL.md §1. Accounts without a generated size helper
 * (variable-length or not exported) are pinned where this indexer holds its
 * own constant (TaskSubmission) and listed as doc-pinned otherwise — the
 * program repo compile-pins those (`Task = 466` at state.rs:1087).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getAuthorityRateLimitSize,
  getHireRecordSize,
  getListingModerationSize,
  getModerationAttestorSize,
  getTaskAttestorConfigSize,
  getTaskClaimSize,
  getTaskEscrowSize,
  getTaskModerationSize,
  getTaskSubmissionSize,
  getTaskValidationConfigSize,
} from '@tetsuo-ai/marketplace-sdk';
import { TASK_SUBMISSION_ACCOUNT_SIZE } from '../decoders.js';

/** SCALE_COST_MODEL.md §1 — bytes incl. the 8-byte discriminator. */
const SIZE_MANIFEST = {
  Task: 466, // doc/compile-pinned in agenc-protocol (no SDK size helper)
  TaskEscrow: 58,
  TaskClaim: 203,
  TaskJobSpec: 388, // variable specUri; §1 value is the InitSpace allocation
  TaskValidationConfig: 105,
  TaskAttestorConfig: 128,
  TaskSubmission: 273,
  TaskModeration: 234,
  HireRecord: 173,
  HireRating: 439, // no SDK size helper
  ListingModeration: 234,
  ServiceListing: 697, // variable specUri; §1 value is the InitSpace allocation
  AgentRegistration: 566, // no SDK size helper
  AuthorityRateLimit: 67,
  ModerationAttestor: 113,
} as const;

test('SDK account sizes match the SCALE_COST_MODEL §1 manifest', () => {
  const sdkSizes: Partial<Record<keyof typeof SIZE_MANIFEST, number>> = {
    TaskEscrow: getTaskEscrowSize(),
    TaskClaim: getTaskClaimSize(),
    TaskValidationConfig: getTaskValidationConfigSize(),
    TaskAttestorConfig: getTaskAttestorConfigSize(),
    TaskSubmission: getTaskSubmissionSize(),
    TaskModeration: getTaskModerationSize(),
    HireRecord: getHireRecordSize(),
    ListingModeration: getListingModerationSize(),
    AuthorityRateLimit: getAuthorityRateLimitSize(),
    ModerationAttestor: getModerationAttestorSize(),
  };
  for (const [account, size] of Object.entries(sdkSizes)) {
    assert.equal(
      size,
      SIZE_MANIFEST[account as keyof typeof SIZE_MANIFEST],
      `${account} size drifted from the SCALE_COST_MODEL §1 manifest`,
    );
  }
  // Printed manifest per T7 ("extend the size suite with a printed manifest").
  console.log('size manifest (bytes incl. discriminator):', SIZE_MANIFEST);
});

test('the indexer TaskSubmission dataSize-scan constant matches the manifest', () => {
  assert.equal(TASK_SUBMISSION_ACCOUNT_SIZE, SIZE_MANIFEST.TaskSubmission);
});
