// The HTTP server: one router over the four surfaces (git smart HTTP, REST
// v3, GraphQL v4, MCP), one bearer-token check for everything but the boot
// probe, and JSON errors everywhere. All state lives in a single Forge.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, sendError } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, handleMcpParseError } from './mcp.ts';

const MAX_BODY = 256 * 1024 * 1024;

let graphqlSeq = 0;

/** The GraphQL surface answers with its own writeHead calls; it still owes every reply a request id. */
function nextRequestId(): string {
  graphqlSeq += 1;
  return `G${graphqlSeq.toString(36).toUpperCase()}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected !== '' && token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(forge, req, res).catch((error: unknown) => {
      if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : 'Internal error');
      else res.end();
    });
  });
  // The benchmark client pools connections aggressively; a long keep-alive
  // window and no per-socket request cap keep those sockets reusable for a
  // whole workload instead of paying fresh handshakes mid-round.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  // Manual URL split: the router needs the path and, on two routes, the query
  // string; a full URL parse per request is measurable at benchmark volume.
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : rawUrl.slice(qIndex + 1));
  const url = { pathname: path, searchParams: query } as URL;

  if (method === 'GET' && path === '/healthz') {
    const body = Buffer.from('{"ok":true}', 'utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
    return;
  }

  if (!authorized(req)) return sendError(res, 401, 'Unauthorized');

  // MCP: the parse error contract is JSON-RPC, so it is handled apart.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(200, { 'content-length': 0 });
      res.end();
      return;
    }
    if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return handleMcpParseError(res);
    }
    return handleMcp(forge, res, parsed);
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(res, 400, 'Invalid JSON');
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => executeGraphQL(forge, entry as { query?: string; variables?: Record<string, unknown> }));
      const body = Buffer.from(JSON.stringify(results), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'x-github-request-id': nextRequestId() });
      res.end(body);
      return;
    }
    const result = executeGraphQL(forge, parsed as { query?: string; variables?: Record<string, unknown>; operationName?: string });
    const body = Buffer.from(JSON.stringify(result), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'x-github-request-id': nextRequestId() });
    res.end(body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    let body: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          return sendError(res, 400, 'Invalid JSON');
        }
      }
    }
    return handleRest(forge, req, res, url, segments, body);
  }

  // Git smart HTTP: /<owner>/<repo>.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    const repo = forge.getRepo(owner, repoName);
    const route = gitMatch[3]!;
    if (route === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      const protocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : '';
      return handleInfoRefs(forge, res, repo, service, protocol);
    }
    if (repo === undefined) return sendError(res, 404, 'Not Found');
    if (route === 'git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      const protocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : '';
      return handleUploadPack(forge, res, repo, raw, /(?:^|[\s,])version=2(?:\s|,|$)/.test(protocol));
    }
    if (route === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      return await handleReceivePack(forge, res, repo, raw);
    }
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}
