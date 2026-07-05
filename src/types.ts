/**
 * API contract types (the fixed interface between services/indexer and
 * apps/web) plus the internal read-model record shapes.
 *
 * Contract rules: all JSON; bigints (lamports) serialized as decimal STRINGS.
 */

export type TaskStatusView = 'open' | 'claimed' | 'review' | 'settled' | 'cancelled' | 'disputed';

/** Stable machine keys for the on-chain TaskType enum (full surface). */
export type TaskTypeView =
  | 'exclusive'
  | 'collaborative'
  | 'competitive'
  | 'bid_exclusive'
  | 'unknown';

export type TaskView = {
  pda: string;
  title: string;
  status: TaskStatusView;
  /** Moderation pass: TaskModeration CLEAN or HUMAN_APPROVED. */
  verified: boolean;
  rewardLamports: string;
  deadlineUnix: number;
  creatorPda: string;
  createdAtUnix: number;
  /** Current claimant worker agent PDA (live claim), or null when unclaimed. */
  workerPda: string | null;
  /** On-chain required capability bitmask (u64) as a decimal string. */
  requiredCapabilities: string;
  /** Minimum worker reputation required to claim (on-chain u16). */
  minReputation: number;
  /** Pinned job-spec URI (TaskJobSpec), or null when no spec is pinned. */
  jobSpecUri: string | null;
  /** Pinned job-spec sha-256 as hex (64 chars), or null when no spec is pinned. */
  jobSpecHash: string | null;
  /** On-chain TaskType (all types are enabled on the full mainnet surface). */
  taskType: TaskTypeView;
  /** Maximum workers allowed (full surface: 1..=100 for any non-bid type). */
  maxWorkers: number;
  /** Current worker count. */
  currentWorkers: number;
  /** Protocol fee in basis points, locked into the task at creation. */
  protocolFeeBps: number;
  /** Operator (embedding-site) payee, or null when the task has no operator leg. */
  operator: string | null;
  /** Operator fee in basis points (0 = no operator leg). */
  operatorFeeBps: number;
  /** Referrer payee, or null when the task has no referrer leg. */
  referrer: string | null;
  /** Referrer fee in basis points (0 = no referrer leg). */
  referrerFeeBps: number;
};

export type AgentView = {
  pda: string;
  authority: string;
  status: string;
  reputation: number;
  tasksCompleted: number;
  registeredAtUnix: number;
  /** On-chain capability bitmask (u64) as a decimal string. */
  capabilities: string;
  /** Staked lamports (u64) as a decimal string. */
  stake: string;
};

export type FeedEventKind =
  | 'task_posted'
  | 'moderation_pass'
  | 'claim'
  | 'submit'
  | 'review_accepted'
  | 'changes_requested'
  | 'settle'
  | 'agent_registered';

export type FeedEventView = {
  kind: FeedEventKind;
  taskPda?: string;
  agentPda?: string;
  lamports?: string;
  riskScore?: number;
  artifactSha256?: string;
  timestampUnix: number;
};

export type StatsView = {
  slot: number;
  tasksSettled: number;
  lamportsPaidOut: string;
  registeredAgents: number;
  escrowLockedLamports: string;
  activeClaims: number;
  avgSettleSeconds: number;
  lastSettlementSecondsAgo: number | null;
  programId: string;
};

// ---------------------------------------------------------------------------
// Internal read-model records (explorer-derived SQLite rows)
// ---------------------------------------------------------------------------

/** Explorer-style task status labels, mapped to TaskStatusView at the HTTP edge. */
export type ExplorerTaskStatus =
  | 'Open'
  | 'In Progress'
  | 'Pending Validation'
  | 'Completed'
  | 'Cancelled'
  | 'Disputed'
  | 'Reject Frozen';

export type TaskRecord = {
  /** Hex of the on-chain 32-byte task_id. */
  id: string;
  pda: string;
  status: ExplorerTaskStatus;
  taskType: string;
  description: string;
  rewardRaw: string;
  rewardMint: string | null;
  creator: string;
  currentWorkers: number;
  maxWorkers: number;
  createdAt: number;
  deadline: number;
  completedAt: number;
  privateTask: boolean;
  /** Moderation pass (TaskModeration CLEAN=0 or HUMAN_APPROVED=4, unexpired). */
  verified: boolean;
  moderationStatus: number | null;
  moderationRiskScore: number | null;
  moderationRecordedAt: number | null;
  /** Required capability bitmask (u64) as a decimal string. */
  requiredCapabilities: string;
  /** Minimum reputation to claim (u16). */
  minReputation: number;
  jobSpecUri: string | null;
  jobSpecHashHex: string | null;
  validationModeKey: string | null;
  submissionStatusKey: string | null;
  submissionCount: number;
  submissionProofHashHex: string | null;
  submittedAt: number;
  acceptedAt: number;
  rejectedAt: number;
  /** Protocol fee bps locked at task creation (full-surface Task field). */
  protocolFeeBps: number;
  /** Operator payee (base58), or null when Pubkey::default() (no operator leg). */
  operator: string | null;
  operatorFeeBps: number;
  /** Referrer payee (base58), or null when Pubkey::default() (no referrer leg). */
  referrer: string | null;
  referrerFeeBps: number;
};

export type AgentRecord = {
  pda: string;
  authority: string;
  status: string;
  reputation: number;
  tasksCompleted: number;
  activeTasks: number;
  registeredAt: number;
  lastActive: number;
  /** Capability bitmask (u64) as a decimal string. */
  capabilities: string;
  /** Staked lamports (u64) as a decimal string. */
  stake: string;
};

/** A task row joined with its live-claim worker (read queries only). */
export type TaskRecordWithWorker = TaskRecord & {
  /** worker_pda of the live (completed_at = 0) claim, or null. */
  workerPda: string | null;
};

export type ClaimRecord = {
  claimPda: string;
  taskPda: string;
  workerPda: string;
  claimedAt: number;
  completedAt: number;
};

export type StoredFeedEvent = FeedEventView & {
  /** Deterministic id, used for idempotent insert + replay dedupe. */
  id: string;
};

export function mapTaskStatus(status: ExplorerTaskStatus | string): TaskStatusView {
  switch (status) {
    case 'Open':
      return 'open';
    case 'In Progress':
      return 'claimed';
    case 'Pending Validation':
      return 'review';
    case 'Completed':
      return 'settled';
    case 'Cancelled':
      return 'cancelled';
    case 'Disputed':
      return 'disputed';
    case 'Reject Frozen':
      // Batch-3 RejectFrozen (live since the 2026-06-11 full-surface
      // upgrade): the task is frozen pending dispute/expiry exits. The wire
      // contract keeps the six TaskStatusView values for now, and 'disputed'
      // is the honest needs-attention bucket — never claimable.
      return 'disputed';
    default:
      // Future unknown variants must never surface as claimable; 'disputed'
      // keeps them off the board until mapped explicitly.
      return 'disputed';
  }
}

/**
 * Wire status filter → the explorer statuses it covers. 'disputed' includes
 * 'Reject Frozen' so the filtered listing matches what mapTaskStatus shows.
 */
export function mapStatusFilter(filter: string): ExplorerTaskStatus[] | null {
  switch (filter) {
    case 'open':
      return ['Open'];
    case 'claimed':
      return ['In Progress'];
    case 'review':
      return ['Pending Validation'];
    case 'settled':
      return ['Completed'];
    case 'cancelled':
      return ['Cancelled'];
    case 'disputed':
      return ['Disputed', 'Reject Frozen'];
    default:
      return null;
  }
}

/** Stored task-type label → stable wire key. */
export function mapTaskType(label: string): TaskTypeView {
  switch (label) {
    case 'Exclusive':
      return 'exclusive';
    case 'Collaborative':
      return 'collaborative';
    case 'Competitive':
      return 'competitive';
    case 'Bid Exclusive':
      return 'bid_exclusive';
    default:
      return 'unknown';
  }
}

export function taskRecordToView(record: TaskRecordWithWorker): TaskView {
  return {
    pda: record.pda,
    title: record.description,
    status: mapTaskStatus(record.status),
    verified: record.verified,
    rewardLamports: record.rewardRaw,
    deadlineUnix: record.deadline,
    creatorPda: record.creator,
    createdAtUnix: record.createdAt,
    workerPda: record.workerPda,
    requiredCapabilities: record.requiredCapabilities,
    minReputation: record.minReputation,
    jobSpecUri: record.jobSpecUri,
    jobSpecHash: record.jobSpecHashHex,
    taskType: mapTaskType(record.taskType),
    maxWorkers: record.maxWorkers,
    currentWorkers: record.currentWorkers,
    protocolFeeBps: record.protocolFeeBps,
    operator: record.operator,
    operatorFeeBps: record.operatorFeeBps,
    referrer: record.referrer,
    referrerFeeBps: record.referrerFeeBps,
  };
}

export function agentRecordToView(record: AgentRecord): AgentView {
  return {
    pda: record.pda,
    authority: record.authority,
    status: record.status,
    reputation: record.reputation,
    tasksCompleted: record.tasksCompleted,
    registeredAtUnix: record.registeredAt,
    capabilities: record.capabilities,
    stake: record.stake,
  };
}
