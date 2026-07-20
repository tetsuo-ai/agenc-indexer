import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  AGENT_REGISTRATION_DISCRIMINATOR,
  AgentStatus,
  DependencyType,
  getAgentRegistrationEncoder,
  getTaskClaimEncoder,
  getTaskEncoder,
  HIRE_RECORD_DISCRIMINATOR,
  SERVICE_LISTING_DISCRIMINATOR,
  TASK_CLAIM_DISCRIMINATOR,
  TASK_DISCRIMINATOR,
  TaskStatus,
  TaskType,
} from '@tetsuo-ai/marketplace-sdk';
import { SnapshotIndexer } from '../indexer.js';
import { IndexerStore } from '../store.js';

const PROGRAM_ID = new PublicKey('HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK');
const TASK = new PublicKey('ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2');
const AGENT = new PublicKey('9UEu2Gv9Q7DwBtumR2rUSq5g8v7b6mxn26ZNQCky82RJ');
const CLAIM = new PublicKey('13tuj7ELwtHmeR22kvaSaa2pKqSscyoHtQBF65aHuo6v');
const CREATOR = 'AtPmace7uiCiTGeVuiP2dRsmDRKv1rTLR6zUE5caErBE';
const DEFAULT_ADDRESS = '11111111111111111111111111111111';

function fixedText(value: string, size: number): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const output = new Uint8Array(size);
  output.set(bytes.subarray(0, size));
  return output;
}

function discriminatorBase58(value: Iterable<number>): string {
  return bs58.encode(Uint8Array.from(value));
}

function taskData(): Buffer {
  return Buffer.from(
    getTaskEncoder().encode({
      taskId: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      creator: CREATOR as never,
      requiredCapabilities: 5n,
      description: fixedText('Revision 5 fixture task', 64),
      constraintHash: new Uint8Array(32),
      rewardAmount: 123_456n,
      maxWorkers: 3,
      currentWorkers: 1,
      status: TaskStatus.InProgress,
      taskType: TaskType.Collaborative,
      createdAt: 1_780_000_000n,
      deadline: 1_780_086_400n,
      completedAt: 0n,
      escrow: DEFAULT_ADDRESS as never,
      result: new Uint8Array(64),
      completions: 0,
      requiredCompletions: 1,
      bump: 255,
      protocolFeeBps: 100,
      dependsOn: null,
      dependencyType: DependencyType.None,
      minReputation: 2_500,
      rewardMint: null,
      operator: DEFAULT_ADDRESS as never,
      operatorFeeBps: 0,
      reserved: new Uint8Array(16),
      referrer: DEFAULT_ADDRESS as never,
      referrerFeeBps: 0,
    }),
  );
}

function agentData(): Buffer {
  return Buffer.from(
    getAgentRegistrationEncoder().encode({
      agentId: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      authority: CREATOR as never,
      capabilities: 5n,
      status: AgentStatus.Busy,
      endpoint: 'https://worker.example.test',
      metadataUri: 'https://worker.example.test/agent.json',
      registeredAt: 1_779_000_000n,
      lastActive: 1_780_000_100n,
      tasksCompleted: 9n,
      totalEarned: 900_000n,
      reputation: 4_200,
      activeTasks: 1,
      stake: 500_000n,
      bump: 254,
      lastTaskCreated: 1_780_000_000n,
      lastDisputeInitiated: 0n,
      taskCount24h: 1,
      disputeCount24h: 0,
      rateLimitWindowStart: 1_780_000_000n,
      activeDisputeVotes: 0,
      lastVoteTimestamp: 0n,
      lastStateUpdate: 1_780_000_100n,
      disputesAsDefendant: 0,
      reserved: new Uint8Array(4),
    }),
  );
}

function claimData(): Buffer {
  return Buffer.from(
    getTaskClaimEncoder().encode({
      task: TASK.toBase58() as never,
      worker: AGENT.toBase58() as never,
      claimedAt: 1_780_000_050n,
      expiresAt: 1_780_086_400n,
      completedAt: 0n,
      proofHash: new Uint8Array(32),
      resultData: new Uint8Array(64),
      isCompleted: false,
      isValidated: false,
      rewardPaid: 0n,
      bump: 253,
    }),
  );
}

type ProgramAccount = {
  pubkey: PublicKey;
  account: { data: Buffer };
};

type ProgramAccountsConfig = {
  filters?: Array<{ memcmp?: { bytes: string }; dataSize?: number }>;
};

class MockConnection {
  taskAccounts: ProgramAccount[] = [{ pubkey: TASK, account: { data: taskData() } }];
  readonly filters: string[] = [];

  async getSlot(): Promise<number> {
    return 123_456;
  }

  async getProgramAccounts(
    _programId: PublicKey,
    config?: ProgramAccountsConfig,
  ): Promise<ProgramAccount[]> {
    const memcmp = config?.filters?.find((filter) => filter.memcmp)?.memcmp;
    if (!memcmp) {
      // The TaskSubmission data-size sweep is intentionally empty here.
      return [];
    }
    this.filters.push(memcmp.bytes);
    if (memcmp.bytes === discriminatorBase58(TASK_DISCRIMINATOR)) return this.taskAccounts;
    if (memcmp.bytes === discriminatorBase58(AGENT_REGISTRATION_DISCRIMINATOR)) {
      return [{ pubkey: AGENT, account: { data: agentData() } }];
    }
    if (memcmp.bytes === discriminatorBase58(TASK_CLAIM_DISCRIMINATOR)) {
      return [{ pubkey: CLAIM, account: { data: claimData() } }];
    }
    if (memcmp.bytes === discriminatorBase58(SERVICE_LISTING_DISCRIMINATOR)) return [];
    if (memcmp.bytes === discriminatorBase58(HIRE_RECORD_DISCRIMINATOR)) return [];
    throw new Error(`Unexpected discriminator filter: ${memcmp.bytes}`);
  }

  async getMultipleAccountsInfo(pdas: PublicKey[]): Promise<null[]> {
    return pdas.map(() => null);
  }
}

function makeIndexer(connection: MockConnection, store: IndexerStore, warnings: string[]): SnapshotIndexer {
  return new SnapshotIndexer({
    connection: connection as unknown as Connection,
    programId: PROGRAM_ID,
    store,
    logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    eventStoreLimit: 100,
    disableListingMetadata: true,
  });
}

test('revision-5 SDK decoders populate the snapshot read model', async () => {
  const connection = new MockConnection();
  const store = new IndexerStore(':memory:');
  const warnings: string[] = [];
  try {
    const result = await makeIndexer(connection, store, warnings).buildSnapshot();

    assert.deepEqual(
      {
        slot: result.slot,
        tasks: result.taskCount,
        agents: result.agentCount,
        claims: result.claimCount,
      },
      { slot: 123_456, tasks: 1, agents: 1, claims: 1 },
    );
    assert.equal(warnings.length, 0);

    const task = store.getTask(TASK.toBase58());
    assert.equal(task?.status, 'In Progress');
    assert.equal(task?.taskType, 'Collaborative');
    assert.equal(task?.requiredCapabilities, '5');
    assert.equal(task?.workerPda, AGENT.toBase58());
    assert.equal(task?.operator, null);
    assert.equal(task?.referrer, null);

    const agent = store.getAgent(AGENT.toBase58());
    assert.equal(agent?.authority, CREATOR);
    assert.equal(agent?.status, 'Busy');
    assert.equal(agent?.tasksCompleted, 9);
    assert.equal(agent?.capabilities, '5');
    assert.equal(agent?.stake, '500000');

    assert.deepEqual(
      new Set(connection.filters),
      new Set([
        discriminatorBase58(TASK_DISCRIMINATOR),
        discriminatorBase58(AGENT_REGISTRATION_DISCRIMINATOR),
        discriminatorBase58(TASK_CLAIM_DISCRIMINATOR),
        discriminatorBase58(SERVICE_LISTING_DISCRIMINATOR),
        discriminatorBase58(HIRE_RECORD_DISCRIMINATOR),
      ]),
    );
  } finally {
    store.close();
  }
});

test('total revision-5 decoder failure preserves the last good snapshot', async () => {
  const connection = new MockConnection();
  const store = new IndexerStore(':memory:');
  const warnings: string[] = [];
  const indexer = makeIndexer(connection, store, warnings);
  try {
    await indexer.buildSnapshot();
    connection.taskAccounts = [
      {
        pubkey: TASK,
        account: { data: Buffer.concat([Buffer.from(TASK_DISCRIMINATOR), Buffer.alloc(4)]) },
      },
    ];

    await assert.rejects(
      indexer.buildSnapshot(),
      /Refusing to replace the task snapshot: all 1 Task account\(s\) failed revision-5 decoding/,
    );
    assert.equal(store.getTask(TASK.toBase58())?.description, 'Revision 5 fixture task');
    assert.ok(warnings.some((message) => message.includes('Skipping undecodable task')));
  } finally {
    store.close();
  }
});
