import { getHireRecordDecoder, getServiceListingDecoder } from '@tetsuo-ai/marketplace-sdk';
import { decodeOnChainText } from './text.js';

/**
 * The four SDK-documented explorer endpoints' projection layer
 * (`@tetsuo-ai/marketplace-sdk` `createIndexerClient`):
 *
 *   GET /api/explorer/listings                      → IndexerListingsPage
 *   GET /api/explorer/listings/:pda                 → { listing }
 *   GET /api/explorer/listings/:pda/hires           → { items }
 *   GET /api/explorer/agents/:pda/track-record      → IndexerAgentTrackRecord
 *
 * Kept in byte-convention parity with api.agenc.ag
 * (`apps/web/lib/server/explorer-read.ts`): the load-bearing field is
 * `accountData` — base64 of the REAL on-chain bytes, which clients decode
 * themselves for byte-true parity with gPA. The `decoded` projection is a
 * display convenience.
 *
 * Best-effort caveats (documented, never fabricated): hire `slot`/`signature`
 * are 0/"" until event indexing lands; the WP-H3 `guaranteed` field is
 * omitted entirely (this service does not run the completion-bond sweep, and
 * per the contract absence means UNKNOWN, never "not guaranteed").
 */

/* ------------------------------ wire shapes ------------------------------ */

export interface ExplorerListingDecoded {
  provider: string;
  authority: string;
  name: string;
  category: string;
  tags: string[];
  specHash: string;
  specUri: string;
  price: string;
  priceMint: string | null;
  state: number;
  maxOpenJobs: number;
  openJobs: number;
  totalHires: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExplorerListing {
  pda: string;
  /** Base64 of the FULL raw on-chain account bytes (byte-true). */
  accountData: string;
  decoded: ExplorerListingDecoded;
  metadataValid: boolean;
  metadataIssues: string[];
  lastSlot: number;
  lastSignature: string;
}

export interface ExplorerListingsQuery {
  category?: string | null;
  /** CSV; a listing matches when it carries EVERY requested tag. */
  tags?: string | null;
  provider?: string | null;
  /** Numeric enum value or PascalCase variant name. */
  state?: string | null;
  /** Default true — the hosted read model serves conforming listings only. */
  metadataValid?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ExplorerHire {
  taskPda: string;
  hireRecordPda: string;
  /** Base64 of the raw HireRecord account bytes. */
  accountData: string;
  buyer: string;
  listing: string;
  price: string;
  /** 0 until event indexing lands (documented best-effort). */
  slot: number;
  /** "" until event indexing lands (documented best-effort). */
  signature: string;
}

/* ---------------------------- read-model rows ---------------------------- */

/** SQLite listing row: raw bytes + metadata verdict, decoded at the edge. */
export type ListingRow = {
  pda: string;
  accountDataB64: string;
  metadataValid: boolean;
  metadataIssues: string[];
  lastSlot: number;
};

export type HireRecordRow = {
  pda: string;
  accountDataB64: string;
  listing: string;
  task: string;
};

/* ------------------------------- decoding -------------------------------- */

const LISTING_STATE_NAMES = ['Active', 'Paused', 'Retired'] as const;

function bytesToHex(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function nulTrim(bytes: Uint8Array | readonly number[]): string {
  return decodeOnChainText(Uint8Array.from(Array.from(bytes))) ?? '';
}

type KitOption<T> = { __option: 'Some'; value: T } | { __option: 'None' };

function optionValue<T>(option: KitOption<T> | null | undefined): T | null {
  return option && option.__option === 'Some' ? option.value : null;
}

/** Decode one raw listing row into the wire projection (fail-soft → null). */
export function decodeExplorerListing(row: ListingRow): ExplorerListing | null {
  try {
    const raw = Uint8Array.from(Buffer.from(row.accountDataB64, 'base64'));
    const l = getServiceListingDecoder().decode(raw);
    const tags = nulTrim(l.tags as unknown as Uint8Array)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      pda: row.pda,
      accountData: row.accountDataB64,
      decoded: {
        provider: String(l.providerAgent),
        authority: String(l.authority),
        name: nulTrim(l.name as unknown as Uint8Array),
        category: nulTrim(l.category as unknown as Uint8Array),
        tags,
        specHash: bytesToHex(l.specHash as unknown as Uint8Array),
        specUri: l.specUri || '',
        price: l.price.toString(),
        priceMint: optionValue(l.priceMint as unknown as KitOption<string>),
        state: l.state as unknown as number,
        maxOpenJobs: l.maxOpenJobs,
        openJobs: l.openJobs,
        totalHires: l.totalHires.toString(),
        version: l.version.toString(),
        createdAt: l.createdAt.toString(),
        updatedAt: l.updatedAt.toString(),
      },
      metadataValid: row.metadataValid,
      metadataIssues: row.metadataIssues,
      lastSlot: row.lastSlot,
      lastSignature: '',
    };
  } catch {
    return null; // fail-soft: one undecodable account never kills the page
  }
}

/** Extract the (listing, task) join keys from raw HireRecord bytes. */
export function decodeHireRecordKeys(
  accountDataB64: string,
): { listing: string; task: string } | null {
  try {
    const raw = Uint8Array.from(Buffer.from(accountDataB64, 'base64'));
    const hire = getHireRecordDecoder().decode(raw);
    return { listing: String(hire.listing), task: String(hire.task) };
  } catch {
    return null;
  }
}

/* ------------------------------- querying -------------------------------- */

/** Apply the documented query filters + paging (parity with api.agenc.ag). */
export function filterAndPage(
  listings: ExplorerListing[],
  query: ExplorerListingsQuery,
): { page: number; pageSize: number; total: number; items: ExplorerListing[] } {
  const wantValid = query.metadataValid ?? true;
  let items = listings.filter((l) => l.metadataValid === wantValid);
  if (query.category) {
    items = items.filter((l) => l.decoded.category === query.category);
  }
  if (query.tags) {
    const wanted = query.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    items = items.filter((l) => wanted.every((t) => l.decoded.tags.includes(t)));
  }
  if (query.provider) {
    items = items.filter((l) => l.decoded.provider === query.provider);
  }
  if (query.state !== undefined && query.state !== null && query.state !== '') {
    const asNumber = Number(query.state);
    const stateNum = Number.isInteger(asNumber)
      ? asNumber
      : LISTING_STATE_NAMES.indexOf(query.state as (typeof LISTING_STATE_NAMES)[number]);
    items = items.filter((l) => l.decoded.state === stateNum);
  }
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
  const total = items.length;
  return {
    page,
    pageSize,
    total,
    items: items.slice((page - 1) * pageSize, page * pageSize),
  };
}

/** Join a listing's HireRecords to their minted tasks for buyer + price. */
export function explorerListingHires(
  hireRows: HireRecordRow[],
  listingPda: string,
  taskLookup: (taskPda: string) => { creator: string; rewardRaw: string } | null,
): ExplorerHire[] {
  const out: ExplorerHire[] = [];
  for (const row of hireRows) {
    if (row.listing !== listingPda) continue;
    const task = taskLookup(row.task);
    out.push({
      taskPda: row.task,
      hireRecordPda: row.pda,
      accountData: row.accountDataB64,
      buyer: task?.creator ?? '',
      listing: listingPda,
      price: task?.rewardRaw ?? '0',
      slot: 0,
      signature: '',
    });
  }
  return out;
}
