import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { HireRecordRow, ListingRow } from './explorer.js';
import type {
  AgentRecord,
  ClaimRecord,
  ExplorerTaskStatus,
  FeedEventView,
  StoredFeedEvent,
  TaskRecord,
  TaskRecordWithWorker,
} from './types.js';

/**
 * SQLite read model, adapted from agenc-public-explorer explorer-store.ts:
 * same WAL/upsert/remove-missing sync pattern, with the tasks table extended
 * by moderation + submission columns and the events table reshaped to the
 * FeedEventView contract. A claims table is added for the stats endpoint.
 */

type SqlValue = string | number | null;

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value!)));
}

function parseTaskRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    pda: String(row.pda),
    status: String(row.status) as ExplorerTaskStatus,
    taskType: String(row.task_type),
    description: String(row.description),
    rewardRaw: String(row.reward_raw),
    rewardMint: row.reward_mint ? String(row.reward_mint) : null,
    creator: String(row.creator),
    currentWorkers: Number(row.current_workers),
    maxWorkers: Number(row.max_workers),
    createdAt: Number(row.created_at),
    deadline: Number(row.deadline ?? 0),
    completedAt: Number(row.completed_at ?? 0),
    privateTask: Boolean(row.private_task),
    verified: Boolean(row.verified),
    requiredCapabilities: String(row.required_capabilities ?? '0'),
    minReputation: Number(row.min_reputation ?? 0),
    moderationStatus: row.moderation_status === null ? null : Number(row.moderation_status),
    moderationRiskScore: row.moderation_risk_score === null ? null : Number(row.moderation_risk_score),
    moderationRecordedAt: row.moderation_recorded_at === null ? null : Number(row.moderation_recorded_at),
    jobSpecUri: row.job_spec_uri ? String(row.job_spec_uri) : null,
    jobSpecHashHex: row.job_spec_hash_hex ? String(row.job_spec_hash_hex) : null,
    validationModeKey: row.validation_mode_key ? String(row.validation_mode_key) : null,
    submissionStatusKey: row.submission_status_key ? String(row.submission_status_key) : null,
    submissionCount: Number(row.submission_count ?? 0),
    submissionProofHashHex: row.submission_proof_hash_hex ? String(row.submission_proof_hash_hex) : null,
    submittedAt: Number(row.submitted_at ?? 0),
    acceptedAt: Number(row.accepted_at ?? 0),
    rejectedAt: Number(row.rejected_at ?? 0),
    protocolFeeBps: Number(row.protocol_fee_bps ?? 0),
    operator: row.operator ? String(row.operator) : null,
    operatorFeeBps: Number(row.operator_fee_bps ?? 0),
    referrer: row.referrer ? String(row.referrer) : null,
    referrerFeeBps: Number(row.referrer_fee_bps ?? 0),
  };
}

function parseAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    pda: String(row.pda),
    authority: String(row.authority),
    status: String(row.status),
    reputation: Number(row.reputation),
    tasksCompleted: Number(row.tasks_completed),
    activeTasks: Number(row.active_tasks),
    registeredAt: Number(row.registered_at),
    lastActive: Number(row.last_active),
    capabilities: String(row.capabilities ?? '0'),
    stake: String(row.stake ?? '0'),
  };
}

function parseTaskRowWithWorker(row: Record<string, unknown>): TaskRecordWithWorker {
  return {
    ...parseTaskRow(row),
    workerPda: row.worker_pda ? String(row.worker_pda) : null,
  };
}

/**
 * Scalar subquery attaching the live claim's worker to a task row. "Live" =
 * the claim account still exists and is not completed (mirrors the stats
 * activeClaims semantics); newest claim wins if several are open.
 */
const WORKER_PDA_SUBQUERY = `(
  SELECT worker_pda FROM claims
  WHERE claims.task_pda = tasks.pda AND claims.completed_at = 0
  ORDER BY claimed_at DESC LIMIT 1
) AS worker_pda`;

function parseIssues(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseEventRow(row: Record<string, unknown>): StoredFeedEvent {
  const event: StoredFeedEvent = {
    id: String(row.id),
    kind: String(row.kind) as FeedEventView['kind'],
    timestampUnix: Number(row.timestamp_unix),
  };
  if (row.task_pda) {
    event.taskPda = String(row.task_pda);
  }
  if (row.agent_pda) {
    event.agentPda = String(row.agent_pda);
  }
  if (row.lamports !== null && row.lamports !== undefined) {
    event.lamports = String(row.lamports);
  }
  if (row.risk_score !== null && row.risk_score !== undefined) {
    event.riskScore = Number(row.risk_score);
  }
  if (row.artifact_sha256) {
    event.artifactSha256 = String(row.artifact_sha256);
  }
  return event;
}

export class IndexerStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  // -- sync ----------------------------------------------------------------

  syncTasks(tasks: TaskRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO tasks (
        id, pda, status, task_type, description, reward_raw, reward_mint, creator,
        current_workers, max_workers, created_at, deadline, completed_at, private_task,
        verified, required_capabilities, min_reputation,
        moderation_status, moderation_risk_score, moderation_recorded_at,
        job_spec_uri, job_spec_hash_hex, validation_mode_key,
        submission_status_key, submission_count, submission_proof_hash_hex,
        submitted_at, accepted_at, rejected_at,
        protocol_fee_bps, operator, operator_fee_bps, referrer, referrer_fee_bps
      ) VALUES (
        @id, @pda, @status, @taskType, @description, @rewardRaw, @rewardMint, @creator,
        @currentWorkers, @maxWorkers, @createdAt, @deadline, @completedAt, @privateTask,
        @verified, @requiredCapabilities, @minReputation,
        @moderationStatus, @moderationRiskScore, @moderationRecordedAt,
        @jobSpecUri, @jobSpecHashHex, @validationModeKey,
        @submissionStatusKey, @submissionCount, @submissionProofHashHex,
        @submittedAt, @acceptedAt, @rejectedAt,
        @protocolFeeBps, @operator, @operatorFeeBps, @referrer, @referrerFeeBps
      )
      ON CONFLICT(pda) DO UPDATE SET
        id = excluded.id,
        status = excluded.status,
        task_type = excluded.task_type,
        description = excluded.description,
        reward_raw = excluded.reward_raw,
        reward_mint = excluded.reward_mint,
        creator = excluded.creator,
        current_workers = excluded.current_workers,
        max_workers = excluded.max_workers,
        created_at = excluded.created_at,
        deadline = excluded.deadline,
        completed_at = excluded.completed_at,
        private_task = excluded.private_task,
        verified = excluded.verified,
        required_capabilities = excluded.required_capabilities,
        min_reputation = excluded.min_reputation,
        moderation_status = excluded.moderation_status,
        moderation_risk_score = excluded.moderation_risk_score,
        moderation_recorded_at = excluded.moderation_recorded_at,
        job_spec_uri = excluded.job_spec_uri,
        job_spec_hash_hex = excluded.job_spec_hash_hex,
        validation_mode_key = excluded.validation_mode_key,
        submission_status_key = excluded.submission_status_key,
        submission_count = excluded.submission_count,
        submission_proof_hash_hex = excluded.submission_proof_hash_hex,
        submitted_at = excluded.submitted_at,
        accepted_at = excluded.accepted_at,
        rejected_at = excluded.rejected_at,
        protocol_fee_bps = excluded.protocol_fee_bps,
        operator = excluded.operator,
        operator_fee_bps = excluded.operator_fee_bps,
        referrer = excluded.referrer,
        referrer_fee_bps = excluded.referrer_fee_bps
    `);

    const transaction = this.db.transaction((items: TaskRecord[]) => {
      for (const task of items) {
        upsert.run({
          id: task.id,
          pda: task.pda,
          status: task.status,
          taskType: task.taskType,
          description: task.description,
          rewardRaw: task.rewardRaw,
          rewardMint: task.rewardMint,
          creator: task.creator,
          currentWorkers: task.currentWorkers,
          maxWorkers: task.maxWorkers,
          createdAt: task.createdAt,
          deadline: task.deadline,
          completedAt: task.completedAt,
          privateTask: task.privateTask ? 1 : 0,
          verified: task.verified ? 1 : 0,
          requiredCapabilities: task.requiredCapabilities,
          minReputation: task.minReputation,
          moderationStatus: task.moderationStatus,
          moderationRiskScore: task.moderationRiskScore,
          moderationRecordedAt: task.moderationRecordedAt,
          jobSpecUri: task.jobSpecUri,
          jobSpecHashHex: task.jobSpecHashHex,
          validationModeKey: task.validationModeKey,
          submissionStatusKey: task.submissionStatusKey,
          submissionCount: task.submissionCount,
          submissionProofHashHex: task.submissionProofHashHex,
          submittedAt: task.submittedAt,
          acceptedAt: task.acceptedAt,
          rejectedAt: task.rejectedAt,
          protocolFeeBps: task.protocolFeeBps,
          operator: task.operator,
          operatorFeeBps: task.operatorFeeBps,
          referrer: task.referrer,
          referrerFeeBps: task.referrerFeeBps,
        });
      }
      this.removeMissing('tasks', 'pda', items.map((task) => task.pda));
    });
    transaction(tasks);
  }

  syncAgents(agents: AgentRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO agents (
        pda, authority, status, reputation, tasks_completed, active_tasks,
        registered_at, last_active, capabilities, stake
      ) VALUES (
        @pda, @authority, @status, @reputation, @tasksCompleted, @activeTasks,
        @registeredAt, @lastActive, @capabilities, @stake
      )
      ON CONFLICT(pda) DO UPDATE SET
        authority = excluded.authority,
        status = excluded.status,
        reputation = excluded.reputation,
        tasks_completed = excluded.tasks_completed,
        active_tasks = excluded.active_tasks,
        registered_at = excluded.registered_at,
        last_active = excluded.last_active,
        capabilities = excluded.capabilities,
        stake = excluded.stake
    `);
    const transaction = this.db.transaction((items: AgentRecord[]) => {
      for (const agent of items) {
        upsert.run({
          pda: agent.pda,
          authority: agent.authority,
          status: agent.status,
          reputation: agent.reputation,
          tasksCompleted: agent.tasksCompleted,
          activeTasks: agent.activeTasks,
          registeredAt: agent.registeredAt,
          lastActive: agent.lastActive,
          capabilities: agent.capabilities,
          stake: agent.stake,
        });
      }
      this.removeMissing('agents', 'pda', items.map((agent) => agent.pda));
    });
    transaction(agents);
  }

  syncClaims(claims: ClaimRecord[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO claims (claim_pda, task_pda, worker_pda, claimed_at, completed_at)
      VALUES (@claimPda, @taskPda, @workerPda, @claimedAt, @completedAt)
      ON CONFLICT(claim_pda) DO UPDATE SET
        task_pda = excluded.task_pda,
        worker_pda = excluded.worker_pda,
        claimed_at = excluded.claimed_at,
        completed_at = excluded.completed_at
    `);
    const transaction = this.db.transaction((items: ClaimRecord[]) => {
      for (const claim of items) {
        upsert.run({
          claimPda: claim.claimPda,
          taskPda: claim.taskPda,
          workerPda: claim.workerPda,
          claimedAt: claim.claimedAt,
          completedAt: claim.completedAt,
        });
      }
      this.removeMissing('claims', 'claim_pda', items.map((claim) => claim.claimPda));
    });
    transaction(claims);
  }

  syncListings(listings: ListingRow[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO listings (pda, account_data_b64, metadata_valid, metadata_issues, last_slot)
      VALUES (@pda, @accountDataB64, @metadataValid, @metadataIssues, @lastSlot)
      ON CONFLICT(pda) DO UPDATE SET
        account_data_b64 = excluded.account_data_b64,
        metadata_valid = excluded.metadata_valid,
        metadata_issues = excluded.metadata_issues,
        last_slot = excluded.last_slot
    `);
    const transaction = this.db.transaction((items: ListingRow[]) => {
      for (const listing of items) {
        upsert.run({
          pda: listing.pda,
          accountDataB64: listing.accountDataB64,
          metadataValid: listing.metadataValid ? 1 : 0,
          metadataIssues: JSON.stringify(listing.metadataIssues),
          lastSlot: listing.lastSlot,
        });
      }
      this.removeMissing('listings', 'pda', items.map((listing) => listing.pda));
    });
    transaction(listings);
  }

  syncHireRecords(hireRecords: HireRecordRow[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO hire_records (pda, account_data_b64, listing, task)
      VALUES (@pda, @accountDataB64, @listing, @task)
      ON CONFLICT(pda) DO UPDATE SET
        account_data_b64 = excluded.account_data_b64,
        listing = excluded.listing,
        task = excluded.task
    `);
    const transaction = this.db.transaction((items: HireRecordRow[]) => {
      for (const record of items) {
        upsert.run({
          pda: record.pda,
          accountDataB64: record.accountDataB64,
          listing: record.listing,
          task: record.task,
        });
      }
      this.removeMissing('hire_records', 'pda', items.map((record) => record.pda));
    });
    transaction(hireRecords);
  }

  listListingRows(): ListingRow[] {
    const rows = this.db
      .prepare('SELECT * FROM listings ORDER BY pda ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      pda: String(row.pda),
      accountDataB64: String(row.account_data_b64),
      metadataValid: Boolean(row.metadata_valid),
      metadataIssues: parseIssues(row.metadata_issues),
      lastSlot: Number(row.last_slot ?? 0),
    }));
  }

  listHireRecordRows(listingPda?: string): HireRecordRow[] {
    const rows = (
      listingPda
        ? this.db.prepare('SELECT * FROM hire_records WHERE listing = ? ORDER BY pda ASC').all(listingPda)
        : this.db.prepare('SELECT * FROM hire_records ORDER BY pda ASC').all()
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      pda: String(row.pda),
      accountDataB64: String(row.account_data_b64),
      listing: String(row.listing),
      task: String(row.task),
    }));
  }

  /** Minimal task join for the hires projection (buyer + price). */
  getTaskJoin(pda: string): { creator: string; rewardRaw: string } | null {
    const row = this.db
      .prepare('SELECT creator, reward_raw FROM tasks WHERE pda = ? LIMIT 1')
      .get(pda) as { creator: string; reward_raw: string } | undefined;
    return row ? { creator: row.creator, rewardRaw: row.reward_raw } : null;
  }

  // -- events ---------------------------------------------------------------

  /**
   * Idempotent insert keyed by deterministic id. Returns true only when the
   * event is new — callers broadcast to SSE clients only in that case, so
   * poll-derived re-observations never duplicate the feed.
   */
  insertEvent(event: StoredFeedEvent): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        id, kind, task_pda, agent_pda, lamports, risk_score, artifact_sha256, timestamp_unix
      ) VALUES (
        @id, @kind, @taskPda, @agentPda, @lamports, @riskScore, @artifactSha256, @timestampUnix
      )
    `).run({
      id: event.id,
      kind: event.kind,
      taskPda: event.taskPda ?? null,
      agentPda: event.agentPda ?? null,
      lamports: event.lamports ?? null,
      riskScore: event.riskScore ?? null,
      artifactSha256: event.artifactSha256 ?? null,
      timestampUnix: event.timestampUnix,
    });
    return result.changes > 0;
  }

  pruneEvents(limit: number): void {
    this.db.prepare(`
      DELETE FROM events
      WHERE id NOT IN (
        SELECT id FROM events ORDER BY timestamp_unix DESC, rowid DESC LIMIT ?
      )
    `).run(limit);
  }

  listEvents(limit: number): StoredFeedEvent[] {
    const normalized = clamp(limit, 1, 500, 40);
    const rows = this.db.prepare(`
      SELECT * FROM events
      ORDER BY timestamp_unix DESC, rowid DESC
      LIMIT ?
    `).all(normalized) as Record<string, unknown>[];
    return rows.map(parseEventRow);
  }

  // -- queries ---------------------------------------------------------------

  listTasks(params: { status?: ExplorerTaskStatus[] | null; page?: number; pageSize?: number }): {
    items: TaskRecordWithWorker[];
    page: number;
    pageSize: number;
    total: number;
  } {
    const page = clamp(params.page, 1, 100_000, 1);
    const pageSize = clamp(params.pageSize, 1, 100, 24);
    const statuses = params.status ?? [];
    const where = statuses.length
      ? `WHERE status IN (${statuses.map(() => '?').join(', ')})`
      : '';
    const args: SqlValue[] = [...statuses];

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM tasks ${where}`)
      .get(...args) as { count: number };
    const rows = this.db.prepare(`
      SELECT tasks.*, ${WORKER_PDA_SUBQUERY} FROM tasks
      ${where}
      ORDER BY created_at DESC, pda DESC
      LIMIT ? OFFSET ?
    `).all(...args, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

    return {
      items: rows.map(parseTaskRowWithWorker),
      page,
      pageSize,
      total: totalRow.count,
    };
  }

  getTask(pda: string): TaskRecordWithWorker | null {
    const row = this.db
      .prepare(`SELECT tasks.*, ${WORKER_PDA_SUBQUERY} FROM tasks WHERE pda = ? LIMIT 1`)
      .get(pda.trim()) as Record<string, unknown> | undefined;
    return row ? parseTaskRowWithWorker(row) : null;
  }

  getTaskByIdHex(idHex: string): TaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ? LIMIT 1')
      .get(idHex) as Record<string, unknown> | undefined;
    return row ? parseTaskRow(row) : null;
  }

  getAgent(pda: string): AgentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE pda = ? LIMIT 1')
      .get(pda.trim()) as Record<string, unknown> | undefined;
    return row ? parseAgentRow(row) : null;
  }

  listAgents(params: { page?: number; pageSize?: number; authority?: string | null }): {
    items: AgentRecord[];
    page: number;
    pageSize: number;
    total: number;
  } {
    const page = clamp(params.page, 1, 100_000, 1);
    const pageSize = clamp(params.pageSize, 1, 100, 24);
    const where = params.authority ? 'WHERE authority = ?' : '';
    const args: SqlValue[] = params.authority ? [params.authority] : [];
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM agents ${where}`)
      .get(...args) as { count: number };
    const rows = this.db.prepare(`
      SELECT * FROM agents
      ${where}
      ORDER BY reputation DESC, tasks_completed DESC, last_active DESC
      LIMIT ? OFFSET ?
    `).all(...args, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

    return {
      items: rows.map(parseAgentRow),
      page,
      pageSize,
      total: totalRow.count,
    };
  }

  // -- stats ------------------------------------------------------------------

  /**
   * Protocol stats over the indexed read model. SOL sums only count tasks with
   * no SPL reward mint (lamport-denominated escrow). Returns lamports as bigint
   * so the HTTP edge can serialize decimal strings.
   */
  buildStats(nowUnix: number): {
    tasksSettled: number;
    lamportsPaidOut: bigint;
    registeredAgents: number;
    escrowLockedLamports: bigint;
    activeClaims: number;
    avgSettleSeconds: number;
    lastSettlementSecondsAgo: number | null;
  } {
    const settledRows = this.db.prepare(`
      SELECT reward_raw, reward_mint, created_at, completed_at FROM tasks WHERE status = 'Completed'
    `).all() as Array<{ reward_raw: string; reward_mint: string | null; created_at: number; completed_at: number }>;

    let lamportsPaidOut = 0n;
    const settleDeltas: number[] = [];
    let lastSettledAt = 0;
    for (const row of settledRows) {
      if (!row.reward_mint) {
        lamportsPaidOut += BigInt(row.reward_raw);
      }
      if (row.completed_at > row.created_at && row.created_at > 0) {
        settleDeltas.push(row.completed_at - row.created_at);
      }
      if (row.completed_at > lastSettledAt) {
        lastSettledAt = row.completed_at;
      }
    }

    // Every non-terminal status holds escrow: Disputed and Reject Frozen
    // tasks are exactly the ones whose escrow is still locked pending exits.
    const escrowRows = this.db.prepare(`
      SELECT reward_raw FROM tasks
      WHERE status IN ('Open', 'In Progress', 'Pending Validation', 'Disputed', 'Reject Frozen')
        AND reward_mint IS NULL
    `).all() as Array<{ reward_raw: string }>;
    let escrowLockedLamports = 0n;
    for (const row of escrowRows) {
      escrowLockedLamports += BigInt(row.reward_raw);
    }

    const registeredAgents = (this.db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number })
      .count;

    const activeClaims = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM claims
      WHERE completed_at = 0
        AND task_pda IN (
          SELECT pda FROM tasks
          WHERE status IN ('In Progress', 'Pending Validation', 'Reject Frozen')
        )
    `).get() as { count: number }).count;

    settleDeltas.sort((left, right) => left - right);
    const avgSettleSeconds = settleDeltas.length
      ? settleDeltas[Math.floor(settleDeltas.length / 2)]
      : 0;

    return {
      tasksSettled: settledRows.length,
      lamportsPaidOut,
      registeredAgents,
      escrowLockedLamports,
      activeClaims,
      avgSettleSeconds,
      lastSettlementSecondsAgo: lastSettledAt > 0 ? Math.max(0, nowUnix - lastSettledAt) : null,
    };
  }

  // -- internals ----------------------------------------------------------------

  private removeMissing(table: string, keyColumn: string, keys: string[]): void {
    if (!keys.length) {
      this.db.prepare(`DELETE FROM ${table}`).run();
      return;
    }
    const placeholders = keys.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM ${table} WHERE ${keyColumn} NOT IN (${placeholders})`).run(...keys);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        pda TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        task_type TEXT NOT NULL,
        description TEXT NOT NULL,
        reward_raw TEXT NOT NULL,
        reward_mint TEXT,
        creator TEXT NOT NULL,
        current_workers INTEGER NOT NULL,
        max_workers INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0,
        private_task INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        required_capabilities TEXT NOT NULL DEFAULT '0',
        min_reputation INTEGER NOT NULL DEFAULT 0,
        moderation_status INTEGER,
        moderation_risk_score INTEGER,
        moderation_recorded_at INTEGER,
        job_spec_uri TEXT,
        job_spec_hash_hex TEXT,
        validation_mode_key TEXT,
        submission_status_key TEXT,
        submission_count INTEGER NOT NULL DEFAULT 0,
        submission_proof_hash_hex TEXT,
        submitted_at INTEGER NOT NULL DEFAULT 0,
        accepted_at INTEGER NOT NULL DEFAULT 0,
        rejected_at INTEGER NOT NULL DEFAULT 0,
        protocol_fee_bps INTEGER NOT NULL DEFAULT 0,
        operator TEXT,
        operator_fee_bps INTEGER NOT NULL DEFAULT 0,
        referrer TEXT,
        referrer_fee_bps INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator);
      CREATE INDEX IF NOT EXISTS idx_tasks_id ON tasks(id);

      CREATE TABLE IF NOT EXISTS agents (
        pda TEXT PRIMARY KEY,
        authority TEXT NOT NULL,
        status TEXT NOT NULL,
        reputation INTEGER NOT NULL,
        tasks_completed INTEGER NOT NULL,
        active_tasks INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '0',
        stake TEXT NOT NULL DEFAULT '0'
      );

      CREATE INDEX IF NOT EXISTS idx_agents_authority ON agents(authority);
      CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation DESC);

      CREATE TABLE IF NOT EXISTS claims (
        claim_pda TEXT PRIMARY KEY,
        task_pda TEXT NOT NULL,
        worker_pda TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_claims_task ON claims(task_pda);

      CREATE TABLE IF NOT EXISTS listings (
        pda TEXT PRIMARY KEY,
        account_data_b64 TEXT NOT NULL,
        metadata_valid INTEGER NOT NULL DEFAULT 0,
        metadata_issues TEXT NOT NULL DEFAULT '[]',
        last_slot INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS hire_records (
        pda TEXT PRIMARY KEY,
        account_data_b64 TEXT NOT NULL,
        listing TEXT NOT NULL,
        task TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hire_records_listing ON hire_records(listing);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_pda TEXT,
        agent_pda TEXT,
        lamports TEXT,
        risk_score INTEGER,
        artifact_sha256 TEXT,
        timestamp_unix INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp_unix DESC);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
    `);

    // Additive migrations for databases created before these columns existed.
    // Values are backfilled naturally by the next snapshot sync (full upsert).
    this.ensureColumn('tasks', 'required_capabilities', "TEXT NOT NULL DEFAULT '0'");
    this.ensureColumn('tasks', 'min_reputation', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('agents', 'capabilities', "TEXT NOT NULL DEFAULT '0'");
    this.ensureColumn('agents', 'stake', "TEXT NOT NULL DEFAULT '0'");
    // 2026-06-11 full-surface upgrade: Task grew operator/referrer legs and
    // the creation-locked protocol fee (466-byte layout).
    this.ensureColumn('tasks', 'protocol_fee_bps', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'operator', 'TEXT');
    this.ensureColumn('tasks', 'operator_fee_bps', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'referrer', 'TEXT');
    this.ensureColumn('tasks', 'referrer_fee_bps', 'INTEGER NOT NULL DEFAULT 0');
  }

  /** ALTER TABLE ... ADD COLUMN when an existing database predates a column. */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
