// A small GraphQL engine for the v4 surface: a tokenizer and parser for the
// document shapes the clients send (operations, variables, aliases, inline
// and named fragments, input objects, enums, lists), and an executor over
// the shared Forge store with global ids, cursor connections and the five
// mutations the suite exercises. Unknown fields produce errors that name the
// field, as the protocol requires.
import { Forge, ForgeError, type IssueRec, type PullRec, type RepoState } from './store.ts';

// ------------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selection: FieldNode[] | null;
  fragment: string | null; // set for spreads: '...' handled during parse
  inlineType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: FieldNode[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:@$=!|&'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${c}`);
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: FieldNode[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const kind = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        // Directives on the operation are skipped.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({ kind, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selection = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selection });
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }
  skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      if (token === ')' || token === ']' || token === '}') depth -= 1;
    } while (depth > 0);
  }
  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        return { name: '', alias: null, args: [], selection: this.parseSelectionSet(), fragment: null, inlineType: typeCondition };
      }
      const fragName = this.next();
      return { name: '', alias: null, args: [], selection: null, fragment: fragName, inlineType: null };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    // Skip directives.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
    let selection: FieldNode[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection, fragment: null, inlineType: null };
  }
  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

// ----------------------------------------------------------------- executor

type GqlObject = { __type: string; [key: string]: unknown };

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  document: Document;
  errors: { message: string }[];
}

function resolveValue(ctx: ExecContext, value: Value): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(ctx, entry));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(ctx, field.value);
      return out;
    }
  }
}

function argsOf(ctx: ExecContext, node: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of node.args) out[arg.name] = resolveValue(ctx, arg.value);
  return out;
}

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const split = raw.indexOf(':');
    if (split === -1) return null;
    return { type: raw.slice(0, split), key: raw.slice(split + 1) };
  } catch {
    return null;
  }
}

function repoObject(repo: RepoState): GqlObject {
  return { __type: 'Repository', repo };
}

function issueObject(repo: RepoState, issue: IssueRec): GqlObject {
  return { __type: 'Issue', repo, issue };
}

function pullObject(repo: RepoState, pull: PullRec): GqlObject {
  return { __type: 'PullRequest', repo, pull };
}

function userObject(forge: Forge): GqlObject {
  const viewer = forge.viewer();
  return { __type: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email };
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetFor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

function connection<T>(items: T[], args: Record<string, unknown>, wrap: (item: T) => GqlObject): GqlObject {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const start = offsetFor(args.after);
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  return {
    __type: 'Connection',
    nodes: slice.map(wrap),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      endCursor: slice.length > 0 ? cursorFor(start + slice.length) : null,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
    },
    totalCount: items.length,
  };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'url', 'author', 'repository', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color'],
  Ref: ['id', 'name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeObject(name: string): GqlObject | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      kind: 'OBJECT',
      fields: TYPE_FIELDS[name]!.map((field) => ({ __type: '__Field', name: field })),
      enumValues: null,
    };
  }
  if (TYPE_ENUMS[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: TYPE_ENUMS[name]!.map((value) => ({ __type: '__EnumValue', name: value })),
    };
  }
  if (name === 'Query' || name === 'Mutation') {
    return { __type: '__Type', name, kind: 'OBJECT', fields: [], enumValues: null };
  }
  return null;
}

function executeSelection(ctx: ExecContext, parent: GqlObject, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.fragment !== null) {
      const fragment = ctx.document.fragments.get(node.fragment);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === parent.__type)) {
        Object.assign(out, executeSelection(ctx, parent, fragment.selection));
      }
      continue;
    }
    if (node.inlineType !== null) {
      if (node.inlineType === parent.__type || node.inlineType === 'Node') {
        Object.assign(out, executeSelection(ctx, parent, node.selection ?? []));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    out[key] = executeField(ctx, parent, node);
  }
  return out;
}

function executeField(ctx: ExecContext, parent: GqlObject, node: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(ctx, node);
  const name = node.name;
  if (name === '__typename') return parent.__type;
  if (PAYLOAD_MEMBERS[parent.__type] !== undefined) {
    const member = parent[name] as GqlObject | undefined;
    if (member === undefined) {
      ctx.errors.push({ message: `Field '${name}' does not exist on type '${parent.__type}'` });
      return null;
    }
    return node.selection === null ? member : executeSelection(ctx, member, node.selection);
  }
  const sub = (value: GqlObject | null): unknown => {
    if (value === null) return null;
    if (node.selection === null) return value;
    return executeSelection(ctx, value, node.selection);
  };
  const subList = (values: GqlObject[]): unknown => values.map((value) => (node.selection === null ? value : executeSelection(ctx, value, node.selection)));

  switch (parent.__type) {
    case 'Query': {
      if (name === 'viewer') return sub(userObject(forge));
      if (name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return sub(repo === undefined ? null : repoObject(repo));
      }
      if (name === 'node') return sub(nodeById(ctx, String(args.id ?? '')));
      if (name === '__type') return sub(typeObject(String(args.name ?? '')));
      if (name === '__schema') return sub({ __type: '__Schema' });
      break;
    }
    case 'Mutation': {
      return mutation(ctx, name, args, node);
    }
    case 'User': {
      const user = parent as { login: string; id: number; name: string; email: string };
      if (name === 'login') return user.login;
      if (name === 'id') return globalId('User', String(user.id));
      if (name === 'databaseId') return user.id;
      if (name === 'name') return user.name;
      if (name === 'email') return user.email;
      if (name === 'url') return `https://forge.invalid/${user.login}`;
      break;
    }
    case 'Repository': {
      const repo = parent.repo as RepoState;
      switch (name) {
        case 'id':
          return globalId('Repository', String(repo.id));
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return sub(userObject(forge));
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'defaultBranchRef': {
          const tip = forge.branchTip(repo, repo.defaultBranch);
          if (tip === undefined) return null;
          return sub({ __type: 'Ref', name: repo.defaultBranch, target: { __type: 'Commit', oid: tip } });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://forge.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'issue': {
          const issue = repo.issueByNumber.get(Number(args.number));
          return sub(issue === undefined ? null : issueObject(repo, issue));
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = Array.isArray(args.states) ? args.states.map((state) => String(state)) : null;
          if (states !== null) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          list.sort((a, b) => a.number - b.number);
          if (orderBy.direction === 'DESC') list.reverse();
          return sub(connection(list, args, (issue) => issueObject(repo, issue)));
        }
        case 'pullRequest': {
          const pull = repo.pullByNumber.get(Number(args.number));
          return sub(pull === undefined ? null : pullObject(repo, pull));
        }
        case 'pullRequests': {
          let list = [...repo.pullByNumber.values()].sort((a, b) => a.number - b.number);
          const states = Array.isArray(args.states) ? args.states.map((state) => String(state)) : null;
          if (states !== null) {
            list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          return sub(connection(list, args, (pull) => pullObject(repo, pull)));
        }
      }
      break;
    }
    case 'Issue': {
      const repo = parent.repo as RepoState;
      const issue = parent.issue as IssueRec;
      switch (name) {
        case 'id':
          return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'url':
          return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author':
          return sub(userObject(forge));
        case 'repository':
          return sub(repoObject(repo));
        case 'labels':
          return sub(connection(issue.labels, args, (label) => ({ __type: 'Label', name: label, color: repo.labels.get(label)?.color ?? 'ededed' })));
        case 'comments':
          return sub(connection(issue.comments, args, (comment) => ({ __type: 'Comment', id: globalId('Comment', `${repo.id}:${comment.id}`), body: comment.body })));
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
      }
      break;
    }
    case 'PullRequest': {
      const repo = parent.repo as RepoState;
      const pull = parent.pull as PullRec;
      switch (name) {
        case 'id':
          return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.merged ? 'UNKNOWN' : forge.pullRequestMergeability(repo, pull.head, pull.base);
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'url':
          return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'author':
          return sub(userObject(forge));
        case 'repository':
          return sub(repoObject(repo));
        case 'files': {
          const headTip = forge.branchTip(repo, pull.head);
          const baseTip = forge.branchTip(repo, pull.base);
          let paths: string[] = [];
          if (headTip !== undefined && baseTip !== undefined) {
            const ancestor = forge.mergeBase(repo, headTip, baseTip);
            if (ancestor !== null) {
              const diff = forge.diffTrees(repo, forge.readTreeFlat(repo, ancestor), forge.readTreeFlat(repo, headTip));
              paths = [...diff.keys()];
            }
          }
          return sub(connection(paths, args, (path) => ({ __type: 'PullRequestChangedFile', path })));
        }
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return parent.name;
      if (name === 'id') return globalId('Ref', String(parent.name));
      if (name === 'target') {
        const target = parent.target as GqlObject;
        return node.selection === null ? target : executeSelection(ctx, target, node.selection);
      }
      break;
    }
    case 'Commit': {
      if (name === 'oid') return parent.oid;
      if (name === 'id') return globalId('Commit', String(parent.oid));
      break;
    }
    case 'Connection': {
      if (name === 'nodes') return subList(parent.nodes as GqlObject[]);
      if (name === 'pageInfo') return sub(parent.pageInfo as GqlObject);
      if (name === 'totalCount') return parent.totalCount;
      if (name === 'edges') {
        const nodes = parent.nodes as GqlObject[];
        return nodes.map((entry) => ({ node: node.selection === null ? entry : executeSelection(ctx, { __type: 'Edge', node: entry }, node.selection) }));
      }
      break;
    }
    case 'Edge': {
      if (name === 'node') {
        const inner = parent.node as GqlObject;
        return node.selection === null ? inner : executeSelection(ctx, inner, node.selection);
      }
      if (name === 'cursor') return cursorFor(0);
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage;
      if (name === 'hasPreviousPage') return parent.hasPreviousPage;
      if (name === 'endCursor') return parent.endCursor;
      if (name === 'startCursor') return parent.startCursor;
      break;
    }
    case 'Comment': {
      if (name === 'id') return parent.id;
      if (name === 'body') return parent.body;
      if (name === 'author') return sub(userObject(forge));
      if (name === 'createdAt') return '2026-01-01T00:00:00Z';
      break;
    }
    case 'Label': {
      if (name === 'name') return parent.name;
      if (name === 'color') return parent.color;
      if (name === 'id') return globalId('Label', String(parent.name));
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return parent.path;
      break;
    }
    case '__Type': {
      if (name === 'name') return parent.name;
      if (name === 'kind') return parent.kind;
      if (name === 'fields') {
        const fields = parent.fields as GqlObject[] | null;
        if (fields === null) return null;
        return fields.map((field) => (node.selection === null ? field : executeSelection(ctx, field, node.selection)));
      }
      if (name === 'enumValues') {
        const values = parent.enumValues as GqlObject[] | null;
        if (values === null) return null;
        return values.map((value) => (node.selection === null ? value : executeSelection(ctx, value, node.selection)));
      }
      break;
    }
    case '__Field': {
      if (name === 'name') return parent.name;
      if (name === 'type') return sub({ __type: '__Type', name: 'String', kind: 'SCALAR', fields: null, enumValues: null });
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return parent.name;
      break;
    }
  }
  ctx.errors.push({ message: `Field '${name}' does not exist on type '${parent.__type}'` });
  return null;
}

function nodeById(ctx: ExecContext, id: string): GqlObject | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const forge = ctx.forge;
  if (decoded.type === 'Repository') {
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(decoded.key));
    return repo === undefined ? null : repoObject(repo);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':').map(Number);
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    if (decoded.type === 'Issue') {
      const issue = repo.issueByNumber.get(number!);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    const pull = repo.pullByNumber.get(number!);
    return pull === undefined ? null : pullObject(repo, pull);
  }
  if (decoded.type === 'User') return userObject(forge);
  return null;
}

function repoByGlobalId(ctx: ExecContext, id: unknown): RepoState {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null || decoded.type !== 'Repository') throw new ForgeError(422, 'Invalid repository id');
  const repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === Number(decoded.key));
  if (repo === undefined) throw new ForgeError(404, 'Repository not found');
  return repo;
}

function mutation(ctx: ExecContext, name: string, args: Record<string, unknown>, node: FieldNode): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const wrap = (payload: GqlObject): unknown => (node.selection === null ? payload : executeSelection(ctx, payload, node.selection));
  try {
    switch (name) {
      case 'createIssue': {
        const repo = repoByGlobalId(ctx, input.repositoryId);
        const issue = forge.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          labels: [],
        });
        return wrap({ __type: 'CreateIssuePayload', issue: issueObject(repo, issue) });
      }
      case 'closeIssue': {
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null || decoded.type !== 'Issue') throw new ForgeError(422, 'Invalid issue id');
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === repoId);
        const issue = repo?.issueByNumber.get(number!);
        if (repo === undefined || issue === undefined) throw new ForgeError(404, 'Issue not found');
        issue.state = 'closed';
        forge.touch(repo);
        return wrap({ __type: 'CloseIssuePayload', issue: issueObject(repo, issue) });
      }
      case 'createPullRequest': {
        const repo = repoByGlobalId(ctx, input.repositoryId);
        const pull = forge.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        return wrap({ __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) });
      }
      case 'mergePullRequest': {
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null || decoded.type !== 'PullRequest') throw new ForgeError(422, 'Invalid pull request id');
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === repoId);
        const pull = repo?.pullByNumber.get(number!);
        if (repo === undefined || pull === undefined) throw new ForgeError(404, 'Pull request not found');
        const sha = forge.squashMerge(repo, pull.head, pull.base, pull.title);
        if (sha === null) throw new ForgeError(405, 'Pull Request is not mergeable');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = forge.nowIso();
        pull.mergeCommitSha = sha;
        forge.touch(repo);
        return wrap({ __type: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) });
      }
      case 'addComment': {
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null || decoded.type !== 'Issue') throw new ForgeError(422, 'Invalid subject id');
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === repoId);
        const issue = repo?.issueByNumber.get(number!);
        if (repo === undefined || issue === undefined) throw new ForgeError(404, 'Subject not found');
        const comment = forge.addComment(repo, issue, String(input.body ?? ''));
        const commentObject: GqlObject = { __type: 'Comment', id: globalId('Comment', `${repo.id}:${comment.id}`), body: comment.body };
        return wrap({
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'Edge', node: commentObject },
          subject: issueObject(repo, issue),
        });
      }
    }
  } catch (error) {
    if (error instanceof ForgeError) {
      ctx.errors.push({ message: error.message });
      return null;
    }
    throw error;
  }
  ctx.errors.push({ message: `Field '${name}' does not exist on type 'Mutation'` });
  return null;
}

// Payload objects resolve their named members directly.
const PAYLOAD_MEMBERS: Record<string, string[]> = {
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge', 'subject'],
};

/** Execute one GraphQL request body; returns the response value. */
export function executeGraphQL(forge: Forge, body: { query?: string; variables?: Record<string, unknown>; operationName?: string }): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'No operation found' }] };
  const operation = body.operationName !== undefined
    ? document.operations.find((candidate) => candidate.name === body.operationName) ?? document.operations[0]!
    : document.operations[0]!;
  const ctx: ExecContext = { forge, variables: body.variables ?? {}, document, errors: [] };
  const root: GqlObject = { __type: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(ctx, root, operation.selection);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
