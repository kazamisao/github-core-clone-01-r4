// The forge store: every surface (REST, GraphQL, MCP, git smart HTTP) reads
// and writes this one in-memory model, so an object created over any surface
// is the same object over all the others. Repositories are keyed by
// owner/name; git objects are content-addressed per repository; hot reads are
// served from per-repo caches of serialized responses and pack bytes.
import {
  objectId,
  parseCommit,
  serializeCommit,
  parseTree,
  serializeTree,
  commitTime,
  ZERO_OID,
  type CommitData,
  type ObjectType,
  type TreeEntry,
} from './gitlib.ts';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface RepoState {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  commitCache: Map<string, CommitData>;
  refs: Map<string, string>;
  issues: IssueRec[];
  issueByNumber: Map<number, IssueRec>;
  pullByNumber: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
  nextCommentId: number;
  version: number;
  responseCache: Map<string, Buffer>;
  packCache: Map<string, Buffer>;
}

export class ForgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

export class Forge {
  repos = new Map<string, RepoState>();
  private repoSeq = 100;
  private clockTick = 0;

  viewer(): { id: number; login: string; name: string; email: string } {
    return VIEWER;
  }

  /** Deterministic logical clock: a fixed epoch plus a per-forge counter. */
  nowIso(): string {
    this.clockTick += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.clockTick * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description = ''): RepoState {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) throw new ForgeError(422, `A repository named ${name} already exists for ${owner}`);
    const repo: RepoState = {
      id: this.repoSeq,
      owner,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      commitCache: new Map(),
      refs: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pullByNumber: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      version: 0,
      responseCache: new Map(),
      packCache: new Map(),
    };
    this.repoSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoState[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  touch(repo: RepoState): void {
    repo.version += 1;
    repo.responseCache.clear();
  }

  // ------------------------------------------------------------- objects

  putObject(repo: RepoState, type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: RepoState, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  commitOf(repo: RepoState, oid: string): CommitData | undefined {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  // ---------------------------------------------------------------- refs

  getRef(repo: RepoState, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: RepoState, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    this.touch(repo);
  }

  deleteRef(repo: RepoState, ref: string): void {
    repo.refs.delete(ref);
    this.touch(repo);
  }

  branchTip(repo: RepoState, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  createBranch(repo: RepoState, branch: string, fromBranch: string): string {
    const tip = this.branchTip(repo, fromBranch);
    if (tip === undefined) throw new ForgeError(422, `The branch ${fromBranch} does not exist`);
    const existing = this.branchTip(repo, branch);
    if (existing !== undefined) return existing;
    this.setRef(repo, `refs/heads/${branch}`, tip);
    return tip;
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveCommit(repo: RepoState, refish: string): string | undefined {
    if (refish === 'HEAD') {
      const tip = this.branchTip(repo, repo.defaultBranch);
      if (tip !== undefined) return tip;
    }
    const byRef = repo.refs.get(refish) ?? repo.refs.get(`refs/heads/${refish}`) ?? repo.refs.get(`refs/tags/${refish}`);
    if (byRef !== undefined) return byRef;
    const object = repo.objects.get(refish);
    if (object !== undefined && object.type === 'commit') return refish;
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('latin1'));
      if (match !== null) return match[1]!;
    }
    return undefined;
  }

  // ------------------------------------------------------------ traversal

  /** All ancestors of `tip` (including it), breadth-first, cycle-safe. */
  ancestors(repo: RepoState, tip: string, cap = 100000): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [tip];
    let head = 0;
    while (head < queue.length && seen.size < cap) {
      const oid = queue[head]!;
      head += 1;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === undefined) continue;
      seen.add(oid);
      for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
    }
    return seen;
  }

  /** Commits reachable from `tip`, newest first (time, then discovery order). */
  listCommits(repo: RepoState, tip: string, cap = 10000): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [tip];
    let head = 0;
    while (head < queue.length && order.length < cap) {
      const oid = queue[head]!;
      head += 1;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === undefined) continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
    }
    // Stable sort by committer time descending keeps linear histories exact
    // and gives a deterministic order for merged ones.
    const times = new Map(order.map((oid) => [oid, commitTime(repo.objects.get(oid)!.data)]));
    return order
      .map((oid, index) => ({ oid, index }))
      .sort((a, b) => (times.get(b.oid)! - times.get(a.oid)!) || (a.index - b.index))
      .map((entry) => entry.oid);
  }

  isAncestor(repo: RepoState, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(repo, descendant).has(ancestor);
  }

  /** The best common ancestor of two commits, or null. Cycle-safe. */
  mergeBase(repo: RepoState, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = this.ancestors(repo, a);
    if (fromA.has(b)) return b;
    const fromB = this.ancestors(repo, b);
    if (fromB.has(a)) return a;
    // Breadth-first from b: the first commit also reachable from a is a base.
    const seen = new Set<string>();
    const queue: string[] = [b];
    let head = 0;
    let guard = 0;
    while (head < queue.length) {
      guard += 1;
      if (guard > 200000) break;
      const oid = queue[head]!;
      head += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      const commit = this.commitOf(repo, oid);
      if (commit === undefined) continue;
      for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
    }
    return null;
  }

  // ---------------------------------------------------------------- trees

  /** Flatten a tree (by oid) into path -> {oid, mode}; cycle-safe. */
  flattenTree(repo: RepoState, treeOid: string, cap = 100000): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string, depth: number): void => {
      if (depth > 100 || out.size > cap) return;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path, depth + 1);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '', 0);
    return out;
  }

  readTreeFlat(repo: RepoState, refish: string): Map<string, { oid: string; mode: string }> {
    const commit = this.resolveCommit(repo, refish);
    if (commit === undefined) return new Map();
    const parsed = this.commitOf(repo, commit);
    if (parsed === undefined) return new Map();
    return this.flattenTree(repo, parsed.tree);
  }

  /** Build nested tree objects from a flat path map; returns the root tree oid. */
  buildTree(repo: RepoState, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(part)!;
      }
      node.files.set(parts[parts.length - 1]!, entry);
    }
    const emit = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
      return this.putObject(repo, 'tree', serializeTree(entries));
    };
    return emit(root);
  }

  /** Commit a flat tree on a branch; returns the new commit oid. */
  commitTree(repo: RepoState, branch: string, flat: Map<string, { oid: string; mode: string }>, message: string): string {
    const tree = this.buildTree(repo, flat);
    const parent = this.branchTip(repo, branch);
    const who = 'ada iversen <adaiversen@example.invalid>';
    // A logical timestamp: the repo version grows with every mutation, so a
    // later commit always carries a later time and replays stay identical.
    const seconds = 1700000000 + repo.version + 1;
    const commit = serializeCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      author: `${who} ${seconds} +0000`,
      committer: `${who} ${seconds} +0000`,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject(repo, 'commit', commit);
    this.setRef(repo, `refs/heads/${branch}`, oid);
    return oid;
  }

  /** Write one file on a branch (creating the branch as an orphan if absent). */
  writeFile(repo: RepoState, branch: string, path: string, content: Buffer, message: string): { commit: string; blob: string } {
    const flat = this.branchTip(repo, branch) === undefined ? new Map() : this.readTreeFlat(repo, branch);
    const blob = this.putObject(repo, 'blob', content);
    flat.set(path, { oid: blob, mode: '100644' });
    const commit = this.commitTree(repo, branch, flat, message);
    return { commit, blob };
  }

  deleteFile(repo: RepoState, branch: string, path: string, message: string): string {
    const flat = this.readTreeFlat(repo, branch);
    flat.delete(path);
    return this.commitTree(repo, branch, flat, message);
  }

  readFile(repo: RepoState, refish: string, path: string): { oid: string; data: Buffer } | null {
    const flat = this.readTreeFlat(repo, refish);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const object = repo.objects.get(entry.oid);
    if (object === undefined) return null;
    return { oid: entry.oid, data: object.data };
  }

  listDir(repo: RepoState, refish: string, path: string): { name: string; path: string; type: 'file' | 'dir'; oid: string }[] | null {
    const commit = this.resolveCommit(repo, refish);
    if (commit === undefined) return null;
    const parsed = this.commitOf(repo, commit);
    if (parsed === undefined) return null;
    let treeOid = parsed.tree;
    if (path !== '') {
      for (const part of path.split('/')) {
        const object = repo.objects.get(treeOid);
        if (object === undefined || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
        if (entry === undefined) return null;
        treeOid = entry.oid;
      }
    }
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      oid: entry.oid,
    }));
  }

  // --------------------------------------------------------------- labels

  addLabel(repo: RepoState, name: string, color = 'ededed'): LabelRec {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label = { name, color };
    repo.labels.set(name, label);
    this.touch(repo);
    return label;
  }

  // --------------------------------------------------------------- issues

  createIssue(repo: RepoState, input: { title: string; body: string; labels?: string[] }): IssueRec {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `The label ${name} does not exist in this repository`);
    }
    const issue: IssueRec = {
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    this.touch(repo);
    return issue;
  }

  addComment(repo: RepoState, issue: IssueRec, body: string): CommentRec {
    const comment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    this.touch(repo);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(repo: RepoState, input: { title: string; body: string; head: string; base: string }): PullRec {
    if (this.branchTip(repo, input.head) === undefined) throw new ForgeError(422, `The head branch ${input.head} does not exist`);
    if (this.branchTip(repo, input.base) === undefined) throw new ForgeError(422, `The base branch ${input.base} does not exist`);
    const pull: PullRec = {
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
    };
    repo.nextNumber += 1;
    repo.pullByNumber.set(pull.number, pull);
    this.touch(repo);
    return pull;
  }

  /** Changed paths between two flat trees: path -> status. */
  diffTrees(
    repo: RepoState,
    fromFlat: Map<string, { oid: string; mode: string }>,
    toFlat: Map<string, { oid: string; mode: string }>,
  ): Map<string, { status: string; additions: number; deletions: number }> {
    const out = new Map<string, { status: string; additions: number; deletions: number }>();
    const paths = new Set([...fromFlat.keys(), ...toFlat.keys()]);
    for (const path of paths) {
      const from = fromFlat.get(path);
      const to = toFlat.get(path);
      if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
      const fromLines = from === undefined ? [] : (repo.objects.get(from.oid)?.data.toString('utf8') ?? '').split('\n');
      const toLines = to === undefined ? [] : (repo.objects.get(to.oid)?.data.toString('utf8') ?? '').split('\n');
      const { additions, deletions } = lineDiff(fromLines, toLines);
      out.set(path, {
        status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
        additions,
        deletions,
      });
    }
    return out;
  }

  pullRequestMergeability(repo: RepoState, head: string, base: string): 'MERGEABLE' | 'CONFLICTING' {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
    const ancestor = this.mergeBase(repo, headTip, baseTip);
    if (ancestor === null) return 'CONFLICTING';
    const ancestorFlat = this.readTreeFlat(repo, ancestor);
    const headFlat = this.readTreeFlat(repo, headTip);
    const currentFlat = this.readTreeFlat(repo, baseTip);
    const headChanges = this.diffTrees(repo, ancestorFlat, headFlat);
    for (const path of headChanges.keys()) {
      const ancestorEntry = ancestorFlat.get(path);
      const headEntry = headFlat.get(path);
      const currentEntry = currentFlat.get(path);
      const ancestorOid = ancestorEntry?.oid ?? '';
      const headOid = headEntry?.oid ?? '';
      const currentOid = currentEntry?.oid ?? '';
      if (currentOid !== ancestorOid && currentOid !== headOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge `head` into `base`; returns the merge commit oid or null. */
  squashMerge(repo: RepoState, head: string, baseBranch: string, title = ''): string | null {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, baseBranch);
    if (headTip === undefined || baseTip === undefined) return null;
    if (this.pullRequestMergeability(repo, head, baseBranch) === 'CONFLICTING') return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return null;
    const ancestorFlat = this.readTreeFlat(repo, base);
    const headFlat = this.readTreeFlat(repo, headTip);
    const mergedFlat = this.readTreeFlat(repo, baseTip);
    const headChanges = this.diffTrees(repo, ancestorFlat, headFlat);
    for (const path of headChanges.keys()) {
      const headEntry = headFlat.get(path);
      if (headEntry === undefined) mergedFlat.delete(path);
      else mergedFlat.set(path, headEntry);
    }
    const message = title === '' ? `Merge pull request from ${head}\n` : `${title}\n`;
    return this.commitTree(repo, baseBranch, mergedFlat, message);
  }

  // ---------------------------------------------------------- fetch select

  /**
   * Choose the objects a fetch sends: the wants' history cut by depth /
   * deepen / deepen-since, minus everything reachable from the haves.
   * Returns the commit set, every object for the pack, and the shallow
   * boundary to report. All walks are visited-set bounded.
   */
  selectFetch(
    repo: RepoState,
    wants: string[],
    haves: Set<string>,
    options: { depth?: number; deepen?: number; deepenSince?: number; clientShallow?: string[] } = {},
  ): { commits: Set<string>; objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const clientShallow = new Set(options.clientShallow ?? []);
    const haveCommits = new Set<string>();
    for (const have of haves) {
      if (this.commitOf(repo, have) === undefined) continue;
      // A have the client holds only shallowly vouches for itself alone; a
      // full have vouches for its whole ancestry.
      const queue: string[] = [have];
      let head = 0;
      while (head < queue.length) {
        const oid = queue[head]!;
        head += 1;
        if (haveCommits.has(oid)) continue;
        const commit = this.commitOf(repo, oid);
        if (commit === undefined) continue;
        haveCommits.add(oid);
        if (clientShallow.has(oid)) continue;
        for (const parent of commit.parents) if (!haveCommits.has(parent)) queue.push(parent);
      }
    }
    const haveObjects = new Set<string>();
    for (const oid of haveCommits) this.collectTreeClosure(repo, oid, haveObjects);

    const included = new Set<string>();
    if (options.deepen !== undefined && clientShallow.size > 0) {
      // Budgeted walk: entering a commit the client already holds as shallow
      // arms a budget of `deepen` generations (the held commit counts as the
      // first); each step to a parent spends one.
      const budget = new Map<string, number>();
      const queue: { oid: string; left: number }[] = [];
      for (const want of wants) queue.push({ oid: want, left: Number.POSITIVE_INFINITY });
      let head = 0;
      let guard = 0;
      while (head < queue.length) {
        guard += 1;
        if (guard > 400000) break;
        const { oid, left } = queue[head]!;
        head += 1;
        let allowance = left;
        if (clientShallow.has(oid)) allowance = Math.min(allowance, options.deepen);
        if (allowance < 1) continue;
        const known = budget.get(oid);
        if (known !== undefined && known >= allowance) continue;
        budget.set(oid, allowance);
        const commit = this.commitOf(repo, oid);
        if (commit === undefined) continue;
        included.add(oid);
        for (const parent of commit.parents) queue.push({ oid: parent, left: allowance - 1 });
      }
    } else if (options.depth !== undefined) {
      const generation = new Map<string, number>();
      const queue: { oid: string; gen: number }[] = wants.map((oid) => ({ oid, gen: 1 }));
      let head = 0;
      while (head < queue.length) {
        const { oid, gen } = queue[head]!;
        head += 1;
        if (gen > options.depth) continue;
        const known = generation.get(oid);
        if (known !== undefined && known <= gen) continue;
        generation.set(oid, gen);
        const commit = this.commitOf(repo, oid);
        if (commit === undefined) continue;
        included.add(oid);
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    } else if (options.deepenSince !== undefined) {
      const seen = new Set<string>();
      const queue = [...wants];
      let head = 0;
      while (head < queue.length) {
        const oid = queue[head]!;
        head += 1;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        const commit = this.commitOf(repo, oid);
        if (object === undefined || commit === undefined) continue;
        if (commitTime(object.data) <= options.deepenSince) continue;
        included.add(oid);
        for (const parent of commit.parents) queue.push(parent);
      }
    } else {
      for (const want of wants) {
        for (const oid of this.ancestors(repo, want)) included.add(oid);
      }
    }
    for (const oid of haveCommits) included.delete(oid);
    for (const oid of clientShallow) included.delete(oid);

    const objects = new Map<string, GitObject>();
    for (const oid of included) {
      const closure = new Set<string>();
      this.collectTreeClosure(repo, oid, closure);
      for (const member of closure) {
        if (haveObjects.has(member)) continue;
        const object = repo.objects.get(member);
        if (object !== undefined) objects.set(member, object);
      }
    }
    // Boundary: an included commit with a parent the client will not hold.
    const shallow: string[] = [];
    for (const oid of included) {
      const commit = this.commitOf(repo, oid);
      if (commit === undefined) continue;
      const cut = commit.parents.some((parent) => !included.has(parent) && !haveCommits.has(parent) && this.commitOf(repo, parent) !== undefined);
      if (cut) shallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const oid of clientShallow) {
      const commit = this.commitOf(repo, oid);
      if (commit === undefined) continue;
      const complete = commit.parents.every((parent) => included.has(parent) || haveCommits.has(parent));
      if (complete && !shallow.includes(oid)) unshallow.push(oid);
    }
    return { commits: included, objects, shallow, unshallow };
  }

  /** Add a commit and its full tree closure to `out`. */
  collectTreeClosure(repo: RepoState, commitOid: string, out: Set<string>): void {
    const commit = this.commitOf(repo, commitOid);
    if (commit === undefined) return;
    out.add(commitOid);
    const walk = (treeOid: string, depth: number): void => {
      if (depth > 100 || out.has(treeOid)) return;
      const object = repo.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return;
      out.add(treeOid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') walk(entry.oid, depth + 1);
        else out.add(entry.oid);
      }
    };
    walk(commit.tree, 0);
  }
}

/** Line-level diff counts via LCS with a size cap (falls back to set counts). */
export function lineDiff(fromLines: string[], toLines: string[]): { additions: number; deletions: number } {
  if (fromLines.length * toLines.length > 4000000) {
    const fromSet = new Map<string, number>();
    for (const line of fromLines) fromSet.set(line, (fromSet.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of toLines) {
      const count = fromSet.get(line) ?? 0;
      if (count > 0) fromSet.set(line, count - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const count of fromSet.values()) deletions += count;
    return { additions, deletions };
  }
  const m = fromLines.length;
  const n = toLines.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = fromLines[i] === toLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1]! + 1
        : Math.max(dp[(i + 1) * (n + 1) + j]!, dp[i * (n + 1) + j + 1]!);
    }
  }
  const common = dp[0]!;
  return { additions: n - common, deletions: m - common };
}

export { ZERO_OID };
