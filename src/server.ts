import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  decodeExplorerListing,
  explorerListingHires,
  filterAndPage,
  type ExplorerListing,
} from './explorer.js';
import { checkJobSpec, JobSpecCheckError } from './jobspec.js';
import type { IndexerStore } from './store.js';
import {
  agentRecordToView,
  mapStatusFilter,
  taskRecordToView,
  type FeedEventView,
  type StatsView,
} from './types.js';
import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER } from './version.js';

/**
 * HTTP edge implementing the agenc.ag API contract (GET-only JSON + SSE).
 * Explorer-shaped SQLite rows are mapped to the contract views here.
 * CORS: Access-Control-Allow-Origin * so the Vercel-hosted site can read it.
 */

export type HealthState = {
  rpcUrl: string;
  programId: string;
  programIdSource: 'env' | 'default';
  dbPath: string;
  lastError: () => string | null;
  lastSlot: () => number;
};

const SSE_KEEPALIVE_MS = 25_000;

function applyCors(res: ServerResponse<IncomingMessage>): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader(CONTRACT_VERSION_HEADER, CONTRACT_VERSION);
}

function sendJson(res: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function parseIntegerParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export class IndexerServer {
  private readonly store: IndexerStore;
  private readonly health: HealthState;
  private readonly logger: { info: (message: string) => void; error: (message: string) => void };
  private readonly clients = new Set<ServerResponse<IncomingMessage>>();
  private server: Server | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    store: IndexerStore;
    health: HealthState;
    logger: { info: (message: string) => void; error: (message: string) => void };
  }) {
    this.store = params.store;
    this.health = params.health;
    this.logger = params.logger;
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Broadcast one FeedEventView to all connected SSE clients. */
  broadcast(event: FeedEventView): void {
    if (!this.clients.size) {
      return;
    }
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      this.writeToClient(client, frame);
    }
  }

  /**
   * Write to one SSE client, evicting it on failure or backpressure — a
   * wedged consumer must not buffer frames in process memory forever.
   */
  private writeToClient(client: ServerResponse<IncomingMessage>, chunk: string): void {
    if (client.destroyed || client.writableEnded) {
      this.clients.delete(client);
      return;
    }
    try {
      if (!client.write(chunk)) {
        this.clients.delete(client);
        client.destroy();
      }
    } catch {
      this.clients.delete(client);
      client.destroy();
    }
  }

  listen(port: number, host: string, onReady: () => void): void {
    this.server = createServer((req, res) => {
      try {
        this.handleRequest(req, res);
      } catch (error) {
        this.logger.error(
          `Unhandled request error: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal server error' });
        } else {
          res.end();
        }
      }
    });
    this.server.listen(port, host, onReady);

    this.keepaliveTimer = setInterval(() => {
      for (const client of this.clients) {
        this.writeToClient(client, ': keepalive\n\n');
      }
    }, SSE_KEEPALIVE_MS);
  }

  close(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.server?.close();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse<IncomingMessage>): void {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    applyCors(res);

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (url.pathname === '/healthz') {
      // ok flips false when the last RPC refresh failed, so droplet
      // monitoring can actually alert instead of always reading green.
      sendJson(res, 200, {
        ok: this.health.lastError() === null,
        rpcUrl: this.health.rpcUrl,
        programId: this.health.programId,
        programIdSource: this.health.programIdSource,
        clients: this.clients.size,
        lastError: this.health.lastError(),
        dbPath: this.health.dbPath,
      });
      return;
    }

    if (url.pathname === '/api/stats') {
      const nowUnix = Math.floor(Date.now() / 1000);
      const stats = this.store.buildStats(nowUnix);
      const payload: StatsView = {
        slot: this.health.lastSlot(),
        tasksSettled: stats.tasksSettled,
        lamportsPaidOut: stats.lamportsPaidOut.toString(),
        registeredAgents: stats.registeredAgents,
        escrowLockedLamports: stats.escrowLockedLamports.toString(),
        activeClaims: stats.activeClaims,
        avgSettleSeconds: stats.avgSettleSeconds,
        lastSettlementSecondsAgo: stats.lastSettlementSecondsAgo,
        programId: this.health.programId,
      };
      sendJson(res, 200, payload);
      return;
    }

    if (url.pathname === '/api/tasks') {
      const statusParam = url.searchParams.get('status')?.trim() ?? '';
      const status = statusParam ? mapStatusFilter(statusParam) : null;
      if (statusParam && !status) {
        sendJson(res, 400, { error: `Unknown status filter: ${statusParam}` });
        return;
      }
      const result = this.store.listTasks({
        status,
        page: parseIntegerParam(url, 'page', 1),
        pageSize: parseIntegerParam(url, 'pageSize', 24),
      });
      sendJson(res, 200, {
        items: result.items.map(taskRecordToView),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      });
      return;
    }

    if (url.pathname.startsWith('/api/tasks/')) {
      const pda = decodeURIComponent(url.pathname.slice('/api/tasks/'.length)).trim();
      if (!pda) {
        sendJson(res, 400, { error: 'Task PDA is required' });
        return;
      }
      const task = this.store.getTask(pda);
      if (!task) {
        sendJson(res, 404, { error: 'Task not found' });
        return;
      }
      sendJson(res, 200, { task: taskRecordToView(task) });
      return;
    }

    if (url.pathname === '/api/agents') {
      // Optional exact-match filter on the agent's wallet authority (base58),
      // for "which agents belong to this connected wallet" lookups.
      const authority = url.searchParams.get('authority')?.trim() || null;
      if (authority && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(authority)) {
        sendJson(res, 400, { error: 'authority must be a base58 public key' });
        return;
      }
      const result = this.store.listAgents({
        page: parseIntegerParam(url, 'page', 1),
        pageSize: parseIntegerParam(url, 'pageSize', 24),
        authority,
      });
      sendJson(res, 200, {
        items: result.items.map(agentRecordToView),
        total: result.total,
      });
      return;
    }

    // -- the four SDK-documented explorer endpoints (docs/API.md §explorer) --

    if (url.pathname === '/api/explorer/listings') {
      const metadataValidParam = url.searchParams.get('metadataValid');
      const page = filterAndPage(this.decodedListings(), {
        category: url.searchParams.get('category'),
        tags: url.searchParams.get('tags'),
        provider: url.searchParams.get('provider'),
        state: url.searchParams.get('state'),
        metadataValid:
          metadataValidParam === null
            ? undefined
            : metadataValidParam === 'true' || metadataValidParam === '1',
        page: parseIntegerParam(url, 'page', 1),
        pageSize: parseIntegerParam(url, 'pageSize', 50),
      });
      sendJson(res, 200, { success: true, ...page });
      return;
    }

    if (url.pathname.startsWith('/api/explorer/listings/')) {
      const rest = decodeURIComponent(url.pathname.slice('/api/explorer/listings/'.length));
      const [pda, tail] = rest.split('/', 2);
      const trimmed = (pda ?? '').trim();
      if (!trimmed) {
        sendJson(res, 400, {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Listing PDA is required' },
        });
        return;
      }
      if (tail === undefined || tail === '') {
        // A direct lookup is diagnostic: served regardless of metadata
        // conformance (only LIST queries default to conforming-only).
        const listing = this.decodedListings().find((l) => l.pda === trimmed) ?? null;
        if (!listing) {
          sendJson(res, 404, {
            success: false,
            error: { code: 'NOT_FOUND', message: 'listing not found' },
          });
          return;
        }
        sendJson(res, 200, { success: true, listing });
        return;
      }
      if (tail === 'hires') {
        const items = explorerListingHires(
          this.store.listHireRecordRows(trimmed),
          trimmed,
          (taskPda) => this.store.getTaskJoin(taskPda),
        );
        sendJson(res, 200, { success: true, items });
        return;
      }
      sendJson(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    if (
      url.pathname.startsWith('/api/explorer/agents/') &&
      url.pathname.endsWith('/track-record')
    ) {
      const pda = decodeURIComponent(
        url.pathname.slice('/api/explorer/agents/'.length, -'/track-record'.length),
      ).trim();
      const agent = pda ? this.store.getAgent(pda) : null;
      if (!agent) {
        sendJson(res, 404, {
          success: false,
          error: { code: 'NOT_FOUND', message: 'agent not found' },
        });
        return;
      }
      // Completions come from the on-chain AgentRegistration counter (the
      // same lifetime total an event stream would reconstruct). Dispute
      // counts + slash history need event indexing and are served as
      // zero/empty rather than fabricated.
      sendJson(res, 200, {
        success: true,
        agent: agent.pda,
        completions: agent.tasksCompleted,
        disputesInitiated: 0,
        disputesLost: 0,
        slashHistory: [],
        source: 'events',
      });
      return;
    }

    if (url.pathname === '/api/jobspec-check') {
      const uri = url.searchParams.get('uri') ?? '';
      void this.handleJobSpecCheck(uri, res);
      return;
    }

    if (url.pathname === '/api/activity') {
      const limit = parseIntegerParam(url, 'limit', 40);
      const items = this.store.listEvents(limit).map(({ id: _id, ...view }) => view);
      sendJson(res, 200, { items });
      return;
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
      });
      res.write(': connected\n\n');
      this.clients.add(res);
      req.on('close', () => {
        this.clients.delete(res);
        res.end();
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  /** Decode all stored listing rows to the explorer wire shape (fail-soft). */
  private decodedListings(): ExplorerListing[] {
    const out: ExplorerListing[] = [];
    for (const row of this.store.listListingRows()) {
      const decoded = decodeExplorerListing(row);
      if (decoded) {
        out.push(decoded);
      }
    }
    return out;
  }

  /**
   * GET /api/jobspec-check?uri=… — fetch a creator-supplied https job-spec
   * URI server-side (SSRF-guarded, see jobspec.ts) and report
   * `{ sha256, bytes, contentType }` so the create flow can pin an honest
   * job_spec_hash. Guard violations are 400s with safe messages; anything
   * unexpected is a 500 without internals.
   */
  private async handleJobSpecCheck(
    uri: string,
    res: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    try {
      const result = await checkJobSpec(uri);
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof JobSpecCheckError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      this.logger.error(
        `jobspec-check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      sendJson(res, 500, { error: 'Job-spec check failed' });
    }
  }
}
