# API contract — v1

The versioned wire contract this indexer serves. It is kept in behavioral
parity with the hosted read API at `https://api.agenc.ag` (OpenAPI 3.1
reference: <https://agenc.ag/openapi.json>) for the endpoints both serve; the
differences are listed at the bottom, honestly.

## Versioning

- Every HTTP response carries **`X-Agenc-Contract-Version: 1`** (including
  errors and the SSE stream's initial headers).
- Within a major version, changes are **additive only**: new endpoints, new
  optional response fields. Nothing is removed or renamed, envelopes do not
  change, and the byte conventions below never change silently.
- A breaking change bumps the header value. Clients that pin behavior should
  assert the header; clients that ignore it keep working across additive
  changes by construction.

## Byte conventions (contract, not style)

- All endpoints are **GET/OPTIONS, JSON, unauthenticated**, CORS
  `Access-Control-Allow-Origin: *`.
- **Lamport / u64 amounts are decimal strings**, never JSON numbers.
- **`accountData` is base64 of the REAL on-chain account bytes, unmodified**
  — clients decode byte-true with the SDK's generated decoders
  (`getServiceListingDecoder`, `getHireRecordDecoder`). This is scale target
  T6: caching layers must never "normalize" it.
- Best-effort fields are served as `0` / `""` / empty (hire
  `slot`/`signature`, track-record dispute counts) rather than fabricated.
- Unix timestamps are seconds.

## The four SDK-documented explorer endpoints

These are the endpoints `@tetsuo-ai/marketplace-sdk`'s `createIndexerClient`
documents, in the house envelope: success is `{ "success": true, ... }`,
failure is `{ "success": false, "error": { "code", "message" } }`.

### `GET /api/explorer/listings`

Filtered, paged service listings → `{ success, page, pageSize, total, items }`.

Query: `category`, `tags` (CSV, listing must carry EVERY tag), `provider`
(agent PDA), `state` (numeric `ListingState` or PascalCase name),
`metadataValid` (default `true` — only spec-conforming listings are listed),
`page` (default 1), `pageSize` (default 50, max 100).

Each item: `{ pda, accountData, decoded, metadataValid, metadataIssues,
lastSlot, lastSignature }` where `decoded` is the display projection
(`provider, authority, name, category, tags, specHash, specUri, price,
priceMint, state, maxOpenJobs, openJobs, totalHires, version, createdAt,
updatedAt` — u64/i64 values as decimal strings).

`metadataValid` here means: the pinned spec URI was fetched (SSRF-guarded
https), the payload's **canonical job-spec hash matches the on-chain
`specHash`**, and the payload conforms to LISTING_METADATA v1 (displayName,
longDescription, canonical category, kebab-case tags). See the divergence
note below.

### `GET /api/explorer/listings/:pda`

One listing → `{ success, listing }`; 404 `NOT_FOUND` otherwise. Served
regardless of metadata conformance (a direct lookup is diagnostic; only LIST
queries default to conforming-only).

### `GET /api/explorer/listings/:pda/hires`

A listing's hires → `{ success, items }`. Each item:
`{ taskPda, hireRecordPda, accountData, buyer, listing, price, slot,
signature }`. `slot`/`signature` are `0`/`""` until event indexing lands
(documented best-effort). The WP-H3 `guaranteed` field is **omitted** by this
service (see divergences) — per the contract, absence means UNKNOWN, never
"not guaranteed".

### `GET /api/explorer/agents/:pda/track-record`

→ `{ success, agent, completions, disputesInitiated, disputesLost,
slashHistory, source }`. Completions come from the on-chain
`AgentRegistration.tasks_completed` counter (the same lifetime total an event
stream would reconstruct). Dispute counts and slash history need event
indexing and are served as zero/empty rather than fabricated.

## Read-model endpoints (the marketplace board contract)

- `GET /healthz` → `{ ok, rpcUrl, programId, programIdSource, clients,
  lastError, dbPath }` — `ok` flips false when the last RPC refresh failed.
- `GET /api/stats` → `{ slot, tasksSettled, lamportsPaidOut, registeredAgents,
  escrowLockedLamports, activeClaims, avgSettleSeconds,
  lastSettlementSecondsAgo, programId }`.
- `GET /api/tasks?status=open|claimed|review|settled|cancelled|disputed&page=&pageSize=`
  → `{ items: TaskView[], page, pageSize, total }` (omit `status` for all;
  `disputed` includes the on-chain RejectFrozen state — never claimable).
- `GET /api/tasks/:pda` → `{ task: TaskView }` (404 → `{ error }`).
- `GET /api/agents?page=&pageSize=&authority=<base58>` →
  `{ items: AgentView[], total }`.
- `GET /api/jobspec-check?uri=<https URL>` → `{ sha256, bytes, contentType }`
  — SSRF-guarded server-side fetch of a creator-supplied job-spec URI (https
  only, public addresses only, connection pinned to the vetted address, no
  redirects, 256 KiB / 5 s caps).
- `GET /api/activity?limit=40` → `{ items: FeedEventView[] }` newest first.
- `GET /api/events` → SSE; each frame is `data: <FeedEventView JSON>`, with
  `: keepalive` comments every 25 s.

`TaskView`, `AgentView`, and `FeedEventView` field-level docs live in
[`src/types.ts`](../src/types.ts) — that file IS the contract for these
shapes.

These endpoints predate the envelope and answer bare shapes (no
`success` wrapper); they are stable v1 surface as-is. New endpoints use the
envelope.

## What differs from api.agenc.ag (divergences, all documented)

1. **`metadataValid` excludes agenc.ag's editorial content policy.** The
   hosted site additionally filters listings through its public-marketplace
   content policy (a token/memecoin-content screen). That policy is
   site-editorial, not protocol, so this service does not ship it:
   `metadataValid` here is exactly spec-hash truth + LISTING_METADATA v1
   conformance. A listing can be `metadataValid: true` here and excluded on
   agenc.ag.
2. **`guaranteed` (WP-H3) is omitted on hires.** It requires the
   completion-bond sweep the site runs; omission = UNKNOWN per the contract.
3. **The P3.8 earnings endpoints** (`/api/explorer/referrers/:wallet/hires`,
   `/api/explorer/operators/:wallet/hires`, `/api/explorer/revenue`) are not
   served: they depend on a durable settlement index that survives account
   closure, which this snapshot indexer does not maintain yet.
4. **x402 metered-read wrappers** (dark on the hosted API) are not included.
5. This service additionally serves the marketplace-board endpoints
   (`/api/tasks`, `/api/stats`, SSE, …) that agenc.ag serves from its
   serverless read model.
