// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. The modern era is
// served statelessly — `server/discover` names the supported revisions and
// no handshake or session follows — and the legacy initialize handshake is
// answered too, so either client generation connects. The six tools act on
// the same Forge store as REST and return the same JSON shapes.
import type { ServerResponse } from 'node:http';
import { Forge, ForgeError, type RepoState } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  })),
};

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

export function handleMcpParseError(res: ServerResponse): void {
  rpcError(res, null, -32700, 'Parse error', 400);
}

function toolResult(res: ServerResponse, id: unknown, value: unknown, isError = false): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: typeof value === 'string' ? { message: value } : value,
    isError,
  });
}

function mustRepo(forge: Forge, args: Record<string, unknown>): RepoState {
  const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === undefined) throw new ForgeError(404, 'Repository not found');
  return repo;
}

function callTool(forge: Forge, res: ServerResponse, id: unknown, name: string, args: Record<string, unknown>): void {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (spec === undefined) return rpcError(res, id, -32602, `Unknown tool: ${name}`);
  const missing = spec.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) return toolResult(res, id, `Missing required arguments: ${missing.join(', ')}`, true);
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo(forge.viewer().login, String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
        return toolResult(res, id, repoJson(repo));
      }
      case 'get_repo': {
        return toolResult(res, id, repoJson(mustRepo(forge, args)));
      }
      case 'create_issue': {
        const repo = mustRepo(forge, args);
        const issue = forge.createIssue(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          labels: [],
        });
        return toolResult(res, id, issueJson(forge, repo, issue));
      }
      case 'list_issues': {
        const repo = mustRepo(forge, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues
          .filter((issue) => state === 'all' || issue.state === state)
          .map((issue) => issueJson(forge, repo, issue));
        return toolResult(res, id, list);
      }
      case 'create_pull_request': {
        const repo = mustRepo(forge, args);
        const pull = forge.createPull(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolResult(res, id, pullJson(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = mustRepo(forge, args);
        const pull = repo.pullByNumber.get(Number(args.pull_number));
        if (pull === undefined) throw new ForgeError(404, 'Pull request not found');
        const sha = forge.squashMerge(repo, pull.head, pull.base, pull.title);
        if (sha === null) throw new ForgeError(405, 'Pull Request is not mergeable');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = forge.nowIso();
        pull.mergeCommitSha = sha;
        forge.touch(repo);
        return toolResult(res, id, pullJson(forge, repo, pull));
      }
    }
  } catch (error) {
    if (error instanceof ForgeError) return toolResult(res, id, error.message, true);
    return toolResult(res, id, error instanceof Error ? error.message : 'Tool failed', true);
  }
  return rpcError(res, id, -32602, `Unknown tool: ${name}`);
}

/** A response sink that records instead of writing, so a batch element can be handled on its own. */
function captureRes(): { res: ServerResponse; take: () => { status: number; body: Buffer } | null } {
  let status = 0;
  let body: Buffer | null = null;
  const res = {
    writeHead: (code: number) => { status = code; },
    setHeader: () => undefined,
    end: (chunk?: Buffer | string) => {
      body = chunk === undefined ? Buffer.alloc(0) : typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    take: () => (body === null ? null : { status, body }),
  };
}

/** Handle one POST /mcp with an already-parsed JSON body. */
export function handleMcp(forge: Forge, res: ServerResponse, body: unknown): void {
  if (Array.isArray(body)) {
    // A batch is answered per element: each element runs through the single
    // request path against a captured response; notifications stay silent.
    if (body.length === 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    const replies: unknown[] = [];
    for (const element of body) {
      const cap = captureRes();
      handleMcp(forge, cap.res, element);
      const got = cap.take();
      if (got !== null && got.status !== 202 && got.body.length > 0) {
        try {
          replies.push(JSON.parse(got.body.toString('utf8')));
        } catch {
          // An element that produced no JSON leaves no reply.
        }
      }
    }
    if (replies.length === 0) {
      res.writeHead(202, { 'content-type': 'application/json', 'content-length': 0 });
      res.end();
      return;
    }
    const out = Buffer.from(JSON.stringify(replies), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': out.length });
    res.end(out);
    return;
  }
  if (body === null || typeof body !== 'object') {
    return rpcError(res, null, -32600, 'Invalid Request');
  }
  const request = body as { id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === '') {
    // No method names nothing callable: with an id it is an invalid request,
    // and without one there is no notification to honor either.
    return rpcError(res, id === undefined || id === null ? null : id, -32600, 'Invalid Request');
  }
  if (id === undefined || id === null) {
    // A notification: accept and stay silent.
    res.writeHead(202, { 'content-type': 'application/json', 'content-length': 0 });
    res.end();
    return;
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(res, id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const offered = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return rpcResult(res, id, {
        protocolVersion: typeof offered === 'string' ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(res, id, {});
    case 'tools/list':
      return rpcResult(res, id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const params = request.params ?? {};
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return callTool(forge, res, id, toolName, args);
    }
    default:
      return rpcError(res, id, -32601, `Method not found: ${method}`);
  }
}
