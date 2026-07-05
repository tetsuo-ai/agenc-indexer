/**
 * IndexerServer HTTP + SSE tests against a real listening server backed by a
 * seeded in-memory store: per-route happy path / empty state / bad input,
 * the contract envelope conventions (CORS + X-Agenc-Contract-Version), and
 * the SSE framing + client eviction behavior.
 *
 * No network beyond 127.0.0.1: the jobspec-check cases exercise only the
 * SSRF guard rejections, which fail before any outbound connection.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { getServiceListingEncoder, ListingState } from '@tetsuo-ai/marketplace-sdk';
import { IndexerServer, type HealthState } from '../server.js';
import { IndexerStore } from '../store.js';
import type { AgentRecord, ClaimRecord, TaskRecord } from '../types.js';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from '../version.js';

const PROGRAM_ID = 'HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK';
const PROVIDER = 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2';
const AUTHORITY = 'AtPmace7uiCiTGeVuiP2dRsmDRKv1rTLR6zUE5caErBE';

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
    authority: AUTHORITY,
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

/** SDK-encoded ServiceListing bytes (never hand-crafted). */
function encodedListingB64(overrides: { category?: string } = {}): string {
  const fixedBytes = (text: string, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    out.set(new TextEncoder().encode(text).slice(0, size));
    return out;
  };
  const bytes = getServiceListingEncoder().encode({
    providerAgent: PROVIDER as never,
    authority: AUTHORITY as never,
    listingId: new Uint8Array(32),
    name: fixedBytes('Fixture research agent', 32),
    category: fixedBytes(overrides.category ?? 'research', 32),
    tags: fixedBytes('research,summaries', 64),
    specHash: Uint8Array.from({ length: 32 }, (_, index) => index),
    specUri: 'https://example.com/spec.json',
    price: 10_000_000n,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3_600n,
    operator: '11111111111111111111111111111111' as never,
    operatorFeeBps: 0,
    state: ListingState.Active,
    maxOpenJobs: 3,
    openJobs: 1,
    totalHires: 7n,
    totalRating: 0n,
    ratingCount: 0,
    version: 2n,
    createdAt: 1_780_601_856n,
    updatedAt: 1_780_601_900n,
    bump: 255,
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

type TestContext = {
  server: IndexerServer;
  store: IndexerStore;
  base: string;
  errors: string[];
};

async function startServer(
  options: { lastError?: string | null; lastSlot?: number } = {},
): Promise<TestContext> {
  const store = new IndexerStore(':memory:');
  const errors: string[] = [];
  const health: HealthState = {
    rpcUrl: 'https://rpc.example.invalid',
    programId: PROGRAM_ID,
    programIdSource: 'default',
    dbPath: ':memory:',
    lastError: () => options.lastError ?? null,
    lastSlot: () => options.lastSlot ?? 0,
  };
  const server = new IndexerServer({
    store,
    health,
    logger: { info: () => {}, error: (message) => errors.push(message) },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = (server as unknown as { server: Server }).server.address() as AddressInfo;
  return { server, store, base: `http://127.0.0.1:${address.port}`, errors };
}

function stopServer(context: TestContext): void {
  context.server.close();
  context.store.close();
}

async function withServer(
  run: (context: TestContext) => Promise<void>,
  options: { lastError?: string | null; lastSlot?: number } = {},
): Promise<void> {
  const context = await startServer(options);
  try {
    await run(context);
  } finally {
    stopServer(context);
  }
}

async function getJson(
  base: string,
  path: string,
): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

type SseClient = {
  request: http.ClientRequest;
  response: http.IncomingMessage;
  waitFor: (predicate: (buffer: string) => boolean) => Promise<string>;
};

function openSse(base: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/events`, (response) => {
      let buffer = '';
      const waiters: Array<{ predicate: (buffer: string) => boolean; resolve: (buffer: string) => void }> = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        for (let index = waiters.length - 1; index >= 0; index--) {
          if (waiters[index].predicate(buffer)) {
            waiters[index].resolve(buffer);
            waiters.splice(index, 1);
          }
        }
      });
      resolve({
        request,
        response,
        waitFor: (predicate) =>
          new Promise<string>((resolveWait, rejectWait) => {
            if (predicate(buffer)) {
              resolveWait(buffer);
              return;
            }
            const timer = setTimeout(() => rejectWait(new Error('SSE wait timed out')), 3_000);
            waiters.push({
              predicate,
              resolve: (value) => {
                clearTimeout(timer);
                resolveWait(value);
              },
            });
          }),
      });
    });
    request.on('error', reject);
  });
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// -- envelope conventions ------------------------------------------------------

test('every response carries CORS + contract-version headers; OPTIONS is 204', async () => {
  await withServer(async ({ base }) => {
    const get = await getJson(base, '/api/stats');
    assert.equal(get.headers.get('access-control-allow-origin'), '*');
    assert.equal(get.headers.get(CONTRACT_VERSION_HEADER.toLowerCase()), CONTRACT_VERSION);

    const options = await fetch(`${base}/api/tasks`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(options.headers.get(CONTRACT_VERSION_HEADER.toLowerCase()), CONTRACT_VERSION);
  });
});

test('non-GET methods are 405 and unknown paths are 404', async () => {
  await withServer(async ({ base }) => {
    const post = await fetch(`${base}/api/tasks`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.deepEqual(await post.json(), { error: 'Method not allowed' });

    const missing = await getJson(base, '/api/nope');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Not found' });
  });
});

// -- /healthz -------------------------------------------------------------------

test('GET /healthz reports ok=true with the health snapshot', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await getJson(base, '/healthz');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      ok: true,
      rpcUrl: 'https://rpc.example.invalid',
      programId: PROGRAM_ID,
      programIdSource: 'default',
      clients: 0,
      lastError: null,
      dbPath: ':memory:',
    });
  });
});

test('GET /healthz flips ok=false when the last RPC refresh failed', async () => {
  await withServer(
    async ({ base }) => {
      const { body } = await getJson(base, '/healthz');
      assert.equal(body.ok, false);
      assert.equal(body.lastError, 'rpc exploded');
    },
    { lastError: 'rpc exploded' },
  );
});

// -- /api/stats -------------------------------------------------------------------

test('GET /api/stats serializes lamports as decimal strings (empty store)', async () => {
  await withServer(
    async ({ base }) => {
      const { status, body } = await getJson(base, '/api/stats');
      assert.equal(status, 200);
      assert.deepEqual(body, {
        slot: 123_456,
        tasksSettled: 0,
        lamportsPaidOut: '0',
        registeredAgents: 0,
        escrowLockedLamports: '0',
        activeClaims: 0,
        avgSettleSeconds: 0,
        lastSettlementSecondsAgo: null,
        programId: PROGRAM_ID,
      });
    },
    { lastSlot: 123_456 },
  );
});

test('GET /api/stats aggregates the seeded read model', async () => {
  await withServer(async ({ base, store }) => {
    store.syncTasks([
      taskFixture({ pda: 'DONE', status: 'Completed', rewardRaw: '300', createdAt: 100, completedAt: 400 }),
      taskFixture({ pda: 'LOCKED', status: 'Open', rewardRaw: '50' }),
    ]);
    store.syncAgents([agentFixture()]);
    const { body } = await getJson(base, '/api/stats');
    assert.equal(body.tasksSettled, 1);
    assert.equal(body.lamportsPaidOut, '300');
    assert.equal(body.escrowLockedLamports, '50');
    assert.equal(body.registeredAgents, 1);
    assert.equal(body.avgSettleSeconds, 300);
  });
});

// -- /api/tasks --------------------------------------------------------------------

test('GET /api/tasks maps seeded records to the wire view', async () => {
  await withServer(async ({ base, store }) => {
    store.syncTasks([taskFixture({ status: 'In Progress' })]);
    store.syncClaims([claimFixture()]);
    const { status, body } = await getJson(base, '/api/tasks');
    assert.equal(status, 200);
    assert.equal(body.total, 1);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 24);
    assert.deepEqual(body.items[0], {
      pda: 'TASK1',
      title: 'Fixture task',
      status: 'claimed',
      verified: true,
      rewardLamports: '1000000',
      deadlineUnix: 1_780_003_600,
      creatorPda: 'CREATOR1',
      createdAtUnix: 1_780_000_000,
      workerPda: 'AGENT1',
      requiredCapabilities: '3',
      minReputation: 10,
      jobSpecUri: 'https://example.com/spec.json',
      jobSpecHash: 'ab'.repeat(32),
      taskType: 'exclusive',
      maxWorkers: 1,
      currentWorkers: 0,
      protocolFeeBps: 500,
      operator: null,
      operatorFeeBps: 0,
      referrer: null,
      referrerFeeBps: 0,
    });
  });
});

test('GET /api/tasks on an empty store returns an empty page', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await getJson(base, '/api/tasks');
    assert.equal(status, 200);
    assert.deepEqual(body, { items: [], page: 1, pageSize: 24, total: 0 });
  });
});

test('GET /api/tasks honors status filter, paging, and ignores junk paging', async () => {
  await withServer(async ({ base, store }) => {
    store.syncTasks([
      taskFixture({ pda: 'T_OPEN', status: 'Open', createdAt: 300 }),
      taskFixture({ pda: 'T_FROZEN', status: 'Reject Frozen', createdAt: 200 }),
      taskFixture({ pda: 'T_DISPUTED', status: 'Disputed', createdAt: 100 }),
    ]);
    const open = await getJson(base, '/api/tasks?status=open');
    assert.deepEqual(open.body.items.map((task: { pda: string }) => task.pda), ['T_OPEN']);

    // 'disputed' covers both Disputed and Reject Frozen.
    const disputed = await getJson(base, '/api/tasks?status=disputed');
    assert.deepEqual(
      disputed.body.items.map((task: { pda: string }) => task.pda),
      ['T_FROZEN', 'T_DISPUTED'],
    );

    const paged = await getJson(base, '/api/tasks?page=2&pageSize=1');
    assert.equal(paged.body.total, 3);
    assert.deepEqual(paged.body.items.map((task: { pda: string }) => task.pda), ['T_FROZEN']);

    // Non-numeric paging params fall back to defaults instead of erroring.
    const junk = await getJson(base, '/api/tasks?page=banana&pageSize=banana');
    assert.equal(junk.status, 200);
    assert.equal(junk.body.page, 1);
    assert.equal(junk.body.pageSize, 24);
  });
});

test('GET /api/tasks rejects an unknown status filter with 400', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await getJson(base, '/api/tasks?status=bogus');
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'Unknown status filter: bogus' });
  });
});

// -- /api/tasks/:pda -----------------------------------------------------------------

test('GET /api/tasks/:pda returns the task view, 404s unknown, 400s blank', async () => {
  await withServer(async ({ base, store }) => {
    store.syncTasks([taskFixture()]);

    const found = await getJson(base, '/api/tasks/TASK1');
    assert.equal(found.status, 200);
    assert.equal(found.body.task.pda, 'TASK1');
    assert.equal(found.body.task.title, 'Fixture task');

    const missing = await getJson(base, '/api/tasks/UNKNOWN');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Task not found' });

    // URL-encoded whitespace decodes+trims to an empty PDA.
    const blank = await getJson(base, '/api/tasks/%20%20');
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.body, { error: 'Task PDA is required' });
  });
});

// -- /api/agents -----------------------------------------------------------------------

test('GET /api/agents lists agent views and filters by authority', async () => {
  await withServer(async ({ base, store }) => {
    store.syncAgents([
      agentFixture(),
      agentFixture({ pda: 'AGENT2', authority: PROVIDER, reputation: 5 }),
    ]);

    const all = await getJson(base, '/api/agents');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 2);
    assert.deepEqual(all.body.items[0], {
      pda: 'AGENT1',
      authority: AUTHORITY,
      status: 'Active',
      reputation: 100,
      tasksCompleted: 7,
      registeredAtUnix: 1_779_000_000,
      capabilities: '15',
      stake: '5000000',
    });

    const filtered = await getJson(base, `/api/agents?authority=${PROVIDER}`);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.items[0].pda, 'AGENT2');

    const empty = await getJson(base, '/api/agents?authority=13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v');
    assert.deepEqual(empty.body, { items: [], total: 0 });
  });
});

test('GET /api/agents rejects a non-base58 authority with 400', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await getJson(base, '/api/agents?authority=not-base58!');
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'authority must be a base58 public key' });
  });
});

// -- explorer endpoints -------------------------------------------------------------------

test('GET /api/explorer/listings serves decoded listings (conforming-only default)', async () => {
  await withServer(async ({ base, store }) => {
    store.syncListings([
      { pda: 'LST_VALID', accountDataB64: encodedListingB64(), metadataValid: true, metadataIssues: [], lastSlot: 9 },
      {
        pda: 'LST_INVALID',
        accountDataB64: encodedListingB64({ category: 'coding' }),
        metadataValid: false,
        metadataIssues: ['missing description'],
        lastSlot: 9,
      },
      // Undecodable rows fail soft and never kill the page.
      { pda: 'LST_GARBAGE', accountDataB64: Buffer.from([1, 2, 3]).toString('base64'), metadataValid: true, metadataIssues: [], lastSlot: 9 },
    ]);

    const page = await getJson(base, '/api/explorer/listings');
    assert.equal(page.status, 200);
    assert.equal(page.body.success, true);
    assert.equal(page.body.total, 1);
    assert.equal(page.body.items[0].pda, 'LST_VALID');
    assert.equal(page.body.items[0].decoded.provider, PROVIDER);
    assert.equal(page.body.items[0].decoded.price, '10000000');
    // Byte-true contract: accountData is the stored base64 unmodified.
    assert.equal(page.body.items[0].accountData, encodedListingB64());

    const invalidOnly = await getJson(base, '/api/explorer/listings?metadataValid=false');
    assert.deepEqual(invalidOnly.body.items.map((listing: { pda: string }) => listing.pda), ['LST_INVALID']);

    const filtered = await getJson(base, '/api/explorer/listings?category=coding&metadataValid=false');
    assert.equal(filtered.body.total, 1);

    const noMatch = await getJson(base, '/api/explorer/listings?category=cooking');
    assert.deepEqual(noMatch.body.items, []);
    assert.equal(noMatch.body.total, 0);
  });
});

test('GET /api/explorer/listings/:pda serves direct lookups regardless of conformance', async () => {
  await withServer(async ({ base, store }) => {
    store.syncListings([
      {
        pda: 'LST_INVALID',
        accountDataB64: encodedListingB64(),
        metadataValid: false,
        metadataIssues: ['missing description'],
        lastSlot: 3,
      },
    ]);

    const found = await getJson(base, '/api/explorer/listings/LST_INVALID');
    assert.equal(found.status, 200);
    assert.equal(found.body.success, true);
    assert.equal(found.body.listing.pda, 'LST_INVALID');
    assert.deepEqual(found.body.listing.metadataIssues, ['missing description']);

    const missing = await getJson(base, '/api/explorer/listings/UNKNOWN');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { success: false, error: { code: 'NOT_FOUND', message: 'listing not found' } });

    const blank = await getJson(base, '/api/explorer/listings/%20');
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error.code, 'BAD_REQUEST');

    const unknownTail = await getJson(base, '/api/explorer/listings/LST_INVALID/bogus');
    assert.equal(unknownTail.status, 404);
    assert.deepEqual(unknownTail.body, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
});

test('GET /api/explorer/listings/:pda/hires joins hire records to minted tasks', async () => {
  await withServer(async ({ base, store }) => {
    store.syncTasks([taskFixture({ pda: 'TASK1', creator: 'BUYER1', rewardRaw: '5000000' })]);
    store.syncHireRecords([
      { pda: 'HIRE1', accountDataB64: 'aGlyZTE=', listing: 'LST', task: 'TASK1' },
      { pda: 'HIRE2', accountDataB64: 'aGlyZTI=', listing: 'OTHER', task: 'TASK2' },
    ]);

    const { status, body } = await getJson(base, '/api/explorer/listings/LST/hires');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.items, [
      {
        taskPda: 'TASK1',
        hireRecordPda: 'HIRE1',
        accountData: 'aGlyZTE=',
        buyer: 'BUYER1',
        listing: 'LST',
        price: '5000000',
        slot: 0,
        signature: '',
      },
    ]);

    const empty = await getJson(base, '/api/explorer/listings/NO_SUCH/hires');
    assert.deepEqual(empty.body, { success: true, items: [] });
  });
});

test('GET /api/explorer/agents/:pda/track-record serves counters and 404s unknown', async () => {
  await withServer(async ({ base, store }) => {
    store.syncAgents([agentFixture({ tasksCompleted: 12 })]);

    const found = await getJson(base, '/api/explorer/agents/AGENT1/track-record');
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, {
      success: true,
      agent: 'AGENT1',
      completions: 12,
      disputesInitiated: 0,
      disputesLost: 0,
      slashHistory: [],
      source: 'events',
    });

    const missing = await getJson(base, '/api/explorer/agents/UNKNOWN/track-record');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { success: false, error: { code: 'NOT_FOUND', message: 'agent not found' } });

    const blank = await getJson(base, '/api/explorer/agents//track-record');
    assert.equal(blank.status, 404);
  });
});

// -- /api/jobspec-check (guard rejections only; no outbound connection) ---------------

test('GET /api/jobspec-check rejects missing, non-https, and non-public URIs', async () => {
  await withServer(async ({ base }) => {
    const missing = await getJson(base, '/api/jobspec-check');
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: 'uri is required and must be at most 2048 characters' });

    const insecure = await getJson(base, `/api/jobspec-check?uri=${encodeURIComponent('http://example.com/spec.json')}`);
    assert.equal(insecure.status, 400);
    assert.deepEqual(insecure.body, { error: 'Only https:// job-spec URIs are allowed' });

    const loopback = await getJson(base, `/api/jobspec-check?uri=${encodeURIComponent('https://127.0.0.1/spec.json')}`);
    assert.equal(loopback.status, 400);
    assert.deepEqual(loopback.body, { error: 'Job-spec host resolves to a non-public address' });

    const oddPort = await getJson(base, `/api/jobspec-check?uri=${encodeURIComponent('https://example.com:8443/spec.json')}`);
    assert.equal(oddPort.status, 400);
    assert.deepEqual(oddPort.body, { error: 'Only the default https port (443) is allowed' });

    const notAUrl = await getJson(base, `/api/jobspec-check?uri=${encodeURIComponent('not a url')}`);
    assert.equal(notAUrl.status, 400);
    assert.deepEqual(notAUrl.body, { error: 'uri is not a valid URL' });
  });
});

// -- /api/activity ---------------------------------------------------------------------

test('GET /api/activity lists newest-first views with the internal id stripped', async () => {
  await withServer(async ({ base, store }) => {
    store.insertEvent({ id: 'evt-1', kind: 'task_posted', taskPda: 'TASK1', timestampUnix: 100 });
    store.insertEvent({ id: 'evt-2', kind: 'settle', taskPda: 'TASK1', lamports: '5', timestampUnix: 200 });

    const { status, body } = await getJson(base, '/api/activity');
    assert.equal(status, 200);
    assert.deepEqual(body.items, [
      { kind: 'settle', taskPda: 'TASK1', lamports: '5', timestampUnix: 200 },
      { kind: 'task_posted', taskPda: 'TASK1', timestampUnix: 100 },
    ]);

    const limited = await getJson(base, '/api/activity?limit=1');
    assert.equal(limited.body.items.length, 1);
    assert.equal(limited.body.items[0].kind, 'settle');

    const empty = await startServer();
    try {
      const none = await getJson(empty.base, '/api/activity');
      assert.deepEqual(none.body, { items: [] });
    } finally {
      stopServer(empty);
    }
  });
});

// -- SSE (/api/events + broadcast) --------------------------------------------------------

test('SSE: /api/events sets stream headers, sends the connected comment, and frames broadcasts', async () => {
  await withServer(async ({ base, server }) => {
    const client = await openSse(base);
    try {
      assert.equal(client.response.statusCode, 200);
      assert.equal(client.response.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(client.response.headers['cache-control'], 'no-cache, no-transform');
      assert.equal(client.response.headers[CONTRACT_VERSION_HEADER.toLowerCase()], CONTRACT_VERSION);

      await client.waitFor((buffer) => buffer.includes(': connected\n\n'));
      assert.equal(server.clientCount(), 1);

      const event = { kind: 'settle' as const, taskPda: 'TASK1', lamports: '42', timestampUnix: 1_780_000_000 };
      server.broadcast(event);
      const buffer = await client.waitFor((value) => value.includes('\n\ndata: ') || /data: .*\n\n/.test(value));
      const frames = buffer.split('\n\n').filter((frame) => frame.startsWith('data: '));
      assert.equal(frames.length, 1);
      assert.deepEqual(JSON.parse(frames[0].slice('data: '.length)), event);
    } finally {
      client.request.destroy();
    }
  });
});

test('SSE: every connected client receives each broadcast', async () => {
  await withServer(async ({ base, server }) => {
    const first = await openSse(base);
    const second = await openSse(base);
    try {
      await first.waitFor((buffer) => buffer.includes(': connected\n\n'));
      await second.waitFor((buffer) => buffer.includes(': connected\n\n'));
      assert.equal(server.clientCount(), 2);

      server.broadcast({ kind: 'claim', taskPda: 'TASK1', timestampUnix: 1 });
      await first.waitFor((buffer) => buffer.includes('"kind":"claim"'));
      await second.waitFor((buffer) => buffer.includes('"kind":"claim"'));
    } finally {
      first.request.destroy();
      second.request.destroy();
    }
  });
});

test('SSE: a disconnected client is removed and later broadcasts still deliver', async () => {
  await withServer(async ({ base, server }) => {
    const staying = await openSse(base);
    const leaving = await openSse(base);
    try {
      await staying.waitFor((buffer) => buffer.includes(': connected\n\n'));
      await leaving.waitFor((buffer) => buffer.includes(': connected\n\n'));
      assert.equal(server.clientCount(), 2);

      leaving.request.destroy();
      await waitUntil(() => server.clientCount() === 1, 'close-evicted SSE client');

      server.broadcast({ kind: 'submit', taskPda: 'TASK1', timestampUnix: 2 });
      await staying.waitFor((buffer) => buffer.includes('"kind":"submit"'));
    } finally {
      staying.request.destroy();
    }
  });
});

test('SSE: broadcast evicts wedged clients (backpressure) and destroys throwing ones', async () => {
  await withServer(async ({ server }) => {
    // White-box: inject stub clients into the private set to drive the
    // writeToClient eviction paths deterministically.
    const clients = (server as unknown as { clients: Set<unknown> }).clients;

    let backpressureDestroyed = false;
    const backpressured = {
      destroyed: false,
      writableEnded: false,
      write: () => false, // kernel buffer full -> evict, never queue in memory
      destroy: () => {
        backpressureDestroyed = true;
      },
    };

    let throwingDestroyed = false;
    const throwing = {
      destroyed: false,
      writableEnded: false,
      write: () => {
        throw new Error('boom');
      },
      destroy: () => {
        throwingDestroyed = true;
      },
    };

    const alreadyDead = { destroyed: true, writableEnded: false, write: () => true, destroy: () => {} };

    clients.add(backpressured);
    clients.add(throwing);
    clients.add(alreadyDead);
    assert.equal(server.clientCount(), 3);

    server.broadcast({ kind: 'task_posted', taskPda: 'TASK1', timestampUnix: 3 });

    assert.equal(server.clientCount(), 0);
    assert.equal(backpressureDestroyed, true);
    assert.equal(throwingDestroyed, true);
  });
});

test('SSE: broadcast with no clients is a no-op and close() ends remaining clients', async () => {
  const context = await startServer();
  let ended = false;
  try {
    // No clients: must not throw.
    context.server.broadcast({ kind: 'settle', timestampUnix: 4 });

    const client = await openSse(context.base);
    await client.waitFor((buffer) => buffer.includes(': connected\n\n'));
    client.response.on('end', () => {
      ended = true;
    });
    assert.equal(context.server.clientCount(), 1);

    context.server.close();
    await waitUntil(() => ended, 'server close to end the SSE stream');
    assert.equal(context.server.clientCount(), 0);
  } finally {
    context.server.close();
    context.store.close();
  }
});
