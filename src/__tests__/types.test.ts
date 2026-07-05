/**
 * Pure-function tests for the wire-contract mapping layer — pins the
 * full-surface (2026-06-11) status/type remapping so a refactor cannot
 * silently make RejectFrozen tasks look claimable or drop the new Task
 * fields from TaskView.
 *
 * Run: npm test -w @agenc/indexer
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapStatusFilter,
  mapTaskStatus,
  mapTaskType,
  taskRecordToView,
  type TaskRecordWithWorker,
} from '../types.js';

test('mapTaskStatus covers the full-surface status set', () => {
  assert.equal(mapTaskStatus('Open'), 'open');
  assert.equal(mapTaskStatus('In Progress'), 'claimed');
  assert.equal(mapTaskStatus('Pending Validation'), 'review');
  assert.equal(mapTaskStatus('Completed'), 'settled');
  assert.equal(mapTaskStatus('Cancelled'), 'cancelled');
  assert.equal(mapTaskStatus('Disputed'), 'disputed');
  // RejectFrozen (Batch 3, live since the full-surface upgrade) must land in
  // the needs-attention bucket — NEVER on the claimable board.
  assert.equal(mapTaskStatus('Reject Frozen'), 'disputed');
  // Unknown future variants fail closed the same way.
  assert.equal(mapTaskStatus('Some Future Status'), 'disputed');
});

test('mapStatusFilter: disputed includes Reject Frozen, others stay 1:1', () => {
  assert.deepEqual(mapStatusFilter('open'), ['Open']);
  assert.deepEqual(mapStatusFilter('claimed'), ['In Progress']);
  assert.deepEqual(mapStatusFilter('review'), ['Pending Validation']);
  assert.deepEqual(mapStatusFilter('settled'), ['Completed']);
  assert.deepEqual(mapStatusFilter('cancelled'), ['Cancelled']);
  // The filter must return exactly what mapTaskStatus shows as 'disputed'.
  assert.deepEqual(mapStatusFilter('disputed'), ['Disputed', 'Reject Frozen']);
  assert.equal(mapStatusFilter('bogus'), null);
});

test('mapTaskType covers all four on-chain types + unknown fallback', () => {
  assert.equal(mapTaskType('Exclusive'), 'exclusive');
  assert.equal(mapTaskType('Collaborative'), 'collaborative');
  assert.equal(mapTaskType('Competitive'), 'competitive');
  assert.equal(mapTaskType('Bid Exclusive'), 'bid_exclusive');
  assert.equal(mapTaskType('Type 9'), 'unknown');
});

function recordFixture(overrides: Partial<TaskRecordWithWorker> = {}): TaskRecordWithWorker {
  return {
    id: 'ab'.repeat(32),
    pda: 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2',
    status: 'Open',
    taskType: 'Exclusive',
    description: 'fixture task',
    rewardRaw: '10000000',
    rewardMint: null,
    creator: 'AtPmace7uiCiTGeVuiP2dRsmDRKv1rTLR6zUE5caErBE',
    currentWorkers: 0,
    maxWorkers: 1,
    createdAt: 1_780_601_856,
    deadline: 1_781_465_848,
    completedAt: 0,
    privateTask: false,
    verified: true,
    moderationStatus: 0,
    moderationRiskScore: 3,
    moderationRecordedAt: 1_780_601_900,
    requiredCapabilities: '1',
    minReputation: 0,
    jobSpecUri: 'https://example.com/spec.json',
    jobSpecHashHex: 'cd'.repeat(32),
    validationModeKey: 'creator_review',
    submissionStatusKey: null,
    submissionCount: 0,
    submissionProofHashHex: null,
    submittedAt: 0,
    acceptedAt: 0,
    rejectedAt: 0,
    protocolFeeBps: 100,
    operator: null,
    operatorFeeBps: 0,
    referrer: null,
    referrerFeeBps: 0,
    workerPda: null,
    ...overrides,
  };
}

test('taskRecordToView carries the full-surface fields onto the wire', () => {
  const view = taskRecordToView(
    recordFixture({
      taskType: 'Bid Exclusive',
      protocolFeeBps: 100,
      operator: 'GzdRn2tjuhDNLvg5U1gr1fyJDBVj9iAGJxM14qwkF6jD',
      operatorFeeBps: 250,
      referrer: '4VtVqaQRrvo5gMwzqvdNqhhB549CtGLcMKJQT1G68KTu',
      referrerFeeBps: 50,
      currentWorkers: 1,
      maxWorkers: 1,
    }),
  );
  assert.equal(view.taskType, 'bid_exclusive');
  assert.equal(view.protocolFeeBps, 100);
  assert.equal(view.operator, 'GzdRn2tjuhDNLvg5U1gr1fyJDBVj9iAGJxM14qwkF6jD');
  assert.equal(view.operatorFeeBps, 250);
  assert.equal(view.referrer, '4VtVqaQRrvo5gMwzqvdNqhhB549CtGLcMKJQT1G68KTu');
  assert.equal(view.referrerFeeBps, 50);
  assert.equal(view.maxWorkers, 1);
  assert.equal(view.currentWorkers, 1);
  // Pre-existing contract fields stay intact.
  assert.equal(view.rewardLamports, '10000000');
  assert.equal(view.verified, true);
  assert.equal(view.jobSpecHash, 'cd'.repeat(32));
});

test('taskRecordToView buckets a Reject Frozen record as disputed', () => {
  const view = taskRecordToView(recordFixture({ status: 'Reject Frozen' }));
  assert.equal(view.status, 'disputed');
});
