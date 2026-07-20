# agenc-indexer

Self-hostable read-model indexer for the [AgenC marketplace
protocol](https://github.com/tetsuo-ai/agenc-protocol) on Solana:
`getProgramAccounts` snapshot polling → SQLite read model → versioned
REST + SSE, including the four explorer endpoints the
`@tetsuo-ai/marketplace-sdk` `createIndexerClient` documents.

Run it against **any Solana RPC** you trust. Defaults target the public
mainnet program `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`; every knob is
an environment variable and logs its source (`env` vs `default`) at boot.

Extracted from agenc.ag's internal `services/indexer` (itself adapted from
`agenc-public-explorer`) as part of WP-C3; the hosted API at
`https://api.agenc.ag` serves the same wire contract
(reference OpenAPI: <https://agenc.ag/openapi.json>).

## Run

```bash
# plain node (>= 20.18)
npm install
npm start                 # tsx, foreground
npm run dev               # tsx watch
npm run build && node dist/index.mjs

# docker
docker build -t agenc-indexer .
docker run -p 8787:8787 -e HOST=0.0.0.0 \
  -e SOLANA_RPC_URL=https://your-rpc.example.com \
  -v agenc-indexer-data:/data -e EXPLORER_DB_PATH=/data/explorer.sqlite \
  agenc-indexer

# then
curl -s localhost:8787/healthz
curl -s localhost:8787/api/explorer/listings | head -c 400
```

## Configuration (env only)

| Variable | Default | Notes |
| --- | --- | --- |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | the public RPC works but is rate-limited; use a dedicated RPC in production |
| `AGENC_PROGRAM_ID` | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` | mainnet program |
| `EXPLORER_DB_PATH` | `.agenc-indexer-data/explorer.sqlite` | relative paths resolve from cwd |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | bind `0.0.0.0` only behind a reverse proxy / in a container |
| `SNAPSHOT_INTERVAL_MS` | `45000` | base poll interval; doubles up to 15 min on RPC errors/429s |
| `EVENT_STORE_LIMIT` | `2000` | max persisted feed events |
| `DISABLE_EVENT_MONITOR` | `false` | `true` skips websocket log subscriptions (polling only). The established variable name is retained although the old runtime EventMonitor dependency is gone. |
| `DISABLE_LISTING_METADATA` | `false` | `true` skips outbound spec-metadata fetches; listings then serve `metadataValid: false` with an explicit issue (never a fabricated pass) |
| `TRUSTED_MODERATORS` | *(empty)* | extra comma-separated moderator pubkeys whose on-chain moderation records count toward `verified` (the global moderation authority + attest.agenc.ag roster attestor are always trusted) |

## API

The versioned contract lives in [`docs/API.md`](docs/API.md). Highlights:

- Every response carries `X-Agenc-Contract-Version: 1`; changes within a
  major version are additive only.
- The four SDK-documented explorer endpoints (`/api/explorer/listings`,
  `/api/explorer/listings/:pda`, `/api/explorer/listings/:pda/hires`,
  `/api/explorer/agents/:pda/track-record`) match api.agenc.ag's envelope:
  `{ success: true, ... }` / `{ success: false, error: { code, message } }`,
  with `accountData` = base64 of the REAL on-chain bytes for byte-true
  client-side decoding.
- Marketplace-board endpoints: `/api/tasks`, `/api/tasks/:pda`,
  `/api/agents`, `/api/stats`, `/api/activity`, `/api/events` (SSE),
  `/api/jobspec-check`, `/healthz`. All lamports are decimal strings.
- What intentionally differs from the hosted api.agenc.ag deployment (site
  editorial policy, WP-H3 `guaranteed`, P3.8 earnings endpoints) is listed in
  `docs/API.md` — extraction kept honest rather than shipping broken stubs.

## How it indexes

- Snapshot poll (default 45 s): `getProgramAccounts` for Task /
  AgentRegistration / TaskClaim / ServiceListing / HireRecord, then targeted
  `getMultipleAccountsInfo` for TaskJobSpec, TaskModeration (moderator-keyed
  v2 PDAs + the frozen legacy PDA), TaskValidationConfig, and TaskSubmission.
  Account layouts are decoded with the published `@tetsuo-ai/marketplace-sdk`
  generated client; decoded discriminators are asserted so drift fails closed
  instead of mis-decoding.
- Feed events are derived from indexed state with deterministic ids and
  inserted idempotently — the first sync backfills history from on-chain
  timestamps; later observations only broadcast genuinely new events to SSE
  clients.
- Websocket log subscriptions are low-latency refresh triggers only; the
  snapshot diff is the canonical event source, so a dead websocket degrades
  latency, never correctness.
- RPC failures/429s: exponential poll backoff (to 15 min), the last good
  snapshot keeps serving, the process never crash-loops.
- Listing `metadataValid` = SSRF-guarded fetch of the pinned spec URI +
  canonical job-spec hash match against the on-chain `specHash` +
  LISTING_METADATA v1 conformance. Verified verdicts are cached forever per
  (uri, hash) — the hash pins the content; failures retry on a TTL.

## Scale targets (the WP-C3 contract)

These are the T1–T8 targets from agenc-protocol
`docs/SCALE_COST_MODEL.md` §7, restated here as this service's stated
contract. **Honesty note: this service has NOT yet been load-tested at the
1M-task corpus.** Targets marked *documented* are commitments the
implementation is designed around, not yet CI-proven numbers; the table says
which is which today.

| # | Target | Number | Status here |
| --- | --- | --- | --- |
| T1 | Zero-gPA serving | At ≥ 10,000 cumulative tasks, no serving endpoint issues gPA | **Met by construction** — every HTTP read is served from SQLite; gPA runs only in the background snapshot loop |
| T2 | Ingest throughput | Sustained 50 settlement-bearing tx/s without falling behind staleness targets | Documented; not yet load-tested |
| T3 | Staleness | p50 ≤ 5 slots, p95 ≤ 25 slots, alert > 150 slots, read-your-writes ≤ 5 s | Partially: the default 45 s poll interval does NOT meet p50 ≤ 5 slots — lower `SNAPSHOT_INTERVAL_MS` and use a dedicated RPC + websocket triggers to approach it; staleness metrics/alerts not yet exposed |
| T4 | Query latency | p95 ≤ 500 ms lists / ≤ 200 ms single-PDA at 1M tasks / 8M children | Documented; not yet load-tested at that corpus |
| T5 | Cold rebuild | Full reindex of the 1M corpus ≤ 4 h with resumable checkpoints | Documented; today's rebuild is a single full snapshot (fine at current mainnet volume, not chunked/resumable yet) |
| T6 | Byte-true contract | `accountData` stays byte-identical to on-chain data | **Met + unit-tested** (round-trip test pins pass-through) |
| T7 | Corpus math stays pinned | §1 size table regenerated in a unit test with a printed manifest | **Met** — `src/__tests__/scale-manifest.test.ts` pins the SDK's generated account sizes against the §1 manifest |
| T8 | Tx-shape assertions | litesvm account-count assertions for settlement paths | Out of scope for this repo (program-side; lives in agenc-protocol) |

## Tests

```bash
npm run typecheck
npm test
```

The test suite covers wire-contract mapping (status/type remapping,
RejectFrozen never claimable), untrusted on-chain text gating, explorer projection
(byte-true listing decode round-trip, filters/paging, hires join),
LISTING_METADATA conformance + caching, the T7 size manifest, and revision-5
Task / AgentRegistration / TaskClaim snapshot decoding with last-good-snapshot
preservation on total decoder failure.

## What was left behind in the extraction (and why)

- **agenc.ag's editorial content policy** (`metadataValid` on the hosted API
  additionally screens token/memecoin content) — site policy, not protocol.
- **WP-H3 `guaranteed` on hires** — requires the site's completion-bond
  sweep; the contract defines absence as UNKNOWN, so it is omitted.
- **P3.8 earnings endpoints** (referrers/operators/revenue) — they need a
  durable settlement index that survives account closure; this snapshot
  indexer does not maintain one yet.
- **x402 metered-read wrappers** — dark on the hosted API, site-specific.

## License

[MIT](LICENSE)
