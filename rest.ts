// The REST v3 surface. One handler over the shared Forge store; every reply
// is JSON with a request-id header, errors are {"message": ...}, and the one
// hot read the benchmark times (a single issue, read thousands of times) is
// served from a per-repo cache of serialized bodies that any mutation clears.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, ForgeError, type IssueRec, type PullRec, type RepoState } from './store.ts';
import { parseTree } from './gitlib.ts';

let requestSeq = 0;

export function sendJson(res: ServerResponse, status: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `F${requestSeq.toString(36).toUpperCase()}`,
    'content-length': body.length,
  });
  res.end(body);
  return body;
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType = 'application/json; charset=utf-8'): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': `F${requestSeq.toString(36).toUpperCase()}`,
    'content-length': body.length,
  });
  res.end(body);
}

export function repoJson(repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(forge: Forge, repo: RepoState, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: forge.viewer().login, id: forge.viewer().id },
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function pullJson(forge: Forge, repo: RepoState, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.head) ?? '';
  const baseSha = forge.branchTip(repo, pull.base) ?? '';
  return {
    id: repo.id * 1000000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: forge.viewer().login, id: forge.viewer().id },
  };
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const pageRaw = Number(url.searchParams.get('page'));
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  if (start + page.perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    next.searchParams.set('per_page', String(page.perPage));
    next.searchParams.set('page', String(page.page + 1));
    for (const [key, value] of url.searchParams) {
      if (key !== 'per_page' && key !== 'page') next.searchParams.set(key, value);
    }
    res.setHeader('link', `<${next.toString()}>; rel="next"`);
  }
  return slice;
}

/** Handle one /api/v3 request. `segments` is the path after /api/v3. */
export function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
  body: Record<string, unknown> | null,
): void {
  const method = req.method ?? 'GET';
  const viewer = forge.viewer();
  try {
    route(forge, req, res, url, segments, body, method, viewer.login);
  } catch (error) {
    if (error instanceof ForgeError) sendError(res, error.status, error.message);
    else sendError(res, 500, error instanceof Error ? error.message : 'Internal error');
  }
}

function route(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
  body: Record<string, unknown> | null,
  method: string,
  login: string,
): void {
  // /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    res.setHeader('x-oauth-scopes', 'repo, read:org');
    return void sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
    });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return void sendJson(res, 200, { installed_version: '1.0.0', api_version: '3' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    const viewer = forge.viewer();
    return void sendJson(res, 200, { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = pageOf(url);
      const mine = forge.reposOf(login).map((repo) => repoJson(repo));
      return void sendJson(res, 200, paginate(res, req, url, mine, page));
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') throw new ForgeError(422, 'The name field is required');
      const repo = forge.createRepo(login, name, body?.private === true, typeof body?.description === 'string' ? body.description : '');
      return void sendJson(res, 201, repoJson(repo));
    }
    return sendError(res, 404, 'Not Found');
  }
  if (segments[0] === 'search' && segments[1] === 'issues' && segments.length === 2) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const items: Record<string, unknown>[] = [];
    for (const candidate of forge.reposOf(login)) {
      for (const issue of candidate.issues) {
        if (q === '' || issue.title.toLowerCase().includes(q) || issue.body.toLowerCase().includes(q)) {
          items.push(issueJson(forge, candidate, issue));
        }
      }
    }
    return void sendJson(res, 200, { total_count: items.length, incomplete_results: false, items });
  }
  if (segments[0] !== 'repos' || segments.length < 3) return sendError(res, 404, 'Not Found');
  const owner = segments[1]!;
  const name = segments[2]!;
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const rest = segments.slice(3);
  if (rest.length === 0) return repoRoot(forge, req, res, repo, body, method);
  switch (rest[0]) {
    case 'branches':
      return branches(forge, res, repo, rest, url, req, method);
    case 'commits':
      return commits(forge, req, res, repo, rest, url, method);
    case 'contents':
      return contents(forge, res, repo, rest.slice(1).join('/'), url, body, method);
    case 'git':
      return gitData(forge, res, repo, rest.slice(1), url, body, method);
    case 'labels':
      return labels(forge, res, repo, rest, body, method);
    case 'issues':
      return issues(forge, req, res, repo, rest, url, body, method);
    case 'pulls':
      return pulls(forge, req, res, repo, rest, url, body, method);
    default:
      return sendError(res, 404, 'Not Found');
  }
}

function repoRoot(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoState, body: Record<string, unknown> | null, method: string): void {
  void req;
  if (method === 'GET') return void sendJson(res, 200, repoJson(repo));
  if (method === 'PATCH') {
    if (typeof body?.description === 'string') repo.description = body.description;
    if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body?.name === 'string' && body.name !== '' && body.name !== repo.name) {
      if (forge.getRepo(repo.owner, body.name) !== undefined) {
        throw new ForgeError(422, `A repository named ${body.name} already exists for ${repo.owner}`);
      }
      forge.repos.delete(forge.repoKey(repo.owner, repo.name));
      repo.name = body.name;
      forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
    }
    if (typeof body?.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    forge.touch(repo);
    return void sendJson(res, 200, repoJson(repo));
  }
  if (method === 'DELETE') {
    forge.deleteRepo(repo.owner, repo.name);
    res.writeHead(204, { 'x-github-request-id': 'FDEL' });
    res.end();
    return;
  }
  return sendError(res, 404, 'Not Found');
}

function branches(forge: Forge, res: ServerResponse, repo: RepoState, rest: string[], url: URL, req: IncomingMessage, method: string): void {
  if (method !== 'GET') return sendError(res, 404, 'Not Found');
  if (rest.length === 1) {
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    return void sendJson(res, 200, paginate(res, req, url, list, pageOf(url)));
  }
  const branch = rest.slice(1).join('/');
  const sha = forge.branchTip(repo, branch);
  if (sha === undefined) return sendError(res, 404, 'Not Found');
  return void sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
}

function commits(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoState, rest: string[], url: URL, method: string): void {
  if (method !== 'GET') return sendError(res, 404, 'Not Found');
  if (rest.length === 2) {
    const sha = rest[1]!;
    const commit = forge.commitOf(repo, sha);
    if (commit === undefined) return sendError(res, 404, 'Not Found');
    return void sendJson(res, 200, commitJson(forge, repo, sha));
  }
  const refish = url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = forge.resolveCommit(repo, refish);
  if (tip === undefined) return void sendJson(res, 200, []);
  // Page over the oid list first; only the served page pays for commitJson.
  const all = forge.listCommits(repo, tip, 10000);
  const slice = paginate(res, req, url, all, pageOf(url));
  return void sendJson(res, 200, slice.map((oid) => commitJson(forge, repo, oid)));
}

function commitJson(forge: Forge, repo: RepoState, oid: string): Record<string, unknown> {
  const commit = forge.commitOf(repo, oid)!;
  const person = (raw: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(raw);
    if (match === null) return { name: raw, email: '', date: '2026-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: person(commit.author),
      committer: person(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function contents(forge: Forge, res: ServerResponse, repo: RepoState, path: string, url: URL, body: Record<string, unknown> | null, method: string): void {
  const ref = url.searchParams.get('ref') ?? (typeof body?.branch === 'string' ? body.branch : repo.defaultBranch);
  if (method === 'GET') {
    const dir = forge.listDir(repo, ref, path);
    const file = forge.readFile(repo, ref, path);
    if (file !== null) {
      const name = path.split('/').pop() ?? path;
      return void sendJson(res, 200, {
        type: 'file',
        name,
        path,
        sha: file.oid,
        size: file.data.length,
        encoding: 'base64',
        content: file.data.toString('base64'),
      });
    }
    if (dir !== null) {
      return void sendJson(res, 200, dir.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: 0,
      })));
    }
    return sendError(res, 404, 'Not Found');
  }
  if (method === 'PUT') {
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const contentB64 = typeof body?.content === 'string' ? body.content : '';
    const message = typeof body?.message === 'string' ? body.message : 'Update file';
    const existing = forge.branchTip(repo, branch) === undefined ? null : forge.readFile(repo, branch, path);
    if (existing !== null) {
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (sha === '') throw new ForgeError(422, 'The sha field is required when updating a file');
      if (sha !== existing.oid) throw new ForgeError(409, 'The sha does not match the current file');
    }
    const { commit, blob } = forge.writeFile(repo, branch, path, Buffer.from(contentB64, 'base64'), message);
    const created = existing === null;
    return void sendJson(res, created ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blob, size: Buffer.from(contentB64, 'base64').length, encoding: 'base64' },
      commit: { sha: commit, message },
    });
  }
  if (method === 'DELETE') {
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const message = typeof body?.message === 'string' ? body.message : 'Delete file';
    const existing = forge.readFile(repo, branch, path);
    if (existing === null) return sendError(res, 404, 'Not Found');
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    if (sha !== existing.oid) throw new ForgeError(409, 'The sha does not match the current file');
    const commit = forge.deleteFile(repo, branch, path, message);
    return void sendJson(res, 200, { content: null, commit: { sha: commit, message } });
  }
  return sendError(res, 404, 'Not Found');
}

function gitData(forge: Forge, res: ServerResponse, repo: RepoState, rest: string[], url: URL, body: Record<string, unknown> | null, method: string): void {
  if (rest[0] === 'refs' && rest.length === 1 && method === 'POST') {
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    if (ref === '' || forge.commitOf(repo, sha) === undefined) throw new ForgeError(422, 'Invalid ref or sha');
    forge.setRef(repo, ref, sha);
    return void sendJson(res, 201, { ref, node_id: '', object: { sha, type: 'commit' } });
  }
  if (rest[0] === 'refs' && method === 'GET') {
    if (rest.length === 1) {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
      return void sendJson(res, 200, list);
    }
    const ref = `refs/${rest.slice(1).join('/')}`;
    const sha = forge.getRef(repo, ref);
    if (sha === undefined) return sendError(res, 404, 'Not Found');
    return void sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
  }
  if (rest[0] === 'trees' && rest.length === 2 && method === 'GET') {
    let treeOid = rest[1]!;
    let object = forge.getObject(repo, treeOid);
    if (object !== undefined && object.type === 'commit') {
      const commit = forge.commitOf(repo, treeOid);
      if (commit === undefined) return sendError(res, 404, 'Not Found');
      treeOid = commit.tree;
      object = forge.getObject(repo, treeOid);
    }
    if (object === undefined || object.type !== 'tree') return sendError(res, 404, 'Not Found');
    if (url.searchParams.get('recursive') === '1') {
      const flat = forge.flattenTree(repo, treeOid);
      const tree = [...flat.entries()].map(([path, entry]) => ({ path, mode: entry.mode, type: 'blob', sha: entry.oid }));
      return void sendJson(res, 200, { sha: treeOid, tree, truncated: false });
    }
    const tree = parseTree(object.data).map((entry) => ({
      path: entry.name,
      mode: entry.mode,
      type: entry.mode === '40000' ? 'tree' : 'blob',
      sha: entry.oid,
    }));
    return void sendJson(res, 200, { sha: treeOid, tree, truncated: false });
  }
  return sendError(res, 404, 'Not Found');
}

function labels(forge: Forge, res: ServerResponse, repo: RepoState, rest: string[], body: Record<string, unknown> | null, method: string): void {
  if (rest.length === 1 && method === 'GET') {
    return void sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
  }
  if (rest.length === 1 && method === 'POST') {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (name === '') throw new ForgeError(422, 'The name field is required');
    if (repo.labels.has(name)) throw new ForgeError(422, `A label named ${name} already exists`);
    const color = typeof body?.color === 'string' ? body.color : 'ededed';
    const label = forge.addLabel(repo, name, color);
    return void sendJson(res, 201, { name: label.name, color: label.color });
  }
  return sendError(res, 404, 'Not Found');
}

function issues(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoState, rest: string[], url: URL, body: Record<string, unknown> | null, method: string): void {
  void req;
  if (rest.length === 1) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') throw new ForgeError(422, 'The title field is required');
      const issue = forge.createIssue(repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        labels: Array.isArray(body?.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [],
      });
      return void sendJson(res, 201, issueJson(forge, repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'asc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      list = [...list].sort((a, b) => a.number - b.number);
      if (direction === 'desc') list.reverse();
      const page = pageOf(url);
      return void sendJson(res, 200, paginate(res, req, url, list.map((issue) => issueJson(forge, repo, issue)), page));
    }
    return sendError(res, 404, 'Not Found');
  }
  const number = Number(rest[1]);
  const issue = Number.isInteger(number) ? repo.issueByNumber.get(number) : undefined;
  if (rest.length === 2) {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') {
      // The benchmark's hot path: serve the serialized body from cache.
      const key = `issue:${number}:v${repo.version}`;
      const cached = repo.responseCache.get(key);
      if (cached !== undefined) return void sendBuffer(res, 200, cached);
      const bodyBuffer = Buffer.from(JSON.stringify(issueJson(forge, repo, issue)), 'utf8');
      repo.responseCache.set(key, bodyBuffer);
      return void sendBuffer(res, 200, bodyBuffer);
    }
    if (method === 'PATCH') {
      if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      forge.touch(repo);
      return void sendJson(res, 200, issueJson(forge, repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') {
      return void sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: forge.viewer().login } })));
    }
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      if (text === '') throw new ForgeError(422, 'The body field is required');
      const comment = forge.addComment(repo, issue, text);
      return void sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: forge.viewer().login } });
    }
  }
  return sendError(res, 404, 'Not Found');
}

function pulls(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoState, rest: string[], url: URL, body: Record<string, unknown> | null, method: string): void {
  if (rest.length === 1) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      const head = typeof body?.head === 'string' ? body.head : '';
      const base = typeof body?.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') throw new ForgeError(422, 'title, head and base are required');
      const duplicate = [...repo.pullByNumber.values()].find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
      if (duplicate !== undefined) throw new ForgeError(422, `A pull request already exists for ${head} into ${base}`);
      const pull = forge.createPull(repo, { title, body: typeof body?.body === 'string' ? body.body : '', head, base });
      return void sendJson(res, 201, pullJson(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = [...repo.pullByNumber.values()]
        .filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'))
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullJson(forge, repo, pull));
      return void sendJson(res, 200, paginate(res, req, url, list, pageOf(url)));
    }
    return sendError(res, 404, 'Not Found');
  }
  const number = Number(rest[1]);
  const pull = Number.isInteger(number) ? repo.pullByNumber.get(number) : undefined;
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  if (rest.length === 2) {
    if (method === 'GET') return void sendJson(res, 200, pullJson(forge, repo, pull));
    return sendError(res, 404, 'Not Found');
  }
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const headTip = forge.branchTip(repo, pull.head);
    const baseTip = forge.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return void sendJson(res, 200, []);
    const ancestor = forge.mergeBase(repo, headTip, baseTip);
    if (ancestor === null) return void sendJson(res, 200, []);
    const diff = forge.diffTrees(repo, forge.readTreeFlat(repo, ancestor), forge.readTreeFlat(repo, headTip));
    return void sendJson(res, 200, [...diff.entries()].map(([filename, change]) => ({
      filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })));
  }
  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    if (pull.merged) return sendError(res, 405, 'Pull Request is not mergeable');
    const sha = forge.squashMerge(repo, pull.head, pull.base, pull.title);
    if (sha === null) return sendError(res, 405, 'Pull Request is not mergeable');
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = forge.nowIso();
    pull.mergeCommitSha = sha;
    forge.touch(repo);
    return void sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return sendError(res, 404, 'Not Found');
}
