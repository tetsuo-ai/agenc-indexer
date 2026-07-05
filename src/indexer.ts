import { utils } from '@coral-xyz/anchor';
import type { Connection, PublicKey } from '@solana/web3.js';
import { agentStatusToString, parseAgentState } from '@tetsuo-ai/runtime';
import {
  getServiceListingDecoder,
  getTaskDecoder,
  HIRE_RECORD_DISCRIMINATOR,
  SERVICE_LISTING_DISCRIMINATOR,
  TASK_DISCRIMINATOR,
  type Task as SdkTask,
} from '@tetsuo-ai/marketplace-sdk';
import { decodeHireRecordKeys, type HireRecordRow, type ListingRow } from './explorer.js';
import { ListingMetadataResolver } from './listing-metadata.js';
import {
  decodeTaskJobSpec,
  decodeTaskModeration,
  decodeTaskSubmission,
  decodeTaskValidationConfig,
  deriveTaskJobSpecPda,
  deriveTaskModerationCandidatePdas,
  deriveTaskSubmissionPda,
  deriveTaskValidationConfigPda,
  fetchAccountsByPda,
  isModerationPass,
  isPrivateConstraintHash,
  TASK_SUBMISSION_ACCOUNT_SIZE,
  type DecodedTaskJobSpec,
  type DecodedTaskModeration,
  type DecodedTaskSubmission,
} from './decoders.js';
import type { IndexerStore } from './store.js';
import { decodeOnChainText } from './text.js';
import type {
  AgentRecord,
  ClaimRecord,
  ExplorerTaskStatus,
  StoredFeedEvent,
  TaskRecord,
} from './types.js';

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/** Minimal structural slice of an anchor Program (avoids generic variance noise). */
export type ReadOnlyProgramLike = {
  programId: PublicKey;
  coder: { accounts: unknown };
};

export type SnapshotResult = {
  slot: number;
  taskCount: number;
  agentCount: number;
  claimCount: number;
  listingCount: number;
  hireRecordCount: number;
  newEvents: StoredFeedEvent[];
};

function toEpochSeconds(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const candidate = (value as { toNumber?: () => number }).toNumber;
    if (typeof candidate === 'function') {
      return candidate.call(value);
    }
  }
  return 0;
}

function normalizeBytes(value: unknown): Uint8Array | null {
  if (!value) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    const numeric = value.filter(
      (item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255,
    );
    return numeric.length ? Uint8Array.from(numeric) : null;
  }
  return null;
}

function bytesToHexSafe(value: unknown): string {
  const bytes = normalizeBytes(value);
  return bytes ? Buffer.from(bytes).toString('hex') : '';
}

/** anchor BN / bigint / number → canonical decimal string (u64-safe). */
function toDecimalString(value: unknown): string {
  if (typeof value === 'bigint' || typeof value === 'number') {
    return value.toString();
  }
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const text = String(value);
    if (/^\d+$/.test(text)) {
      return text;
    }
  }
  return '0';
}

// 64-byte on-chain description -> display title. Kept in sync with the web
// read model (apps/web/lib/server/read-model.ts). The field is attacker-
// controlled at task creation and is routinely a binary instruction hash, so
// only legible UTF-8 text is shown; anything else (binary, control bytes,
// mojibake) falls back to a hex preview instead of rendering garbled glyphs.
function decodeDescription(value: unknown): string {
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return decodeOnChainText(bytes) ?? (isZeroBytes(bytes) ? 'Unavailable' : hexPreview(bytes));
  }
  const bytes = normalizeBytes(value);
  if (!bytes?.length || isZeroBytes(bytes)) {
    return 'Unavailable';
  }
  return decodeOnChainText(bytes) ?? hexPreview(bytes);
}

function isZeroBytes(bytes: Uint8Array): boolean {
  return !bytes.some((b) => b !== 0);
}

function hexPreview(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex').slice(0, 24)}...`;
}

/**
 * On-chain TaskStatus (numeric enum from the marketplace SDK) → explorer
 * label. Unknown future variants map to 'Disputed' so they can never look
 * claimable (mapTaskStatus also buckets them as needs-attention).
 */
function taskStatusLabel(status: number): ExplorerTaskStatus {
  switch (status) {
    case 0:
      return 'Open';
    case 1:
      return 'In Progress';
    case 2:
      return 'Pending Validation';
    case 3:
      return 'Completed';
    case 4:
      return 'Cancelled';
    case 5:
      return 'Disputed';
    case 6:
      return 'Reject Frozen';
    default:
      return 'Disputed';
  }
}

/** On-chain TaskType (numeric enum from the marketplace SDK) → label. */
function taskTypeLabel(taskType: number): string {
  switch (taskType) {
    case 0:
      return 'Exclusive';
    case 1:
      return 'Collaborative';
    case 2:
      return 'Competitive';
    case 3:
      return 'Bid Exclusive';
    default:
      return `Type ${taskType}`;
  }
}

/** Pubkey::default() — the program encodes "no operator/referrer leg" as this. */
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

/** Kit Option<T> (structural — avoids a @solana/kit dependency) → T | null. */
type KitOption<T> = { __option: 'Some'; value: T } | { __option: 'None' };

function optionValue<T>(option: KitOption<T> | null | undefined): T | null {
  return option && option.__option === 'Some' ? option.value : null;
}

/** Address-valued payee where Pubkey::default() means "no leg" → base58 | null. */
function payeeOrNull(address: string): string | null {
  return address === DEFAULT_PUBKEY ? null : address;
}

export class SnapshotIndexer {
  private readonly connection: Connection;
  private readonly program: ReadOnlyProgramLike;
  private readonly store: IndexerStore;
  private readonly logger: Logger;
  private readonly eventStoreLimit: number;
  /** null when metadata validation is disabled via DISABLE_LISTING_METADATA. */
  private readonly metadataResolver: ListingMetadataResolver | null;

  constructor(params: {
    connection: Connection;
    program: ReadOnlyProgramLike;
    store: IndexerStore;
    logger: Logger;
    eventStoreLimit: number;
    disableListingMetadata?: boolean;
  }) {
    this.connection = params.connection;
    this.program = params.program;
    this.store = params.store;
    this.logger = params.logger;
    this.eventStoreLimit = params.eventStoreLimit;
    this.metadataResolver = params.disableListingMetadata ? null : new ListingMetadataResolver();
  }

  /**
   * Build a full snapshot from gPA + targeted account fetches, sync the
   * SQLite read model, and derive feed events with deterministic ids (the
   * store dedupes; only newly inserted events are returned for broadcast).
   */
  async buildSnapshot(): Promise<SnapshotResult> {
    const slot = await this.connection.getSlot('confirmed');

    const taskAccounts = await this.fetchTaskAccounts();
    const agentAccounts = await this.fetchDecodedAccounts('agentRegistration');
    const claimAccounts = await this.fetchDecodedAccounts('taskClaim');

    const claims: ClaimRecord[] = claimAccounts.map(({ publicKey, account }) => ({
      claimPda: publicKey.toBase58(),
      taskPda: account.task.toBase58(),
      workerPda: account.worker.toBase58(),
      claimedAt: toEpochSeconds(account.claimedAt),
      completedAt: toEpochSeconds(account.completedAt),
    }));

    const taskPdas = taskAccounts.map(({ publicKey }) => publicKey);
    const claimPdas = claimAccounts.map(({ publicKey }) => publicKey);
    const programId = this.program.programId;

    const jobSpecsByTaskPda = await this.fetchJobSpecs(taskPdas, programId);
    const moderationsByTaskPda = await this.fetchModerations(jobSpecsByTaskPda, programId);
    const validationConfigsByTaskPda = await this.fetchValidationConfigs(taskPdas, programId);
    const submissionsByTaskPda = await this.fetchSubmissions(claimPdas, programId);

    const nowUnix = Math.floor(Date.now() / 1000);

    const tasks: TaskRecord[] = taskAccounts.map(({ publicKey, task }) => {
      const pda = publicKey.toBase58();
      const jobSpec = jobSpecsByTaskPda.get(pda) ?? null;
      const moderation = moderationsByTaskPda.get(pda) ?? null;
      const validationConfig = validationConfigsByTaskPda.get(pda) ?? null;
      const submission = pickLatestSubmission(submissionsByTaskPda.get(pda) ?? []);
      const constraintHash = normalizeBytes(task.constraintHash);

      return {
        id: bytesToHexSafe(task.taskId) || pda,
        pda,
        status: taskStatusLabel(task.status),
        taskType: taskTypeLabel(task.taskType),
        description: decodeDescription(task.description),
        rewardRaw: task.rewardAmount.toString(),
        rewardMint: optionValue(task.rewardMint),
        creator: String(task.creator),
        currentWorkers: task.currentWorkers,
        maxWorkers: task.maxWorkers,
        createdAt: toEpochSeconds(task.createdAt),
        deadline: Math.max(0, toEpochSeconds(task.deadline)),
        completedAt: Math.max(0, toEpochSeconds(task.completedAt)),
        privateTask: isPrivateConstraintHash(constraintHash),
        verified: moderation ? isModerationPass(moderation, nowUnix) : false,
        requiredCapabilities: toDecimalString(task.requiredCapabilities),
        minReputation: task.minReputation,
        moderationStatus: moderation?.status ?? null,
        moderationRiskScore: moderation?.riskScore ?? null,
        moderationRecordedAt: moderation?.recordedAt ?? null,
        jobSpecUri: jobSpec?.jobSpecUri ?? null,
        jobSpecHashHex: jobSpec?.jobSpecHashHex ?? null,
        validationModeKey: validationConfig?.modeKey ?? null,
        submissionStatusKey: submission?.statusKey ?? null,
        submissionCount: submission?.submissionCount ?? 0,
        submissionProofHashHex: submission?.proofHashHex || null,
        submittedAt: Math.max(0, submission?.submittedAt ?? 0),
        acceptedAt: Math.max(0, submission?.acceptedAt ?? 0),
        rejectedAt: Math.max(0, submission?.rejectedAt ?? 0),
        protocolFeeBps: task.protocolFeeBps,
        operator: payeeOrNull(String(task.operator)),
        operatorFeeBps: task.operatorFeeBps,
        referrer: payeeOrNull(String(task.referrer)),
        referrerFeeBps: task.referrerFeeBps,
      };
    });

    const agents: AgentRecord[] = [];
    for (const { publicKey, account } of agentAccounts) {
      try {
        const agent = parseAgentState(account);
        agents.push({
          pda: publicKey.toBase58(),
          authority: agent.authority.toBase58(),
          status: agentStatusToString(agent.status),
          reputation: agent.reputation,
          tasksCompleted: Number(agent.tasksCompleted),
          activeTasks: agent.activeTasks,
          registeredAt: toEpochSeconds(agent.registeredAt),
          lastActive: toEpochSeconds(agent.lastActive),
          capabilities: toDecimalString(agent.capabilities),
          stake: toDecimalString(agent.stake),
        });
      } catch (error) {
        this.logger.warn(
          `Skipping unparseable agent ${publicKey.toBase58()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Explorer projections: ServiceListing + HireRecord raw accounts, kept
    // byte-true (base64 of the on-chain bytes) for the /api/explorer routes.
    const listings = await this.fetchListingRows(slot);
    const hireRecords = await this.fetchHireRecordRows();

    this.store.syncTasks(tasks);
    this.store.syncAgents(agents);
    this.store.syncClaims(claims);
    this.store.syncListings(listings);
    this.store.syncHireRecords(hireRecords);

    const newEvents = this.deriveFeedEvents(tasks, agents, claims, nowUnix);
    this.store.pruneEvents(this.eventStoreLimit);

    return {
      slot,
      taskCount: tasks.length,
      agentCount: agents.length,
      claimCount: claims.length,
      listingCount: listings.length,
      hireRecordCount: hireRecords.length,
      newEvents,
    };
  }

  /** Raw gPA fetch by 8-byte account discriminator (memcmp at offset 0). */
  private async fetchRawAccountsByDiscriminator(
    discriminator: Iterable<number>,
  ): Promise<Array<{ pda: string; data: Buffer; dataB64: string }>> {
    const rawAccounts = await this.connection.getProgramAccounts(this.program.programId, {
      commitment: 'confirmed',
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: utils.bytes.bs58.encode(Buffer.from(Uint8Array.from(discriminator))),
          },
        },
      ],
    });
    return rawAccounts.map((account) => {
      const data = account.account.data as Buffer;
      return { pda: account.pubkey.toBase58(), data, dataB64: data.toString('base64') };
    });
  }

  /**
   * ServiceListing rows for /api/explorer/listings: raw bytes + the
   * LISTING_METADATA v1 conformance verdict (see listing-metadata.ts). With
   * metadata validation disabled every row is metadataValid=false with an
   * explicit issue, never a fabricated pass.
   */
  private async fetchListingRows(slot: number): Promise<ListingRow[]> {
    const rawAccounts = await this.fetchRawAccountsByDiscriminator(SERVICE_LISTING_DISCRIMINATOR);
    const decoder = getServiceListingDecoder();
    const rows: ListingRow[] = [];
    for (const account of rawAccounts) {
      let specUri: string | null = null;
      let specHashHex: string | null = null;
      try {
        const decoded = decoder.decode(Uint8Array.from(account.data));
        specUri = decoded.specUri || null;
        specHashHex = Buffer.from(decoded.specHash as Uint8Array).toString('hex');
      } catch (error) {
        this.logger.warn(
          `Skipping undecodable ServiceListing ${account.pda}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      let metadataValid = false;
      const metadataIssues: string[] = [];
      if (this.metadataResolver) {
        const metadata = await this.metadataResolver.resolve(specUri, specHashHex);
        metadataValid = metadata.state === 'verified';
        if (metadata.state !== 'verified') {
          metadataIssues.push(metadata.error ?? `spec metadata ${metadata.state}`);
        }
      } else {
        metadataIssues.push('listing metadata validation is disabled (DISABLE_LISTING_METADATA)');
      }
      rows.push({
        pda: account.pda,
        accountDataB64: account.dataB64,
        metadataValid,
        metadataIssues,
        lastSlot: slot,
      });
    }
    return rows;
  }

  /** HireRecord rows for /api/explorer/listings/:pda/hires. */
  private async fetchHireRecordRows(): Promise<HireRecordRow[]> {
    const rawAccounts = await this.fetchRawAccountsByDiscriminator(HIRE_RECORD_DISCRIMINATOR);
    const rows: HireRecordRow[] = [];
    for (const account of rawAccounts) {
      const keys = decodeHireRecordKeys(account.dataB64);
      if (!keys) {
        this.logger.warn(`Skipping undecodable HireRecord ${account.pda}`);
        continue;
      }
      rows.push({
        pda: account.pda,
        accountDataB64: account.dataB64,
        listing: keys.listing,
        task: keys.task,
      });
    }
    return rows;
  }

  /**
   * Derive contract feed events from indexed state with deterministic ids so
   * re-observation is idempotent. Historical timestamps come from on-chain
   * fields, which makes the first sync backfill /api/activity history.
   */
  private deriveFeedEvents(
    tasks: TaskRecord[],
    agents: AgentRecord[],
    claims: ClaimRecord[],
    nowUnix: number,
  ): StoredFeedEvent[] {
    const candidates: StoredFeedEvent[] = [];

    // task → worker, so settle events can name the paid agent. Claims whose
    // accounts were closed on-chain are absent — agentPda stays undefined.
    const workerByTask = new Map<string, string>();
    for (const claim of claims) {
      workerByTask.set(claim.taskPda, claim.workerPda);
    }

    for (const task of tasks) {
      candidates.push({
        id: `task_posted:${task.pda}`,
        kind: 'task_posted',
        taskPda: task.pda,
        lamports: task.rewardMint ? undefined : task.rewardRaw,
        timestampUnix: task.createdAt || nowUnix,
      });

      if (task.verified) {
        candidates.push({
          id: `moderation_pass:${task.pda}`,
          kind: 'moderation_pass',
          taskPda: task.pda,
          riskScore: task.moderationRiskScore ?? undefined,
          timestampUnix: task.moderationRecordedAt || nowUnix,
        });
      }

      if (task.submittedAt > 0) {
        candidates.push({
          id: `submit:${task.pda}:${task.submissionCount}`,
          kind: 'submit',
          taskPda: task.pda,
          artifactSha256: task.submissionProofHashHex ?? undefined,
          timestampUnix: task.submittedAt,
        });
      }

      if (task.rejectedAt > 0) {
        candidates.push({
          id: `changes_requested:${task.pda}:${task.submissionCount}`,
          kind: 'changes_requested',
          taskPda: task.pda,
          timestampUnix: task.rejectedAt,
        });
      }

      if (task.acceptedAt > 0) {
        candidates.push({
          id: `review_accepted:${task.pda}`,
          kind: 'review_accepted',
          taskPda: task.pda,
          timestampUnix: task.acceptedAt,
        });
      }

      if (task.status === 'Completed') {
        candidates.push({
          id: `settle:${task.pda}`,
          kind: 'settle',
          taskPda: task.pda,
          agentPda: workerByTask.get(task.pda),
          lamports: task.rewardMint ? undefined : task.rewardRaw,
          timestampUnix: task.completedAt || nowUnix,
        });
      }
    }

    for (const claim of claims) {
      candidates.push({
        id: `claim:${claim.claimPda}`,
        kind: 'claim',
        taskPda: claim.taskPda,
        agentPda: claim.workerPda,
        timestampUnix: claim.claimedAt || nowUnix,
      });
    }

    for (const agent of agents) {
      candidates.push({
        id: `agent_registered:${agent.pda}`,
        kind: 'agent_registered',
        agentPda: agent.pda,
        timestampUnix: agent.registeredAt || nowUnix,
      });
    }

    const inserted: StoredFeedEvent[] = [];
    for (const candidate of candidates) {
      if (this.store.insertEvent(candidate)) {
        inserted.push(candidate);
      }
    }
    inserted.sort((left, right) => left.timestampUnix - right.timestampUnix);
    return inserted;
  }

  /**
   * Fetch + decode every Task account with the marketplace SDK's generated
   * decoder — its ACCOUNT layouts (incl. the 466-byte Task) are verified
   * byte-identical to the full-surface binary live on mainnet since the
   * 2026-06-11 upgrade. (The published 0.6.0 SDK drifted from the deployed
   * tree only in a few instruction account lists — irrelevant to a
   * read-only decoder.) The legacy `@tetsuo-ai/runtime` IDL predates
   * Batch 2/3 and is blind to the operator/referrer fields, so it is no
   * longer used for Task decoding.
   *
   * The gPA discriminator filter still comes from the legacy coder (the
   * 8-byte sha256("account:Task") prefix is layout-independent), and each
   * account's decoded discriminator is asserted against the SDK constant so
   * any drift fails closed instead of mis-decoding.
   */
  private async fetchTaskAccounts(): Promise<Array<{ publicKey: PublicKey; task: SdkTask }>> {
    const coder = this.program.coder.accounts as unknown as {
      memcmp: (name: string) => { offset: number; bytes: string };
    };
    const rawAccounts = await this.connection.getProgramAccounts(this.program.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: coder.memcmp('task') }],
    });

    const decoder = getTaskDecoder();
    const expectedDiscriminator = Buffer.from(TASK_DISCRIMINATOR);
    const decoded: Array<{ publicKey: PublicKey; task: SdkTask }> = [];
    let skipped = 0;
    for (const rawAccount of rawAccounts) {
      try {
        const data = rawAccount.account.data as Buffer;
        if (!data.subarray(0, 8).equals(expectedDiscriminator)) {
          throw new Error('discriminator mismatch between the gPA filter and the SDK decoder');
        }
        decoded.push({ publicKey: rawAccount.pubkey, task: decoder.decode(data) });
      } catch (error) {
        skipped += 1;
        if (skipped <= 5) {
          this.logger.warn(
            `Skipping undecodable task ${rawAccount.pubkey.toBase58()}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    if (skipped > 0) {
      this.logger.warn(`Skipped ${skipped} undecodable task account(s)`);
    }
    return decoded;
  }

  private async fetchDecodedAccounts(
    accountName: string,
  ): Promise<Array<{ publicKey: PublicKey; account: any }>> {
    const coder = this.program.coder.accounts as unknown as {
      memcmp: (name: string) => { offset: number; bytes: string };
      decode: (name: string, data: Buffer) => any;
    };
    const discriminatorFilter = { memcmp: coder.memcmp(accountName) };
    const rawAccounts = await this.connection.getProgramAccounts(this.program.programId, {
      commitment: 'confirmed',
      filters: [discriminatorFilter],
    });

    const decoded: Array<{ publicKey: PublicKey; account: any }> = [];
    let skipped = 0;
    for (const rawAccount of rawAccounts) {
      try {
        decoded.push({
          publicKey: rawAccount.pubkey,
          account: coder.decode(accountName, rawAccount.account.data as Buffer),
        });
      } catch (error) {
        skipped += 1;
        if (skipped <= 5) {
          this.logger.warn(
            `Skipping undecodable ${accountName} ${rawAccount.pubkey.toBase58()}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    if (skipped > 0) {
      this.logger.warn(`Skipped ${skipped} undecodable ${accountName} account(s)`);
    }
    return decoded;
  }

  private async fetchJobSpecs(
    taskPdas: PublicKey[],
    programId: PublicKey,
  ): Promise<Map<string, DecodedTaskJobSpec>> {
    const byTaskPda = new Map<string, DecodedTaskJobSpec>();
    if (!taskPdas.length) {
      return byTaskPda;
    }
    const pdas = taskPdas.map((taskPda) => deriveTaskJobSpecPda(taskPda, programId));
    for (const { pda, data } of await fetchAccountsByPda(this.connection, pdas)) {
      try {
        const decoded = decodeTaskJobSpec(pda, data);
        byTaskPda.set(decoded.task, decoded);
      } catch (error) {
        this.logger.warn(
          `Skipping undecodable TaskJobSpec ${pda.toBase58()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return byTaskPda;
  }

  private async fetchModerations(
    jobSpecsByTaskPda: Map<string, DecodedTaskJobSpec>,
    programId: PublicKey,
  ): Promise<Map<string, DecodedTaskModeration>> {
    const byTaskPda = new Map<string, DecodedTaskModeration>();
    if (!jobSpecsByTaskPda.size) {
      return byTaskPda;
    }
    const { PublicKey: Pk } = await import('@solana/web3.js');
    // P1.2: records are moderator-keyed — sweep each trusted moderator's v2
    // PDA plus the frozen legacy grace-window PDA (candidates are ordered by
    // trust priority per task; the first decodable hit wins).
    const pdas = [...jobSpecsByTaskPda.values()].flatMap((jobSpec) =>
      deriveTaskModerationCandidatePdas(new Pk(jobSpec.task), jobSpec.jobSpecHash, programId),
    );
    for (const { pda, data } of await fetchAccountsByPda(this.connection, pdas)) {
      try {
        const decoded = decodeTaskModeration(pda, data);
        if (byTaskPda.has(decoded.task)) continue;
        byTaskPda.set(decoded.task, decoded);
      } catch (error) {
        this.logger.warn(
          `Skipping undecodable TaskModeration ${pda.toBase58()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return byTaskPda;
  }

  private async fetchValidationConfigs(
    taskPdas: PublicKey[],
    programId: PublicKey,
  ): Promise<Map<string, ReturnType<typeof decodeTaskValidationConfig>>> {
    const byTaskPda = new Map<string, ReturnType<typeof decodeTaskValidationConfig>>();
    if (!taskPdas.length) {
      return byTaskPda;
    }
    const pdas = taskPdas.map((taskPda) => deriveTaskValidationConfigPda(taskPda, programId));
    for (const { pda, data } of await fetchAccountsByPda(this.connection, pdas)) {
      try {
        const decoded = decodeTaskValidationConfig(pda, data);
        byTaskPda.set(decoded.task, decoded);
      } catch (error) {
        this.logger.warn(
          `Skipping undecodable TaskValidationConfig ${pda.toBase58()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return byTaskPda;
  }

  private async fetchSubmissions(
    claimPdas: PublicKey[],
    programId: PublicKey,
  ): Promise<Map<string, DecodedTaskSubmission[]>> {
    const byTaskPda = new Map<string, DecodedTaskSubmission[]>();
    const accountsByPda = new Map<string, { pda: PublicKey; data: Buffer }>();

    if (claimPdas.length) {
      const derived = claimPdas.map((claimPda) => deriveTaskSubmissionPda(claimPda, programId));
      for (const account of await fetchAccountsByPda(this.connection, derived)) {
        accountsByPda.set(account.pda.toBase58(), account);
      }
    }

    // Secondary dataSize scan catches submissions whose claims were closed.
    try {
      const scanned = await this.connection.getProgramAccounts(programId, {
        commitment: 'confirmed',
        filters: [{ dataSize: TASK_SUBMISSION_ACCOUNT_SIZE }],
      });
      for (const account of scanned) {
        accountsByPda.set(account.pubkey.toBase58(), {
          pda: account.pubkey,
          data: Buffer.from(account.account.data),
        });
      }
    } catch (error) {
      this.logger.warn(
        `TaskSubmission dataSize scan failed (continuing with derived PDAs): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const { pda, data } of accountsByPda.values()) {
      try {
        const decoded = decodeTaskSubmission(pda, data);
        const list = byTaskPda.get(decoded.task) ?? [];
        list.push(decoded);
        byTaskPda.set(decoded.task, list);
      } catch {
        // dataSize collisions with non-submission accounts are expected; skip.
      }
    }
    return byTaskPda;
  }
}

function pickLatestSubmission(submissions: DecodedTaskSubmission[]): DecodedTaskSubmission | null {
  if (!submissions.length) {
    return null;
  }
  return [...submissions].sort((left, right) => {
    const leftTs = Math.max(left.submittedAt, left.acceptedAt, left.rejectedAt);
    const rightTs = Math.max(right.submittedAt, right.acceptedAt, right.rejectedAt);
    if (leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return right.submissionCount - left.submissionCount;
  })[0];
}
