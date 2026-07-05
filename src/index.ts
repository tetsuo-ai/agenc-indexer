import { isAbsolute, join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { EventMonitor, createLogger, createReadOnlyProgram } from '@tetsuo-ai/runtime';
import { configBootLines, loadConfig, parseIntStrict } from './config.js';
import { SnapshotIndexer } from './indexer.js';
import { IndexerServer } from './server.js';
import { IndexerStore } from './store.js';

/**
 * @tetsuo-ai/agenc-indexer — self-hostable read-model indexer for the AgenC
 * marketplace protocol.
 *
 * gPA snapshot polling -> SQLite read model -> versioned REST + SSE,
 * including the four SDK-documented explorer endpoints. Extracted from
 * agenc.ag's `services/indexer` (itself adapted from agenc-public-explorer).
 * Mainnet-safe env defaults; RPC throttling triggers exponential poll backoff
 * and the service keeps serving the last good snapshot instead of
 * crash-looping.
 */

const logger = createLogger('info', '[agenc-indexer]');

// Public RPC hiccups (websocket drops, slow gPA) must never kill the process.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection (continuing): ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception (continuing): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});

const config = loadConfig();
for (const line of configBootLines(config)) {
  logger.info(line);
}

const PORT = parseIntStrict(config.port.value, 8787);
const BASE_INTERVAL_MS = parseIntStrict(config.snapshotIntervalMs.value, 45_000);
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const EVENT_STORE_LIMIT = parseIntStrict(config.eventStoreLimit.value, 2000);
const DB_PATH = isAbsolute(config.dbPath.value) ? config.dbPath.value : join(process.cwd(), config.dbPath.value);

const connection = new Connection(config.rpcUrl.value, 'confirmed');
const programId = new PublicKey(config.programId.value);
// Mainnet runs the FULL 84-instruction surface since the 2026-06-11 upgrade
// (Task accounts are 466 bytes). Task accounts are decoded with the
// marketplace SDK's generated client (see SnapshotIndexer.fetchTaskAccounts);
// this legacy read-only program is kept ONLY for what is still
// layout-identical: AgentRegistration/TaskClaim decoding, the gPA
// discriminator filters, and the EventMonitor log subscriptions below.
const program = createReadOnlyProgram(connection, programId);
const store = new IndexerStore(DB_PATH);

let lastError: string | null = null;
let lastSlot = 0;
let refreshTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<void> | null = null;
let currentBackoffMs = BASE_INTERVAL_MS;
let shuttingDown = false;

const indexer = new SnapshotIndexer({
  connection,
  program,
  store,
  logger,
  eventStoreLimit: EVENT_STORE_LIMIT,
  disableListingMetadata:
    config.disableListingMetadata.value === 'true' || config.disableListingMetadata.value === '1',
});

const server = new IndexerServer({
  store,
  health: {
    rpcUrl: config.rpcUrl.value,
    programId: programId.toBase58(),
    programIdSource: config.programId.source,
    dbPath: DB_PATH,
    lastError: () => lastError,
    lastSlot: () => lastSlot,
  },
  logger,
});

function isThrottleError(message: string): boolean {
  return /429|too many requests|rate limit/i.test(message);
}

async function refreshSnapshot(reason: string): Promise<void> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = indexer
    .buildSnapshot()
    .then((result) => {
      lastError = null;
      lastSlot = result.slot;
      currentBackoffMs = BASE_INTERVAL_MS;
      logger.info(
        `Snapshot refreshed (${reason}): slot=${result.slot} tasks=${result.taskCount} agents=${result.agentCount} claims=${result.claimCount} listings=${result.listingCount} hires=${result.hireRecordCount} newEvents=${result.newEvents.length}`,
      );
      for (const event of result.newEvents) {
        const { id: _id, ...view } = event;
        server.broadcast(view);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (isThrottleError(message)) {
        currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
        logger.warn(`RPC throttled (${reason}): ${message} — backing off to ${Math.round(currentBackoffMs / 1000)}s`);
      } else {
        currentBackoffMs = Math.min(Math.max(currentBackoffMs * 2, BASE_INTERVAL_MS), MAX_BACKOFF_MS);
        logger.error(`Snapshot refresh failed (${reason}): ${message}`);
      }
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function schedulePoll(): void {
  if (shuttingDown) {
    return;
  }
  pollTimer = setTimeout(() => {
    void refreshSnapshot('poll').finally(schedulePoll);
  }, currentBackoffMs);
}

/** Debounced refresh used by live event subscriptions. */
function queueRefresh(reason: string): void {
  if (refreshTimer || shuttingDown) {
    return;
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSnapshot(reason);
  }, 500);
}

/**
 * EventMonitor (anchor log subscriptions over the RPC websocket) is used as a
 * low-latency refresh trigger only — the snapshot diff is the canonical feed
 * event source, so a dead websocket degrades latency, never correctness.
 */
function registerEventSubscriptions(): EventMonitor | null {
  if (config.disableEventMonitor.value === 'true' || config.disableEventMonitor.value === '1') {
    logger.info('EventMonitor disabled via DISABLE_EVENT_MONITOR');
    return null;
  }
  try {
    const monitor = new EventMonitor({ program, logger });
    monitor.subscribeToTaskEvents({
      onTaskCreated: () => queueRefresh('event:task_created'),
      onTaskClaimed: () => queueRefresh('event:task_claimed'),
      onTaskCompleted: () => queueRefresh('event:task_completed'),
      onTaskCancelled: () => queueRefresh('event:task_cancelled'),
    });
    monitor.subscribeToDisputeEvents({
      onDisputeInitiated: () => queueRefresh('event:dispute_initiated'),
      onDisputeResolved: () => queueRefresh('event:dispute_resolved'),
    });
    monitor.subscribeToProtocolEvents({
      onRewardDistributed: () => queueRefresh('event:reward_distributed'),
    });
    monitor.subscribeToAgentEvents({
      onRegistered: () => queueRefresh('event:agent_registered'),
      onUpdated: () => queueRefresh('event:agent_updated'),
      onDeregistered: () => queueRefresh('event:agent_deregistered'),
    });
    monitor.start();
    logger.info('EventMonitor live (websocket refresh triggers)');
    return monitor;
  } catch (error) {
    logger.warn(
      `EventMonitor unavailable, falling back to polling only: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function main(): Promise<void> {
  logger.info(`Connecting to ${config.rpcUrl.value}`);
  logger.info(`Watching program ${programId.toBase58()} (${config.programId.source})`);
  logger.info(`SQLite read model at ${DB_PATH}`);

  const monitor = registerEventSubscriptions();

  server.listen(PORT, config.host.value, () => {
    logger.info(`Indexer listening on http://${config.host.value}:${PORT}`);
  });

  await refreshSnapshot('startup');
  schedulePoll();

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Shutting down indexer');
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    server.close();
    if (monitor) {
      await monitor.stop().catch(() => undefined);
    }
    store.close();
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void main().catch((error) => {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
