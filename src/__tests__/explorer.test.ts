/**
 * Explorer projection tests: byte-true ServiceListing decode (encode with the
 * SDK's generated encoder, decode through the read-model row path), the
 * documented list filters + paging, and the hires join.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getServiceListingEncoder, ListingState } from '@tetsuo-ai/marketplace-sdk';
import {
  decodeExplorerListing,
  explorerListingHires,
  filterAndPage,
  type ExplorerListing,
  type HireRecordRow,
} from '../explorer.js';

const PROVIDER = 'ERfXD3W79cSxivUMuJkLTQUip17oRWwbdpXgSGrmHu2';
const AUTHORITY = 'AtPmace7uiCiTGeVuiP2dRsmDRKv1rTLR6zUE5caErBE';

function fixedBytes(text: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode(text).slice(0, size));
  return out;
}

function encodedListingB64(): string {
  const bytes = getServiceListingEncoder().encode({
    providerAgent: PROVIDER as never,
    authority: AUTHORITY as never,
    listingId: new Uint8Array(32),
    name: fixedBytes('Fixture research agent', 32),
    category: fixedBytes('research', 32),
    tags: fixedBytes('research,summaries', 64),
    specHash: Uint8Array.from({ length: 32 }, (_, i) => i),
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

test('decodeExplorerListing round-trips SDK-encoded bytes byte-true', () => {
  const accountDataB64 = encodedListingB64();
  const listing = decodeExplorerListing({
    pda: 'GzdRn2tjuhDNLvg5U1gr1fyJDBVj9iAGJxM14qwkF6jD',
    accountDataB64,
    metadataValid: true,
    metadataIssues: [],
    lastSlot: 123,
  });
  assert.ok(listing);
  // accountData is passed through unmodified — the byte-true contract.
  assert.equal(listing.accountData, accountDataB64);
  assert.equal(listing.decoded.provider, PROVIDER);
  assert.equal(listing.decoded.authority, AUTHORITY);
  assert.equal(listing.decoded.name, 'Fixture research agent');
  assert.equal(listing.decoded.category, 'research');
  assert.deepEqual(listing.decoded.tags, ['research', 'summaries']);
  assert.equal(listing.decoded.specHash, '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  assert.equal(listing.decoded.price, '10000000');
  assert.equal(listing.decoded.priceMint, null);
  assert.equal(listing.decoded.state, 0);
  assert.equal(listing.decoded.totalHires, '7');
  assert.equal(listing.decoded.version, '2');
  assert.equal(listing.lastSlot, 123);
  assert.equal(listing.lastSignature, '');
});

test('decodeExplorerListing fails soft (null) on garbage bytes', () => {
  const listing = decodeExplorerListing({
    pda: 'garbage',
    accountDataB64: Buffer.from([1, 2, 3]).toString('base64'),
    metadataValid: false,
    metadataIssues: [],
    lastSlot: 0,
  });
  assert.equal(listing, null);
});

function listingFixture(overrides: Partial<ExplorerListing> & { pda: string }): ExplorerListing {
  const decoded = {
    provider: PROVIDER,
    authority: AUTHORITY,
    name: 'fixture',
    category: 'research',
    tags: ['research'],
    specHash: 'ab'.repeat(32),
    specUri: 'https://example.com/spec.json',
    price: '1',
    priceMint: null,
    state: 0,
    maxOpenJobs: 1,
    openJobs: 0,
    totalHires: '0',
    version: '1',
    createdAt: '0',
    updatedAt: '0',
  };
  return {
    accountData: '',
    decoded: { ...decoded, ...(overrides.decoded ?? {}) },
    metadataValid: true,
    metadataIssues: [],
    lastSlot: 0,
    lastSignature: '',
    ...overrides,
  };
}

test('filterAndPage defaults to metadataValid=true and honors the filters', () => {
  const listings = [
    listingFixture({ pda: 'A' }),
    listingFixture({ pda: 'B', metadataValid: false }),
    listingFixture({ pda: 'C', decoded: { category: 'coding' } as never }),
  ].map((l) => ({ ...l, decoded: { ...listingFixture({ pda: l.pda }).decoded, ...l.decoded } }));

  const all = filterAndPage(listings, {});
  assert.deepEqual(all.items.map((l) => l.pda), ['A', 'C']);
  assert.equal(all.total, 2);

  const invalidOnly = filterAndPage(listings, { metadataValid: false });
  assert.deepEqual(invalidOnly.items.map((l) => l.pda), ['B']);

  const research = filterAndPage(listings, { category: 'research' });
  assert.deepEqual(research.items.map((l) => l.pda), ['A']);

  const stateByName = filterAndPage(listings, { state: 'Active' });
  assert.equal(stateByName.total, 2);

  const paged = filterAndPage(listings, { page: 2, pageSize: 1 });
  assert.equal(paged.total, 2);
  assert.deepEqual(paged.items.map((l) => l.pda), ['C']);
  // pageSize is clamped to 100.
  assert.equal(filterAndPage(listings, { pageSize: 5000 }).pageSize, 100);
});

test('explorerListingHires joins hire records to minted tasks', () => {
  const rows: HireRecordRow[] = [
    { pda: 'HIRE1', accountDataB64: 'aGlyZTE=', listing: 'LST', task: 'TASK1' },
    { pda: 'HIRE2', accountDataB64: 'aGlyZTI=', listing: 'OTHER', task: 'TASK2' },
    { pda: 'HIRE3', accountDataB64: 'aGlyZTM=', listing: 'LST', task: 'TASK_CLOSED' },
  ];
  const tasks = new Map([
    ['TASK1', { creator: AUTHORITY, rewardRaw: '5000000' }],
  ]);
  const hires = explorerListingHires(rows, 'LST', (pda) => tasks.get(pda) ?? null);
  assert.equal(hires.length, 2);
  assert.deepEqual(hires[0], {
    taskPda: 'TASK1',
    hireRecordPda: 'HIRE1',
    accountData: 'aGlyZTE=',
    buyer: AUTHORITY,
    listing: 'LST',
    price: '5000000',
    slot: 0,
    signature: '',
  });
  // A hire whose minted task account is closed still surfaces (best-effort
  // empty buyer / zero price), matching the api.agenc.ag behavior.
  assert.equal(hires[1].taskPda, 'TASK_CLOSED');
  assert.equal(hires[1].buyer, '');
  assert.equal(hires[1].price, '0');
});
