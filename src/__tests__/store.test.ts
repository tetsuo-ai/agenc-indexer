/**
 * IndexerStore tests: full-snapshot sync semantics (upsert + remove-missing,
 * i.e. torn-state recovery), the live-claim worker join, paging/clamping,
 * event dedupe/prune, and buildStats over the read model.
 *
 * All tests run against in-memory SQLite except the corruption-recovery test,
 * which needs a file so a second connection can tear a row.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { HireRecordRow, ListingRow } from '../explorer.js';
import { IndexerStore } from '../store.js';
import type { AgentRecord, ClaimRecord, StoredFeedEvent, TaskRecord } from '../types.js';

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'aa'.repeat(32),
    pda: 'TASK1',
    status: 'Open',
    taskType: 'Exclusive',
    description: 'Fixture task',
    rewardRaw: '1000000',
    rewardMint: null,
    creator: 'CREATOR1',
    currentWorkers: 0,
    maxWorkers: 1,
    createdAt: 1_780_000_000,
    deadline: 1_780_003_600,
    completedAt: 0,
    privateTask: false,
    verified: true,
    requiredCapabilities: '3',
    minReputation: 10,
    moderationStatus: 0,
    moderationRiskScore: 5,
    moderationRecordedAt: 1_780_000_100,
    jobSpecUri: 'https://example.com/spec.json',
    jobSpecHashHex: 'ab'.repeat(32),
    validationModeKey: 'creator_review',
    submissionStatusKey: 'idle',
    submissionCount: 0,
    submissionProofHashHex: null,
    submittedAt: 0,
    acceptedAt: 0,
    rejectedAt: 0,
    protocolFeeBps: 500,
    operator: null,
    operatorFeeBps: 0,
    referrer: null,
    referrerFeeBps: 0,
    ...overrides,
  };
}

function agentFixture(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    pda: 'AGENT1',
    authority: 'AtPmace7uiCiTGeVuiP2dRsmDRKv1rTLR6zUE5caErBE',
    status: 'Active',
    reputation: 100,
    tasksCompleted: 7,
    activeTasks: 1,
    registeredAt: 1_779_000_000,
    lastActive: 1_780_000_000,
    capabilities: '15',
    stake: '5000000',
    ...overrides,
  };
}

function claimFixture(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    claimPda: 'CLAIM1',
    taskPda: 'TASK1',
    workerPda: 'AGENT1',
    claimedAt: 1_780_000_500,
    completedAt: 0,
    ...overrides,
  };
}

function listingFixture(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    pda: 'LISTING1',
    accountDataB64: Buffer.from('listing-bytes').toString('base64'),
    metadataValid: true,
    metadataIssues: ['issue-a'],
    lastSlot: 42,
    ...overrides,
  };
}

function hireFixture(overrides: Partial<HireRecordRow> = {}): HireRecordRow {
  return {
    pda: 'HIRE1',
    accountDataB64: Buffer.from('hire-bytes').toString('base64'),
    listing: 'LISTING1',
    task: 'TASK1',
    ...overrides,
  };
}

function eventFixture(overrides: Partial<StoredFeedEvent> = {}): StoredFeedEvent {
  return {
    id: 'evt-1',
    kind: 'settle',
    taskPda: 'TASK1',
    agentPda: 'AGENT1',
    lamports: '1000000',
    riskScore: 3,
    artifactSha256: 'cd'.repeat(32),
    timestampUnix: 1_780_001_000,
    ...overrides,
  };
}

function withStore(run: (store: IndexerStore) => void): void {
  const store = new IndexerStore(':memory:');
  try {
    run(store);
  } finally {
    store.close();
  }
}

// -- tasks: sync + read ------------------------------------------------------

test('syncTasks round-trips a fully-populated record field by field', () => {
  withStore((store) => {
    const task = taskFixture({
      rewardMint: 'So11111111111111111111111111111111111111112',
      privateTask: true,
      submissionStatusKey: 'submitted',
      submissionCount: 2,
      submissionProofHashHex: 'ef'.repeat(32),
      submittedAt: 1_780_002_000,
      operator: 'OPERATOR1',
      operatorFeeBps: 150,
      referrer: 'REFERRER1',
      referrerFeeBps: 50,
    });
    store.syncTasks([task]);
    const got = store.getTask('TASK1');
    assert.ok(got);
    const { workerPda, ...record } = got;
    assert.equal(workerPda, null);
    assert.deepEqual(record, task);
  });
});

test('syncTasks round-trips null moderation columns as nulls', () => {
  withStore((store) => {
    store.syncTasks([
      taskFixture({
        moderationStatus: null,
        moderationRiskScore: null,
        moderationRecordedAt: null,
        jobSpecUri: null,
        jobSpecHashHex: null,
        validationModeKey: null,
        submissionStatusKey: null,
        verified: false,
      }),
    ]);
    const got = store.getTask('TASK1');
    assert.ok(got);
    assert.equal(got.moderationStatus, null);
    assert.equal(got.moderationRiskScore, null);
    assert.equal(got.moderationRecordedAt, null);
    assert.equal(got.jobSpecUri, null);
    assert.equal(got.jobSpecHashHex, null);
    assert.equal(got.validationModeKey, null);
    assert.equal(got.submissionStatusKey, null);
    assert.equal(got.verified, false);
  });
});

test('syncTasks upserts in place on re-observation (no duplicate rows)', () => {
  withStore((store) => {
    store.syncTasks([taskFixture()]);
    store.syncTasks([taskFixture({ status: 'In Progress', currentWorkers: 1, description: 'Updated' })]);
    const page = store.listTasks({});
    assert.equal(page.total, 1);
    assert.equal(page.items[0].status, 'In Progress');
    assert.equal(page.items[0].currentWorkers, 1);
    assert.equal(page.items[0].description, 'Updated');
  });
});

test('syncTasks removes rows absent from the snapshot (closed-account cleanup)', () => {
  withStore((store) => {
    store.syncTasks([taskFixture({ pda: 'TASK1' }), taskFixture({ pda: 'TASK2' })]);
    store.syncTasks([taskFixture({ pda: 'TASK2' })]);
    assert.equal(store.getTask('TASK1'), null);
    assert.ok(store.getTask('TASK2'));
    assert.equal(store.listTasks({}).total, 1);
  });
});

test('syncTasks with an empty snapshot wipes the table (torn-state recovery)', () => {
  withStore((store) => {
    store.syncTasks([taskFixture({ pda: 'TASK1' }), taskFixture({ pda: 'TASK2' })]);
    store.syncTasks([]);
    assert.equal(store.listTasks({}).total, 0);
    assert.deepEqual(store.listTasks({}).items, []);
  });
});

test('getTask trims lookup input and returns null for unknown PDAs', () => {
  withStore((store) => {
    store.syncTasks([taskFixture()]);
    assert.ok(store.getTask('  TASK1  '));
    assert.equal(store.getTask('NOPE'), null);
  });
});

test('getTaskByIdHex finds by on-chain task id', () => {
  withStore((store) => {
    store.syncTasks([taskFixture({ id: '11'.repeat(32) })]);
    assert.equal(store.getTaskByIdHex('11'.repeat(32))?.pda, 'TASK1');
    assert.equal(store.getTaskByIdHex('22'.repeat(32)), null);
  });
});

test('getTaskJoin serves the minimal hires projection and null when absent', () => {
  withStore((store) => {
    store.syncTasks([taskFixture({ creator: 'BUYER', rewardRaw: '777' })]);
    assert.deepEqual(store.getTaskJoin('TASK1'), { creator: 'BUYER', rewardRaw: '777' });
    assert.equal(store.getTaskJoin('MISSING'), null);
  });
});

// -- tasks: listing, ordering, paging, filters -------------------------------

test('listTasks orders by created_at DESC with pda DESC tiebreak and pages', () => {
  withStore((store) => {
    store.syncTasks([
      taskFixture({ pda: 'OLD', createdAt: 100 }),
      taskFixture({ pda: 'NEW', createdAt: 300 }),
      taskFixture({ pda: 'MID_A', createdAt: 200 }),
      taskFixture({ pda: 'MID_B', createdAt: 200 }),
    ]);
    const all = store.listTasks({});
    assert.deepEqual(all.items.map((t) => t.pda), ['NEW', 'MID_B', 'MID_A', 'OLD']);
    assert.equal(all.total, 4);

    const page2 = store.listTasks({ page: 2, pageSize: 2 });
    assert.deepEqual(page2.items.map((t) => t.pda), ['MID_A', 'OLD']);
    assert.equal(page2.total, 4);
  });
});

test('listTasks filters by explorer status array (disputed bucket)', () => {
  withStore((store) => {
    store.syncTasks([
      taskFixture({ pda: 'T_OPEN', status: 'Open' }),
      taskFixture({ pda: 'T_DISPUTED', status: 'Disputed' }),
      taskFixture({ pda: 'T_FROZEN', status: 'Reject Frozen' }),
    ]);
    const open = store.listTasks({ status: ['Open'] });
    assert.deepEqual(open.items.map((t) => t.pda), ['T_OPEN']);
    const disputed = store.listTasks({ status: ['Disputed', 'Reject Frozen'] });
    assert.equal(disputed.total, 2);
  });
});

test('listTasks clamps page and pageSize to sane bounds', () => {
  withStore((store) => {
    store.syncTasks([taskFixture()]);
    assert.equal(store.listTasks({ pageSize: 5000 }).pageSize, 100);
    assert.equal(store.listTasks({ pageSize: -3 }).pageSize, 1);
    assert.equal(store.listTasks({ page: 0 }).page, 1);
    assert.equal(store.listTasks({ page: Number.NaN, pageSize: Number.NaN }).page, 1);
    assert.equal(store.listTasks({ page: Number.NaN, pageSize: Number.NaN }).pageSize, 24);
  });
});

// -- worker join --------------------------------------------------------------

test('worker join: a live claim attaches its worker to the task', () => {
  withStore((store) => {
    store.syncTasks([taskFixture({ status: 'In Progress' })]);
    store.syncClaims([claimFixture({ workerPda: 'WORKER_A' })]);
    assert.equal(store.getTask('TASK1')?.workerPda, 'WORKER_A');
    assert.equal(store.listTasks({}).items[0].workerPda, 'WORKER_A');
  });
});

test('worker join: completed claims do not attach; newest live claim wins', () => {
  withStore((store) => {
    store.syncTasks([taskFixture()]);
    store.syncClaims([claimFixture({ claimPda: 'CLAIM_DONE', workerPda: 'DONE', completedAt: 999 })]);
    assert.equal(store.getTask('TASK1')?.workerPda, null);

    store.syncClaims([
      claimFixture({ claimPda: 'CLAIM_OLD', workerPda: 'OLD_WORKER', claimedAt: 100 }),
      claimFixture({ claimPda: 'CLAIM_NEW', workerPda: 'NEW_WORKER', claimedAt: 200 }),
    ]);
    assert.equal(store.getTask('TASK1')?.workerPda, 'NEW_WORKER');
  });
});

test('worker join: claims on other tasks never leak across', () => {
  withStore((store) => {
    store.syncTasks([taskFixture({ pda: 'TASK1' }), taskFixture({ pda: 'TASK2' })]);
    store.syncClaims([claimFixture({ taskPda: 'TASK2', workerPda: 'W2' })]);
    assert.equal(store.getTask('TASK1')?.workerPda, null);
    assert.equal(store.getTask('TASK2')?.workerPda, 'W2');
  });
});

// -- agents --------------------------------------------------------------------

test('syncAgents round-trips, upserts, and removes missing agents', () => {
  withStore((store) => {
    const agent = agentFixture();
    store.syncAgents([agent, agentFixture({ pda: 'AGENT2', authority: 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2' })]);
    assert.deepEqual(store.getAgent('AGENT1'), agent);

    store.syncAgents([agentFixture({ reputation: 250, tasksCompleted: 9 })]);
    assert.equal(store.getAgent('AGENT1')?.reputation, 250);
    assert.equal(store.getAgent('AGENT1')?.tasksCompleted, 9);
    assert.equal(store.getAgent('AGENT2'), null);
  });
});

test('getAgent trims lookup input', () => {
  withStore((store) => {
    store.syncAgents([agentFixture()]);
    assert.ok(store.getAgent(' AGENT1 '));
  });
});

test('listAgents orders by reputation, filters by authority, and pages', () => {
  withStore((store) => {
    store.syncAgents([
      agentFixture({ pda: 'LOW', reputation: 10 }),
      agentFixture({ pda: 'HIGH', reputation: 90 }),
      agentFixture({ pda: 'TIE_MORE_TASKS', reputation: 50, tasksCompleted: 20 }),
      agentFixture({ pda: 'TIE_FEWER_TASKS', reputation: 50, tasksCompleted: 2 }),
      agentFixture({ pda: 'OTHER_AUTH', reputation: 99, authority: 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2' }),
    ]);
    const all = store.listAgents({});
    assert.deepEqual(
      all.items.map((a) => a.pda),
      ['OTHER_AUTH', 'HIGH', 'TIE_MORE_TASKS', 'TIE_FEWER_TASKS', 'LOW'],
    );
    assert.equal(all.total, 5);

    const filtered = store.listAgents({ authority: 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2' });
    assert.deepEqual(filtered.items.map((a) => a.pda), ['OTHER_AUTH']);
    assert.equal(filtered.total, 1);

    const paged = store.listAgents({ page: 2, pageSize: 2 });
    assert.deepEqual(paged.items.map((a) => a.pda), ['TIE_MORE_TASKS', 'TIE_FEWER_TASKS']);
    assert.equal(store.listAgents({ pageSize: 5000 }).pageSize, 100);
  });
});

// -- listings + hire records ----------------------------------------------------

test('syncListings round-trips rows and removes missing listings', () => {
  withStore((store) => {
    const listing = listingFixture();
    store.syncListings([listing, listingFixture({ pda: 'LISTING2', metadataValid: false, metadataIssues: [] })]);
    const rows = store.listListingRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], listing); // ordered by pda ASC
    assert.equal(rows[1].metadataValid, false);
    assert.deepEqual(rows[1].metadataIssues, []);

    store.syncListings([listingFixture({ pda: 'LISTING2' })]);
    assert.deepEqual(store.listListingRows().map((row) => row.pda), ['LISTING2']);
  });
});

test('listListingRows recovers from a torn metadata_issues row (bad JSON -> [])', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenc-indexer-store-'));
  const dbPath = join(dir, 'explorer.sqlite');
  const store = new IndexerStore(dbPath);
  try {
    store.syncListings([listingFixture()]);
    // Tear the row through a second connection, as a crashed writer would.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE listings SET metadata_issues = '{not json' WHERE pda = ?").run('LISTING1');
    raw.close();
    const rows = store.listListingRows();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].metadataIssues, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncHireRecords round-trips, filters by listing, and removes missing', () => {
  withStore((store) => {
    store.syncHireRecords([
      hireFixture({ pda: 'HIRE1', listing: 'LISTING1' }),
      hireFixture({ pda: 'HIRE2', listing: 'LISTING2' }),
    ]);
    assert.equal(store.listHireRecordRows().length, 2);
    assert.deepEqual(store.listHireRecordRows('LISTING1').map((row) => row.pda), ['HIRE1']);
    assert.deepEqual(store.listHireRecordRows('NOPE'), []);

    store.syncHireRecords([hireFixture({ pda: 'HIRE2', listing: 'LISTING2' })]);
    assert.deepEqual(store.listHireRecordRows().map((row) => row.pda), ['HIRE2']);
  });
});

// -- events ----------------------------------------------------------------------

test('insertEvent is idempotent by deterministic id (SSE re-broadcast dedupe)', () => {
  withStore((store) => {
    assert.equal(store.insertEvent(eventFixture()), true);
    // Same id re-observed by a later poll: not new, caller must not re-broadcast.
    assert.equal(store.insertEvent(eventFixture({ kind: 'claim' })), false);
    assert.equal(store.listEvents(10).length, 1);
    assert.equal(store.listEvents(10)[0].kind, 'settle');
  });
});

test('listEvents returns newest-first with optional fields preserved or omitted', () => {
  withStore((store) => {
    store.insertEvent(eventFixture({ id: 'evt-old', timestampUnix: 100 }));
    store.insertEvent({ id: 'evt-new', kind: 'agent_registered', timestampUnix: 200 });
    const events = store.listEvents(10);
    assert.deepEqual(events.map((event) => event.id), ['evt-new', 'evt-old']);
    // Sparse event: optional keys absent, not null.
    assert.deepEqual(events[0], { id: 'evt-new', kind: 'agent_registered', timestampUnix: 200 });
    // Dense event: every optional field round-trips.
    assert.deepEqual(events[1], eventFixture({ id: 'evt-old', timestampUnix: 100 }));
  });
});

test('listEvents clamps the limit (0 -> 1, NaN -> 40, cap 500)', () => {
  withStore((store) => {
    for (let index = 0; index < 45; index++) {
      store.insertEvent(eventFixture({ id: `evt-${index}`, timestampUnix: index }));
    }
    assert.equal(store.listEvents(0).length, 1);
    assert.equal(store.listEvents(Number.NaN).length, 40);
    assert.equal(store.listEvents(10_000).length, 45);
  });
});

test('pruneEvents keeps only the newest N events', () => {
  withStore((store) => {
    for (let index = 0; index < 10; index++) {
      store.insertEvent(eventFixture({ id: `evt-${index}`, timestampUnix: 1000 + index }));
    }
    store.pruneEvents(3);
    const kept = store.listEvents(100);
    assert.deepEqual(kept.map((event) => event.id), ['evt-9', 'evt-8', 'evt-7']);
  });
});

// -- stats -------------------------------------------------------------------------

test('buildStats over an empty store returns zeros and a null last settlement', () => {
  withStore((store) => {
    const stats = store.buildStats(1_780_000_000);
    assert.deepEqual(stats, {
      tasksSettled: 0,
      lamportsPaidOut: 0n,
      registeredAgents: 0,
      escrowLockedLamports: 0n,
      activeClaims: 0,
      avgSettleSeconds: 0,
      lastSettlementSecondsAgo: null,
    });
  });
});

test('buildStats aggregates settled payouts, escrow, claims, and settle times', () => {
  withStore((store) => {
    store.syncTasks([
      // Settled SOL tasks: counted in payouts + settle-time medians.
      taskFixture({ pda: 'S1', status: 'Completed', rewardRaw: '100', createdAt: 1000, completedAt: 1100 }),
      taskFixture({ pda: 'S2', status: 'Completed', rewardRaw: '200', createdAt: 1000, completedAt: 1300 }),
      taskFixture({ pda: 'S3', status: 'Completed', rewardRaw: '400', createdAt: 1000, completedAt: 2000 }),
      // Settled SPL task: counted in tasksSettled, EXCLUDED from lamport sums.
      taskFixture({
        pda: 'S_MINT',
        status: 'Completed',
        rewardRaw: '999999',
        rewardMint: 'So11111111111111111111111111111111111111112',
        createdAt: 1000,
        completedAt: 1400,
      }),
      // Escrow-locked statuses.
      taskFixture({ pda: 'E_OPEN', status: 'Open', rewardRaw: '10' }),
      taskFixture({ pda: 'E_PROG', status: 'In Progress', rewardRaw: '20' }),
      taskFixture({ pda: 'E_REVIEW', status: 'Pending Validation', rewardRaw: '40' }),
      taskFixture({ pda: 'E_DISPUTED', status: 'Disputed', rewardRaw: '80' }),
      taskFixture({ pda: 'E_FROZEN', status: 'Reject Frozen', rewardRaw: '160' }),
      // SPL escrow excluded; cancelled tasks hold nothing.
      taskFixture({
        pda: 'E_MINT',
        status: 'Open',
        rewardRaw: '5000',
        rewardMint: 'So11111111111111111111111111111111111111112',
      }),
      taskFixture({ pda: 'E_CANCELLED', status: 'Cancelled', rewardRaw: '5000' }),
    ]);
    store.syncAgents([agentFixture({ pda: 'A1' }), agentFixture({ pda: 'A2' })]);
    store.syncClaims([
      // Live claim on a live-status task: active.
      claimFixture({ claimPda: 'C1', taskPda: 'E_PROG' }),
      // Live claim on an Open task: not active (not in the live-status set).
      claimFixture({ claimPda: 'C2', taskPda: 'E_OPEN' }),
      // Completed claim: not active.
      claimFixture({ claimPda: 'C3', taskPda: 'E_REVIEW', completedAt: 5 }),
    ]);

    const nowUnix = 2_500;
    const stats = store.buildStats(nowUnix);
    assert.equal(stats.tasksSettled, 4);
    assert.equal(stats.lamportsPaidOut, 700n);
    assert.equal(stats.registeredAgents, 2);
    assert.equal(stats.escrowLockedLamports, 310n);
    assert.equal(stats.activeClaims, 1);
    // Deltas sorted: [100, 300, 400, 1000] -> median picks index 2.
    assert.equal(stats.avgSettleSeconds, 400);
    assert.equal(stats.lastSettlementSecondsAgo, nowUnix - 2000);
  });
});

test('buildStats ignores bogus settle deltas (created_at 0 or completed <= created)', () => {
  withStore((store) => {
    store.syncTasks([
      taskFixture({ pda: 'S1', status: 'Completed', rewardRaw: '1', createdAt: 0, completedAt: 900 }),
      taskFixture({ pda: 'S2', status: 'Completed', rewardRaw: '1', createdAt: 800, completedAt: 700 }),
    ]);
    const stats = store.buildStats(1_000);
    assert.equal(stats.tasksSettled, 2);
    assert.equal(stats.avgSettleSeconds, 0);
    assert.equal(stats.lastSettlementSecondsAgo, 100);
  });
});
