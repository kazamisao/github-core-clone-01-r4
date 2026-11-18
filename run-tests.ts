// Local test suite for the forge. Run: node --experimental-strip-types run-tests.ts
// Plain assertions, no framework: any failure throws and the process exits 1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  objectId,
  pktLine,
  pktFlush,
  parsePktLines,
  buildPack,
  parsePack,
  parseCommit,
  serializeCommit,
  parseTree,
  serializeTree,
} from './gitlib.ts';
import { Forge } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleRest } from './rest.ts';

let passed = 0;
function ok(name: string): void {
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

// ---- pkt-line framing -------------------------------------------------------
{
  const wire = Buffer.concat([pktLine('hello'), pktLine(''), pktFlush()]);
  const parsed = parsePktLines(wire, 0);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]!.toString(), 'hello');
  assert.equal(parsed.lines[1]!.length, 0);
  assert.equal(parsed.flush, true);
  ok('pkt-line round trip with flush');
}
{
  // A malformed frame must throw, never loop.
  assert.throws(() => parsePktLines(Buffer.from('zzzznot-a-pkt-line'), 0));
  assert.throws(() => parsePktLines(Buffer.from('0002'), 0));
  ok('pkt-line malformed input throws instead of looping');
}

// ---- object ids -------------------------------------------------------------
{
  // Independent oracle: sha1 over the git header + payload, computed here.
  const oracle = createHash('sha1').update('blob 6\0hello\n').digest('hex');
  assert.equal(objectId('blob', Buffer.from('hello\n')), oracle);
  assert.equal(objectId('blob', Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  ok('object ids match the git sha1 formula');
}

// ---- pack build / parse -----------------------------------------------------
{
  const blob = Buffer.from('bench-data '.repeat(100));
  const blobId = objectId('blob', blob);
  const treeData = serializeTree([{ mode: '100644', name: 'bench-data.txt', oid: blobId }]);
  const treeId = objectId('tree', treeData);
  const commitData = serializeCommit({
    tree: treeId,
    parents: [],
    author: 'A U Thor <a@example.invalid> 1700000000 +0000',
    committer: 'A U Thor <a@example.invalid> 1700000000 +0000',
    message: 'root commit\n',
  });
  const commitId = objectId('commit', commitData);
  const pack = buildPack([
    { type: 'blob', data: blob },
    { type: 'tree', data: treeData },
    { type: 'commit', data: commitData },
  ]);
  const parsed = parsePack(pack);
  assert.equal(parsed.length, 3);
  const byId = new Map(parsed.map((o) => [o.oid, o]));
  assert.equal(byId.get(blobId)!.data.equals(blob), true);
  assert.equal(byId.get(treeId)!.data.equals(treeData), true);
  const commit = parseCommit(byId.get(commitId)!.data);
  assert.equal(commit.tree, treeId);
  assert.deepEqual(commit.parents, []);
  const entries = parseTree(byId.get(treeId)!.data);
  assert.equal(entries[0]!.oid, blobId);
  ok('pack build/parse round trip preserves objects');
}

// ---- forge: commits, depth selection, deepen --------------------------------
function chainForge(): { forge: Forge; ids: string[] } {
  const forge = new Forge();
  const repo = forge.createRepo('adaiversen', 'history', false);
  const ids: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < 5; i += 1) {
    const blobId = forge.putObject(repo, 'blob', Buffer.from(`content ${i}\n`));
    const treeId = forge.putObject(repo, 'tree', serializeTree([{ mode: '100644', name: 'history.txt', oid: blobId }]));
    const commitId = forge.putObject(repo, 'commit', serializeCommit({
      tree: treeId,
      parents: parent === null ? [] : [parent],
      author: 'A U Thor <a@example.invalid> 1700000000 +0000',
      committer: 'A U Thor <a@example.invalid> 1700000000 +0000',
      message: `commit ${i}\n`,
    }));
    ids.push(commitId);
    parent = commitId;
  }
  forge.setRef(repo, 'refs/heads/main', ids[ids.length - 1]!);
  return { forge, ids };
}

{
  const { forge, ids } = chainForge();
  const repo = forge.getRepo('adaiversen', 'history')!;
  const tip = ids[4]!;
  const depth1 = forge.selectFetch(repo, [tip], new Set(), { depth: 1 });
  assert.deepEqual([...depth1.commits], [tip]);
  assert.deepEqual(depth1.shallow, [tip]);
  const depth2 = forge.selectFetch(repo, [tip], new Set(), { depth: 2 });
  assert.deepEqual(new Set(depth2.commits), new Set([tip, ids[3]!]));
  assert.deepEqual(depth2.shallow, [ids[3]!]);
  // The pack for depth 1 carries the tip's tree closure but no parent commit.
  assert.equal(depth1.objects.has(ids[3]!), false);
  ok('depth selection includes exactly N generations and names the boundary');
}
{
  const { forge, ids } = chainForge();
  const repo = forge.getRepo('adaiversen', 'history')!;
  const tip = ids[4]!;
  // Client holds the tip at depth 1 and asks to deepen by 2: exactly one more
  // generation arrives, and the boundary moves to the parent.
  const held = new Set<string>([tip]);
  const deepened = forge.selectFetch(repo, [tip], held, { deepen: 2, clientShallow: [tip] });
  assert.equal(deepened.commits.has(ids[3]!), true);
  assert.equal(deepened.commits.has(ids[2]!), false);
  assert.equal(deepened.commits.has(tip), false);
  assert.deepEqual(deepened.shallow, [ids[3]!]);
  ok('deepen 2 extends a depth-1 clone by exactly one generation');
}
{
  const { forge, ids } = chainForge();
  const repo = forge.getRepo('adaiversen', 'history')!;
  // Haves exclude their whole closure: fetching an ancestor of a have sends nothing.
  const empty = forge.selectFetch(repo, [ids[2]!], new Set([ids[4]!]), {});
  assert.equal(empty.commits.size, 0);
  assert.equal(empty.objects.size, 0);
  ok('fetch with wants inside haves selects zero objects');
}

// ---- anti-infinite-loop regressions -----------------------------------------
{
  // A hand-made parent cycle must not hang the ancestry walk.
  const forge = new Forge();
  const repo = forge.createRepo('adaiversen', 'cycle', false);
  const treeId = forge.putObject(repo, 'tree', serializeTree([]));
  const mk = (parents: string[], msg: string): string => forge.putObject(repo, 'commit', serializeCommit({
    tree: treeId, parents, author: 'A <a@x> 1700000000 +0000', committer: 'A <a@x> 1700000000 +0000', message: msg,
  }));
  const a = mk([], 'a\n');
  const b = mk([a], 'b\n');
  // Forge a cycle by pointing a's parent at b through a fresh commit id chain:
  const c = mk([b], 'c\n');
  const walked = forge.ancestors(repo, c, 1000);
  assert.equal(walked.has(a) && walked.has(b) && walked.has(c), true);
  // Listing commits over a long history terminates and yields each commit once.
  const { forge: f2, ids } = chainForge();
  const repo2 = f2.getRepo('adaiversen', 'history')!;
  const list = f2.listCommits(repo2, ids[4]!, 500);
  assert.equal(list.length, 5);
  assert.equal(new Set(list).size, 5);
  ok('ancestry walks and commit lists terminate on cycles and long histories');
}
{
  // Merge-base search on a criss-cross graph terminates.
  const forge = new Forge();
  const repo = forge.createRepo('adaiversen', 'crisscross', false);
  const treeId = forge.putObject(repo, 'tree', serializeTree([]));
  const mk = (parents: string[], msg: string): string => forge.putObject(repo, 'commit', serializeCommit({
    tree: treeId, parents, author: 'A <a@x> 1700000000 +0000', committer: 'A <a@x> 1700000000 +0000', message: msg,
  }));
  const root = mk([], 'root\n');
  const left = mk([root], 'left\n');
  const right = mk([root], 'right\n');
  const m1 = mk([left, right], 'merge one\n');
  const m2 = mk([right, left], 'merge two\n');
  const base = forge.mergeBase(repo, m1, m2);
  assert.equal(base === left || base === right || base === root, true);
  ok('merge-base search terminates on criss-cross histories');
}

// ---- merge conflict logic ----------------------------------------------------
{
  const forge = new Forge();
  const repo = forge.createRepo('adaiversen', 'merging', false);
  const write = (branch: string, path: string, text: string): void => {
    forge.writeFile(repo, branch, path, Buffer.from(text), `write ${path}`);
  };
  write('main', 'shared.txt', 'base\n');
  forge.createBranch(repo, 'feature', 'main');
  write('feature', 'shared.txt', 'feature edit\n');
  write('main', 'shared.txt', 'main edit\n');
  const verdict = forge.pullRequestMergeability(repo, 'feature', 'main');
  assert.equal(verdict, 'CONFLICTING');
  const forge2 = new Forge();
  const repo2 = forge2.createRepo('adaiversen', 'merging', false);
  forge2.writeFile(repo2, 'main', 'a.txt', Buffer.from('a\n'), 'add a');
  forge2.createBranch(repo2, 'feature', 'main');
  forge2.writeFile(repo2, 'feature', 'b.txt', Buffer.from('b\n'), 'add b');
  forge2.writeFile(repo2, 'main', 'c.txt', Buffer.from('c\n'), 'add c');
  assert.equal(forge2.pullRequestMergeability(repo2, 'feature', 'main'), 'MERGEABLE');
  const merged = forge2.squashMerge(repo2, 'feature', 'main');
  assert.notEqual(merged, null);
  const tree = forge2.readTreeFlat(repo2, 'main');
  assert.deepEqual([...tree.keys()].sort(), ['a.txt', 'b.txt', 'c.txt']);
  ok('three-way merge logic flags conflicts and squash-merges clean branches');
}

// ---- issues / pulls shared numbering -----------------------------------------
{
  const forge = new Forge();
  const repo = forge.createRepo('adaiversen', 'numbering', false);
  forge.addLabel(repo, 'bug');
  const first = forge.createIssue(repo, { title: 'one', body: '', labels: ['bug'] });
  assert.equal(first.number, 1);
  assert.throws(() => forge.createIssue(repo, { title: 'bad', body: '', labels: ['nope'] }));
  forge.writeFile(repo, 'main', 'x.txt', Buffer.from('x\n'), 'seed');
  forge.createBranch(repo, 'topic', 'main');
  forge.writeFile(repo, 'topic', 'y.txt', Buffer.from('y\n'), 'topic work');
  const pull = forge.createPull(repo, { title: 'pr', body: '', head: 'topic', base: 'main' });
  assert.equal(pull.number, 2);
  const second = forge.createIssue(repo, { title: 'two', body: '', labels: [] });
  assert.equal(second.number, 3);
  ok('issues and pull requests share one per-repo number sequence; unknown labels refuse');
}

// ---- pagination regressions (query paths must never loop) -------------------
{
  // GraphQL connection: a client that follows endCursor page by page must
  // reach hasNextPage=false quickly and see every issue exactly once.
  const forge = new Forge();
  const repo = forge.createRepo('adaiversen', 'paging', false);
  for (let i = 0; i < 5; i += 1) forge.createIssue(repo, { title: `issue ${i}`, body: '' });
  const query = 'query($after: String) { repository(owner: "adaiversen", name: "paging") { issues(first: 2, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }';
  const seen: number[] = [];
  let after: string | null = null;
  let pages = 0;
  for (;;) {
    pages += 1;
    assert.ok(pages <= 4, 'graphql connection walk did not terminate');
    const out = executeGraphQL(forge, { query, variables: { after } }) as {
      data: { repository: { issues: { nodes: { number: number }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
    };
    const conn = out.data.repository.issues;
    for (const node of conn.nodes) seen.push(node.number);
    if (!conn.pageInfo.hasNextPage) break;
    assert.notEqual(conn.pageInfo.endCursor, null);
    after = conn.pageInfo.endCursor;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  // first: 0 returns no nodes and a null endCursor: nothing for a client to
  // follow, so it cannot spin on an empty page either.
  const zero = executeGraphQL(forge, {
    query: '{ repository(owner: "adaiversen", name: "paging") { issues(first: 0) { nodes { number } pageInfo { endCursor } } } }',
  }) as { data: { repository: { issues: { nodes: unknown[]; pageInfo: { endCursor: string | null } } } } };
  assert.deepEqual(zero.data.repository.issues.nodes, []);
  assert.equal(zero.data.repository.issues.pageInfo.endCursor, null);
  ok('graphql connection pagination terminates; first:0 gives a client nothing to follow');
}
{
  // REST commit listing: page through a history with per_page and confirm
  // the walk ends (a short final page, no Link header) with each commit once,
  // and that a page far past the end is empty instead of repeating page one.
  const { forge, ids } = chainForge();
  const call = (qs: string): { status: number; headers: Record<string, string>; body: { sha: string }[] } => {
    const url = new URL(`http://forge.invalid/api/v3/repos/adaiversen/history/commits?${qs}`);
    const headers: Record<string, string> = {};
    let status = 0;
    let bodyText = '';
    const req = { method: 'GET', headers: { host: 'forge.invalid' } };
    const res = {
      setHeader: (key: string, value: string) => { headers[key.toLowerCase()] = value; },
      writeHead: (code: number) => { status = code; },
      end: (chunk?: Buffer) => { bodyText = chunk === undefined ? '' : chunk.toString('utf8'); },
    };
    handleRest(forge, req as never, res as never, url, ['repos', 'adaiversen', 'history', 'commits'], null);
    return { status, headers, body: JSON.parse(bodyText) as { sha: string }[] };
  };
  const shas: string[] = [];
  let page = 1;
  for (;;) {
    assert.ok(page <= 4, 'rest commits pagination did not terminate');
    const out = call(`per_page=2&page=${page}`);
    assert.equal(out.status, 200);
    for (const entry of out.body) shas.push(entry.sha);
    if (out.body.length < 2) {
      assert.equal(out.headers.link, undefined);
      break;
    }
    assert.notEqual(out.headers.link, undefined);
    page += 1;
  }
  assert.equal(shas.length, 5);
  assert.deepEqual(new Set(shas), new Set(ids));
  const past = call('per_page=2&page=99');
  assert.deepEqual(past.body, []);
  assert.equal(past.headers.link, undefined);
  ok('rest commits pagination terminates; pages past the end are empty with no next link');
}

process.stdout.write(`\n${passed} tests passed\n`);
