import { values } from '@tetsuo-ai/marketplace-sdk';
import { fetchSpecBody } from './jobspec.js';
import { cleanDisplayText, isLegibleText } from './text.js';

/**
 * Listing spec-metadata resolution — the LISTING_METADATA v1 conformance
 * check behind the `metadataValid` field on /api/explorer/listings.
 *
 * Ported from agenc.ag's `apps/web/lib/server/spec-metadata.ts`, minus the
 * site's editorial content policy (see docs/API.md "What differs from
 * api.agenc.ag"): here `metadataValid` means exactly
 *
 *   1. the pinned spec URI is reachable (SSRF-guarded https fetch),
 *   2. the payload's canonical job-spec hash matches the on-chain spec hash
 *      (`values.canonicalJobSpecHash` — hash-true, no raw-byte fallback for
 *      listings), and
 *   3. the payload conforms to LISTING_METADATA v1 (displayName,
 *      longDescription, canonical category, kebab-case tags).
 *
 * Verified results are cached forever per (uri, hash) — the hash pins the
 * content, so a match can never go stale. Failures are cached with a TTL so
 * a flaky host is retried without hammering it on every snapshot poll.
 */

export type SpecMetadataState =
  | 'verified'
  | 'missing'
  | 'unreachable'
  | 'hash_mismatch'
  | 'malformed'
  | 'invalid_metadata';

export type ListingSpecMetadata = {
  state: SpecMetadataState;
  error: string | null;
};

export type SpecFetchBody = { text: string; rawSha256Hex: string };
type SpecFetcher = (uri: string) => Promise<SpecFetchBody>;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const LISTING_NAME_MAX = 120;
const LISTING_DESCRIPTION_MAX = 2_000;
const LISTING_TAG_MAX = 40;
const LIST_MAX_ITEMS = 8;
const FAILURE_CACHE_TTL_MS = 10 * 60 * 1000;
const LISTING_CATEGORY_SET = new Set<string>(values.LISTING_CATEGORIES);
const LISTING_TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromDocument(document: Record<string, unknown>): Record<string, unknown> {
  return isRecord(document.payload) ? document.payload : document;
}

function objectField(value: unknown, ...names: readonly string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const name of names) {
    if (value[name] !== undefined) return value[name];
  }
  return undefined;
}

function textField(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = cleanDisplayText(value);
  if (!cleaned || cleaned.length > maxLength || !isLegibleText(cleaned)) {
    return null;
  }
  return cleaned;
}

function stringList(value: unknown, maxItemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const cleaned = textField(item, maxItemLength);
    if (cleaned) out.push(cleaned);
    if (out.length >= LIST_MAX_ITEMS) break;
  }
  return out;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function defaultFetchSpec(uri: string): Promise<SpecFetchBody> {
  const body = await fetchSpecBody(uri);
  return { text: body.text, rawSha256Hex: body.sha256 };
}

/**
 * Resolve one listing's spec metadata state. Pure of any site policy; see
 * module doc for the exact semantics of `verified`.
 */
export async function resolveListingSpecMetadata(params: {
  specUri: string | null;
  specHash: string | null;
  fetchSpec?: SpecFetcher;
}): Promise<ListingSpecMetadata> {
  if (!params.specUri || !params.specHash) {
    return { state: 'missing', error: 'No spec URI or hash is pinned.' };
  }
  if (!HEX64_RE.test(params.specHash)) {
    return { state: 'malformed', error: 'Pinned spec hash is not a 32-byte hex digest.' };
  }

  let body: SpecFetchBody;
  try {
    body = await (params.fetchSpec ?? defaultFetchSpec)(params.specUri);
  } catch (error) {
    return {
      state: 'unreachable',
      error: error instanceof Error ? error.message : 'Spec fetch failed.',
    };
  }

  const document = parseJsonObject(body.text);
  if (!document) {
    return { state: 'malformed', error: 'Spec body is not a JSON object.' };
  }

  const payload = payloadFromDocument(document);
  const expected = params.specHash.toLowerCase();
  let hashOk = false;
  try {
    const canonical = await values.canonicalJobSpecHash(payload);
    hashOk = canonical.hex.toLowerCase() === expected;
  } catch {
    hashOk = false;
  }
  if (!hashOk) {
    return {
      state: 'hash_mismatch',
      error: 'Hosted spec does not hash to the on-chain spec hash.',
    };
  }

  const custom = objectField(payload, 'custom');
  const listingMetadata = objectField(custom, 'listingMetadata', 'listing_metadata');
  const metadata = isRecord(listingMetadata) ? listingMetadata : {};
  const displayName =
    textField(objectField(metadata, 'displayName', 'display_name', 'name'), LISTING_NAME_MAX) ??
    textField(objectField(payload, 'title', 'name'), LISTING_NAME_MAX);
  const longDescription =
    textField(
      objectField(metadata, 'longDescription', 'long_description', 'description'),
      LISTING_DESCRIPTION_MAX,
    ) ??
    textField(
      objectField(payload, 'description', 'shortDescription', 'summary'),
      LISTING_DESCRIPTION_MAX,
    );
  const category = textField(objectField(payload, 'category'), 64);
  const tags = stringList(objectField(payload, 'tags'), LISTING_TAG_MAX);

  const invalidTaxonomy =
    !category ||
    !LISTING_CATEGORY_SET.has(category) ||
    tags.some((tag) => !LISTING_TAG_RE.test(tag));

  if (!displayName || !longDescription || invalidTaxonomy) {
    return {
      state: 'invalid_metadata',
      error:
        !displayName || !longDescription || !category
          ? 'Verified listing spec is missing displayName, longDescription, or category.'
          : 'Verified listing spec uses a non-canonical category or tag.',
    };
  }

  return { state: 'verified', error: null };
}

/* ------------------------------ cache layer ------------------------------ */

type CacheEntry = { result: ListingSpecMetadata; expiresAtMs: number | null };

/**
 * Snapshot-poll-friendly cache over {@link resolveListingSpecMetadata}:
 * `verified`/`hash_mismatch`/`invalid_metadata`/`malformed` are pinned by the
 * content hash and cached forever; `missing`/`unreachable` retry after a TTL.
 */
export class ListingMetadataResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchSpec: SpecFetcher | undefined;

  constructor(fetchSpec?: SpecFetcher) {
    this.fetchSpec = fetchSpec;
  }

  async resolve(specUri: string | null, specHashHex: string | null): Promise<ListingSpecMetadata> {
    const key = `${specUri ?? ''}|${(specHashHex ?? '').toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && (cached.expiresAtMs === null || cached.expiresAtMs > Date.now())) {
      return cached.result;
    }
    const result = await resolveListingSpecMetadata({
      specUri,
      specHash: specHashHex,
      fetchSpec: this.fetchSpec,
    });
    const permanent = result.state !== 'unreachable' && result.state !== 'missing';
    this.cache.set(key, {
      result,
      expiresAtMs: permanent ? null : Date.now() + FAILURE_CACHE_TTL_MS,
    });
    return result;
  }
}
