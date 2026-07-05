import { join } from 'node:path';

/**
 * Strict env-driven configuration with mainnet-safe defaults.
 * Every value records whether it came from the environment or a default so
 * the boot log can show exactly what the process is running against.
 */

export type ConfigSource = 'env' | 'default';

export type ConfigValue = {
  value: string;
  source: ConfigSource;
};

export type IndexerConfig = {
  rpcUrl: ConfigValue;
  programId: ConfigValue;
  dbPath: ConfigValue;
  port: ConfigValue;
  host: ConfigValue;
  snapshotIntervalMs: ConfigValue;
  eventStoreLimit: ConfigValue;
  disableEventMonitor: ConfigValue;
  disableListingMetadata: ConfigValue;
  trustedModerators: ConfigValue;
};

const DEFAULTS = {
  SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
  AGENC_PROGRAM_ID: 'HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK',
  EXPLORER_DB_PATH: join('.agenc-indexer-data', 'explorer.sqlite'),
  PORT: '8787',
  HOST: '127.0.0.1',
  SNAPSHOT_INTERVAL_MS: '45000',
  EVENT_STORE_LIMIT: '2000',
  DISABLE_EVENT_MONITOR: 'false',
  DISABLE_LISTING_METADATA: 'false',
  TRUSTED_MODERATORS: '',
} as const;

function resolve(key: keyof typeof DEFAULTS): ConfigValue {
  const raw = process.env[key];
  if (raw !== undefined && raw.trim() !== '') {
    return { value: raw.trim(), source: 'env' };
  }
  return { value: DEFAULTS[key], source: 'default' };
}

export function loadConfig(): IndexerConfig {
  return {
    rpcUrl: resolve('SOLANA_RPC_URL'),
    programId: resolve('AGENC_PROGRAM_ID'),
    dbPath: resolve('EXPLORER_DB_PATH'),
    port: resolve('PORT'),
    host: resolve('HOST'),
    snapshotIntervalMs: resolve('SNAPSHOT_INTERVAL_MS'),
    eventStoreLimit: resolve('EVENT_STORE_LIMIT'),
    disableEventMonitor: resolve('DISABLE_EVENT_MONITOR'),
    disableListingMetadata: resolve('DISABLE_LISTING_METADATA'),
    trustedModerators: resolve('TRUSTED_MODERATORS'),
  };
}

export function configBootLines(config: IndexerConfig): string[] {
  const entries: Array<[string, ConfigValue]> = [
    ['SOLANA_RPC_URL', config.rpcUrl],
    ['AGENC_PROGRAM_ID', config.programId],
    ['EXPLORER_DB_PATH', config.dbPath],
    ['PORT', config.port],
    ['HOST', config.host],
    ['SNAPSHOT_INTERVAL_MS', config.snapshotIntervalMs],
    ['EVENT_STORE_LIMIT', config.eventStoreLimit],
    ['DISABLE_EVENT_MONITOR', config.disableEventMonitor],
    ['DISABLE_LISTING_METADATA', config.disableListingMetadata],
    ['TRUSTED_MODERATORS', config.trustedModerators],
  ];
  return entries.map(([key, entry]) => `config ${key}=${entry.value} (${entry.source})`);
}

export function parseIntStrict(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
