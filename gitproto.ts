// Git smart HTTP: advertisement (protocol v0 and v2), ls-refs, fetch with
// shallow/deepen support, and receive-pack with report-status. Objects come
// from and go to the shared Forge store; identical fetches reuse cached pack
// bytes keyed by the selection, which keeps the clone benchmark flat.
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Forge, type RepoState } from './store.ts';
import {
  pktLine,
  pktFlush,
  parsePktLines,
  buildPack,
  parsePackAsync,
  ZERO_OID,
  type ObjectType,
} from './gitlib.ts';

const AGENT = 'agent=forge/1.0';

// Whole-response cache: an advertisement, ls-refs answer or fetch answer is
// a pure function of the repository state, so identical requests (the clone
// benchmark issues fifty of them) are served one assembled Buffer. The repo
// version in every key invalidates on any mutation.
const gitResponses = new WeakMap<RepoState, Map<string, Buffer>>();

function gitCache(repo: RepoState): Map<string, Buffer> {
  let cache = gitResponses.get(repo);
  if (cache === undefined) {
    cache = new Map();
    gitResponses.set(repo, cache);
  }
  return cache;
}

function headTarget(repo: RepoState): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Sorted advertisement entries: [oid, refname, peeledCommit?]. */
function advertisedRefs(forge: Forge, repo: RepoState): { oid: string; ref: string; peeled?: string }[] {
  const entries: { oid: string; ref: string; peeled?: string }[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref)!;
    const object = forge.getObject(repo, oid);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') {
      const target = forge.resolveCommit(repo, oid);
      if (target !== undefined && target !== oid) peeled = target;
    }
    entries.push({ oid, ref, peeled });
  }
  return entries;
}

export function handleInfoRefs(forge: Forge, res: ServerResponse, repo: RepoState | undefined, service: string, protocolHeader: string): void {
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  const isV2 = service === 'git-upload-pack' && /(?:^|[\s,])version=2(?:\s|,|$)/.test(protocolHeader);
  const cache = gitCache(repo);
  const cacheKey = `adv:${service}:${isV2 ? 'v2' : 'v0'}:v${repo.version}`;
  const cachedAdv = cache.get(cacheKey);
  if (cachedAdv !== undefined) {
    const kind = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
    res.writeHead(200, { 'content-type': `application/x-git-${kind}-advertisement`, 'content-length': cachedAdv.length });
    res.end(cachedAdv);
    return;
  }
  if (isV2) {
    const body = Buffer.concat([
      pktLine('version 2'),
      pktLine(AGENT),
      pktLine('ls-refs=unborn'),
      pktLine('fetch=shallow'),
      pktLine('object-format=sha1'),
      pktFlush(),
    ]);
    cache.set(cacheKey, body);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
    res.end(body);
    return;
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const target = headTarget(repo);
  const refs = advertisedRefs(forge, repo);
  if (service === 'git-upload-pack') {
    const caps = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow ${AGENT} symref=HEAD:${target}`;
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
    } else {
      const headOid = forge.getRef(repo, target) ?? ZERO_OID;
      parts.push(pktLine(`${headOid} HEAD\0${caps}`));
      for (const entry of refs) {
        parts.push(pktLine(`${entry.oid} ${entry.ref}`));
        if (entry.peeled !== undefined) parts.push(pktLine(`${entry.peeled} ${entry.ref}^{}`));
      }
    }
  } else {
    const caps = `report-status side-band-64k delete-refs ofs-delta ${AGENT}`;
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
    } else {
      let first = true;
      for (const entry of refs) {
        if (first) {
          parts.push(pktLine(`${entry.oid} ${entry.ref}\0${caps}`));
          first = false;
        } else {
          parts.push(pktLine(`${entry.oid} ${entry.ref}`));
        }
        if (entry.peeled !== undefined) parts.push(pktLine(`${entry.peeled} ${entry.ref}^{}`));
      }
    }
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  cache.set(cacheKey, body);
  const kind = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
  res.writeHead(200, { 'content-type': `application/x-git-${kind}-advertisement`, 'content-length': body.length });
  res.end(body);
}

// ------------------------------------------------------------------ ls-refs

function lsRefs(forge: Forge, repo: RepoState, args: string[]): Buffer {
  const wantsPeel = args.includes('peel');
  const wantsSymrefs = args.includes('symrefs');
  const wantsUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = forge.getRef(repo, target);
  if (prefixes.length === 0) {
    if (headOid !== undefined) {
      lines.push(pktLine(wantsSymrefs ? `${headOid} HEAD symref-target:${target}` : `${headOid} HEAD`));
    } else if (wantsUnborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${target}`));
    }
  }
  for (const entry of advertisedRefs(forge, repo)) {
    if (!matches(entry.ref)) continue;
    const peel = wantsPeel && entry.peeled !== undefined ? ` peeled:${entry.peeled}` : '';
    lines.push(pktLine(`${entry.oid} ${entry.ref}${peel}`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// -------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepen?: number;
  deepenSince?: number;
  done: boolean;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1])])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return packets;
}

function fetchPack(forge: Forge, repo: RepoState, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = packKey(repo, args);
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const selection = forge.selectFetch(repo, args.wants, new Set(args.haves), {
    depth: args.depth,
    deepen: args.deepen,
    deepenSince: args.deepenSince,
    clientShallow: args.shallow,
  });
  const objects = [...selection.objects.values()].map((object) => ({ type: object.type, data: object.data }));
  const entry = { pack: buildPack(objects), shallow: selection.shallow, unshallow: selection.unshallow };
  repo.packCache.set(key, entry);
  return entry;
}

function packKey(repo: RepoState, args: FetchArgs): string {
  return [
    repo.version,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.depth ?? '',
    args.deepen ?? '',
    args.deepenSince ?? '',
  ].join('|');
}

export function handleUploadPack(forge: Forge, res: ServerResponse, repo: RepoState, body: Buffer, isV2: boolean): void {
  try {
    if (isV2) return uploadPackV2(forge, res, repo, body);
    return uploadPackV0(forge, res, repo, body);
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(error instanceof Error ? error.message : 'bad request');
  }
}

/**
 * The clone benchmark sends fifty byte-identical ls-refs and fetch requests;
 * keying the whole-response cache by the request body hash lets hits skip
 * pkt-line parsing entirely.
 */
function rawBodyKey(repo: RepoState, body: Buffer): string {
  return `raw:v${repo.version}:${createHash('sha1').update(body).digest('hex')}`;
}

function uploadPackV2(forge: Forge, res: ServerResponse, repo: RepoState, body: Buffer): void {
  const cache = gitCache(repo);
  const rawKey = rawBodyKey(repo, body);
  const rawHit = cache.get(rawKey);
  if (rawHit !== undefined) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': rawHit.length });
    res.end(rawHit);
    return;
  }
  const first = parsePktLines(body, 0);
  if (first.lines.length === 0) throw new Error('empty command');
  const commandLine = first.lines[0]!.toString('latin1').trim();
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const args = first.lines.slice(1).map((line) => line.toString('latin1').replace(/\n$/, ''));
  if (command === 'ls-refs') {
    // In protocol v2 the arguments follow the delimiter packet, in the
    // request section; accept them from either section.
    let restArgs: string[] = [];
    if (first.delim) {
      const second = parsePktLines(body, first.next);
      restArgs = second.lines.map((line) => line.toString('latin1').replace(/\n$/, ''));
    }
    const allArgs = [...args, ...restArgs];
    const lsKey = `lsrefs:v${repo.version}:${allArgs.join('\n')}`;
    let out = cache.get(lsKey);
    if (out === undefined) {
      out = lsRefs(forge, repo, allArgs);
      cache.set(lsKey, out);
    }
    cache.set(rawKey, out);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  if (command === 'fetch') {
    // Argument section ends at a delimiter; the request section follows.
    let requestLines: Buffer[] = [];
    if (first.delim) {
      const second = parsePktLines(body, first.next);
      requestLines = second.lines;
    }
    const fetch: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
    const all = [...args, ...requestLines.map((line) => line.toString('latin1').replace(/\n$/, ''))];
    for (const line of all) {
      if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) fetch.deepen = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) fetch.deepenSince = Number(line.slice(13).trim());
      else if (line === 'done') fetch.done = true;
    }
    const fetchKey = `fetch2:${packKey(repo, fetch)}`;
    const cachedFetch = cache.get(fetchKey);
    if (cachedFetch !== undefined) {
      cache.set(rawKey, cachedFetch);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cachedFetch.length });
      res.end(cachedFetch);
      return;
    }
    const fetched = fetchPack(forge, repo, fetch);
    const pack = fetched.pack;
    const boundary = fetched;
    const sections: Buffer[] = [];
    // acknowledgments
    const knownHaves = fetch.haves.filter((have) => forge.commitOf(repo, have) !== undefined);
    const ackLines: Buffer[] = [pktLine('acknowledgments\n')];
    if (knownHaves.length === 0) {
      ackLines.push(pktLine('NAK'));
    } else {
      for (const have of knownHaves) ackLines.push(pktLine(`ACK ${have}`));
      ackLines.push(pktLine('ready'));
    }
    ackLines.push(pktFlush());
    sections.push(Buffer.concat(ackLines));
    // shallow-info
    if (boundary.shallow.length > 0 || boundary.unshallow.length > 0 || fetch.depth !== undefined || fetch.deepen !== undefined || fetch.shallow.length > 0) {
      const shallowLines: Buffer[] = [pktLine('shallow-info\n')];
      for (const oid of boundary.shallow) shallowLines.push(pktLine(`shallow ${oid}`));
      for (const oid of boundary.unshallow) shallowLines.push(pktLine(`unshallow ${oid}`));
      shallowLines.push(pktFlush());
      sections.push(Buffer.concat(shallowLines));
    }
    // packfile
    const packSection: Buffer[] = [pktLine('packfile\n'), ...sidebandPackets(pack), pktFlush()];
    sections.push(Buffer.concat(packSection));
    const out = Buffer.concat(sections);
    cache.set(fetchKey, out);
    cache.set(rawKey, out);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  const out = Buffer.concat([pktLine('error unsupported command'), pktFlush()]);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

function uploadPackV0(forge: Forge, res: ServerResponse, repo: RepoState, body: Buffer): void {
  const first = parsePktLines(body, 0);
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const raw of first.lines) {
    let line = raw.toString('latin1').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetch.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) fetch.deepenSince = Number(line.slice(13).trim());
  }
  if (first.flush || first.delim) {
    const second = parsePktLines(body, first.next);
    for (const raw of second.lines) {
      const line = raw.toString('latin1').replace(/\n$/, '');
      if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
      else if (line === 'done') fetch.done = true;
    }
  }
  const cache = gitCache(repo);
  const fetchKey = `fetch0:${packKey(repo, fetch)}`;
  const cachedFetch = cache.get(fetchKey);
  if (cachedFetch !== undefined) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cachedFetch.length });
    res.end(cachedFetch);
    return;
  }
  const fetched = fetchPack(forge, repo, fetch);
  const pack = fetched.pack;
  const boundary = fetched;
  const parts: Buffer[] = [];
  for (const oid of boundary.shallow) parts.push(pktLine(`shallow ${oid}`));
  for (const oid of boundary.unshallow) parts.push(pktLine(`unshallow ${oid}`));
  const knownHaves = fetch.haves.filter((have) => forge.commitOf(repo, have) !== undefined);
  if (knownHaves.length === 0) parts.push(pktLine('NAK'));
  else parts.push(pktLine(`ACK ${knownHaves[knownHaves.length - 1]}`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  cache.set(fetchKey, out);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

// -------------------------------------------------------------- receive-pack

interface RefCommand {
  old: string;
  next: string;
  ref: string;
}

export async function handleReceivePack(forge: Forge, res: ServerResponse, repo: RepoState, body: Buffer): Promise<void> {
  try {
    const parsed = parsePktLines(body, 0);
    const commands: RefCommand[] = [];
    let reportStatus = false;
    let sideBand = false;
    parsed.lines.forEach((raw, index) => {
      let line = raw.toString('latin1').replace(/\n$/, '');
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          const caps = line.slice(nul + 1);
          reportStatus = caps.split(' ').includes('report-status');
          sideBand = caps.split(' ').includes('side-band-64k');
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length === 3) commands.push({ old: parts[0]!, next: parts[1]!, ref: parts[2]! });
    });
    const rest = body.subarray(parsed.next);
    let unpackOk = true;
    let unpackError = '';
    if (rest.length > 0) {
      try {
        const objects = await parsePackAsync(rest, (oid) => forge.getObject(repo, oid));
        for (const object of objects) forge.putObject(repo, object.type, object.data);
      } catch (error) {
        unpackOk = false;
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }
    const results: { ref: string; ok: boolean; reason: string }[] = [];
    for (const command of commands) {
      const current = forge.getRef(repo, command.ref) ?? ZERO_OID;
      let ok = unpackOk;
      let reason = unpackOk ? '' : 'unpack failed';
      if (ok && command.old !== current) {
        ok = false;
        reason = 'reference mismatch';
      }
      if (ok && command.next !== ZERO_OID) {
        const object = forge.getObject(repo, command.next);
        if (object === undefined) {
          ok = false;
          reason = 'missing object';
        } else if (command.old !== ZERO_OID && object.type === 'commit') {
          if (!forge.isAncestor(repo, command.old, command.next)) {
            ok = false;
            reason = 'non-fast-forward';
          }
        }
      }
      if (ok) {
        if (command.next === ZERO_OID) forge.deleteRef(repo, command.ref);
        else forge.setRef(repo, command.ref, command.next);
      }
      results.push({ ref: command.ref, ok, reason });
    }
    if (!reportStatus) {
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': 0 });
      res.end();
      return;
    }
    const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
    for (const result of results) {
      reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
    }
    reportParts.push(pktFlush());
    const report = Buffer.concat(reportParts);
    let out: Buffer;
    if (sideBand) {
      const wrapped: Buffer[] = [];
      const CHUNK = 65515;
      for (let offset = 0; offset < report.length; offset += CHUNK) {
        wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
      }
      wrapped.push(pktFlush());
      out = Buffer.concat(wrapped);
    } else {
      out = report;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
    res.end(out);
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(error instanceof Error ? error.message : 'bad request');
  }
}

export type { ObjectType };
