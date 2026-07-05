/**
 * LISTING_METADATA v1 conformance tests for the decoupled resolver: the
 * canonical-hash gate, required fields, taxonomy rules, and the cache's
 * permanent-vs-TTL behavior. The fetcher is injected — no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { values } from '@tetsuo-ai/marketplace-sdk';
import {
  ListingMetadataResolver,
  resolveListingSpecMetadata,
} from '../listing-metadata.js';

const CATEGORY = values.LISTING_CATEGORIES[0];

function conformingPayload(): Record<string, unknown> {
  return {
    title: 'Fixture research service',
    description: 'Summarizes one technical blog post into a structured brief.',
    category: CATEGORY,
    tags: ['research', 'summaries'],
    custom: {
      listingMetadata: {
        displayName: 'Fixture research service',
        longDescription: 'Summarizes one technical blog post into a structured brief.',
      },
    },
  };
}

async function bodyFor(payload: Record<string, unknown>): Promise<{
  text: string;
  rawSha256Hex: string;
  hashHex: string;
}> {
  const canonical = await values.canonicalJobSpecHash(payload);
  return { text: JSON.stringify(payload), rawSha256Hex: 'ff'.repeat(32), hashHex: canonical.hex };
}

test('verified when the canonical hash matches and metadata conforms', async () => {
  const payload = conformingPayload();
  const body = await bodyFor(payload);
  const result = await resolveListingSpecMetadata({
    specUri: 'https://example.com/spec.json',
    specHash: body.hashHex,
    fetchSpec: async () => body,
  });
  assert.deepEqual(result, { state: 'verified', error: null });
});

test('hash_mismatch when the payload does not hash to the pinned value', async () => {
  const body = await bodyFor(conformingPayload());
  const result = await resolveListingSpecMetadata({
    specUri: 'https://example.com/spec.json',
    specHash: '00'.repeat(32),
    fetchSpec: async () => body,
  });
  assert.equal(result.state, 'hash_mismatch');
});

test('invalid_metadata on a non-canonical category', async () => {
  const payload = { ...conformingPayload(), category: 'definitely-not-canonical' };
  const body = await bodyFor(payload);
  const result = await resolveListingSpecMetadata({
    specUri: 'https://example.com/spec.json',
    specHash: body.hashHex,
    fetchSpec: async () => body,
  });
  assert.equal(result.state, 'invalid_metadata');
});

test('missing / malformed short-circuit before any fetch', async () => {
  const neverFetch = async () => {
    throw new Error('must not fetch');
  };
  assert.equal(
    (await resolveListingSpecMetadata({ specUri: null, specHash: null, fetchSpec: neverFetch }))
      .state,
    'missing',
  );
  assert.equal(
    (
      await resolveListingSpecMetadata({
        specUri: 'https://example.com/spec.json',
        specHash: 'not-hex',
        fetchSpec: neverFetch,
      })
    ).state,
    'malformed',
  );
});

test('resolver caches hash-pinned verdicts permanently, retries unreachable', async () => {
  const payload = conformingPayload();
  const body = await bodyFor(payload);
  let calls = 0;
  let fail = true;
  const resolver = new ListingMetadataResolver(async () => {
    calls += 1;
    if (fail) throw new Error('down');
    return body;
  });

  // Unreachable is a TTL-cached failure: same key does not refetch within TTL.
  const first = await resolver.resolve('https://example.com/spec.json', body.hashHex);
  assert.equal(first.state, 'unreachable');
  await resolver.resolve('https://example.com/spec.json', body.hashHex);
  assert.equal(calls, 1);

  // A different key resolves independently; verified is cached forever.
  fail = false;
  const otherKey = await resolver.resolve('https://example.com/other.json', body.hashHex);
  assert.equal(otherKey.state, 'verified');
  await resolver.resolve('https://example.com/other.json', body.hashHex);
  assert.equal(calls, 2);
});
