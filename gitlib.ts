// Git wire and object primitives: sha1 object ids, pkt-line framing, pack
// build/parse (plain objects plus ofs/ref delta application), commit and tree
// codecs. Pure functions over Buffers; no state lives here.
import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line payload too large');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'latin1');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'latin1');
}

export interface PktRead {
  lines: Buffer[];
  flush: boolean;
  delim: boolean;
  next: number;
}

/** Read pkt-lines starting at `offset` until a flush or delimiter packet. */
export function parsePktLines(buf: Buffer, offset: number): PktRead {
  const lines: Buffer[] = [];
  let pos = offset;
  let guard = 0;
  while (pos < buf.length) {
    guard += 1;
    if (guard > 100000) throw new Error('pkt-line stream too long');
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length "${head}"`);
    const length = parseInt(head, 16);
    if (length === 0) return { lines, flush: true, delim: false, next: pos + 4 };
    if (length === 1) return { lines, flush: false, delim: true, next: pos + 4 };
    if (length === 2 || length === 3) throw new Error(`reserved pkt-line length ${length}`);
    if (length < 4 || pos + length > buf.length) throw new Error('truncated pkt-line payload');
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, flush: false, delim: false, next: pos };
}

// ------------------------------------------------------------------- packs

export interface PackObject {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a complete pack (version 2, plain objects, no deltas) with trailer. */
export function buildPack(objects: { type: ObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta truncated');
      const byte = delta[pos]!;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  let guard = 0;
  while (pos < delta.length) {
    guard += 1;
    if (guard > 1000000) throw new Error('delta instruction runaway');
    const opcode = delta[pos]!;
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          offset += delta[pos]! * 2 ** (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          size += delta[pos]! * 2 ** (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode > 0) {
      out.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a pack, resolving ofs/ref deltas against the pack itself and an
 * optional base lookup. Entry boundaries are found by binary search: zlib's
 * inflate ignores trailing bytes but throws on a truncated stream, so the
 * minimal prefix that inflates is exactly the entry's compressed length.
 * Kept for tests and small ad-hoc packs; the receive path uses the faster
 * streaming parser below.
 */
export function parsePack(pack: Buffer, lookup?: (oid: string) => { type: ObjectType; data: Buffer } | undefined): PackObject[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;
  const inflateEntry = (from: number, expectedSize: number, isLast: boolean): { data: Buffer; next: number } => {
    if (isLast) {
      const out = inflateSync(pack.subarray(from, end));
      if (out.length !== expectedSize) throw new Error('pack object size mismatch');
      return { data: out, next: end };
    }
    // Exponential growth to an upper bound, then a binary search inside the
    // last interval: failed attempts inflate only partial streams, so the
    // total work stays close to two full inflates per entry.
    const attempt = (length: number): Buffer | null => {
      try {
        const out = inflateSync(pack.subarray(from, from + length));
        return out.length === expectedSize ? out : null;
      } catch {
        return null;
      }
    };
    let lo = 1;
    let hi = Math.min(end - from, 256);
    let found = attempt(hi);
    while (found === null && hi < end - from) {
      lo = hi + 1;
      hi = Math.min(end - from, hi * 2);
      found = attempt(hi);
    }
    if (found === null) throw new Error('pack entry does not inflate');
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (attempt(mid) !== null) hi = mid;
      else lo = mid + 1;
    }
    const data = attempt(lo);
    if (data === null) throw new Error('pack entry does not inflate');
    return { data, next: from + lo };
  };
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const start = pos;
    if (pos >= end) throw new Error('pack entry truncated');
    let byte = pack[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    let guard = 0;
    while (byte & 0x80) {
      guard += 1;
      if (guard > 10) throw new Error('pack entry header runaway');
      byte = pack[pos]!;
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseRef = '';
    let kind: RawEntry['type'];
    if (typeCode === 6) {
      let back = pack[pos]!;
      pos += 1;
      let value = back & 0x7f;
      guard = 0;
      while (back & 0x80) {
        guard += 1;
        if (guard > 10) throw new Error('ofs-delta header runaway');
        back = pack[pos]!;
        pos += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - value;
      kind = 'ofs';
    } else if (typeCode === 7) {
      baseRef = pack.toString('hex', pos, pos + 20);
      pos += 20;
      kind = 'ref';
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode} unknown`);
      kind = type;
    }
    const { data, next } = inflateEntry(pos, size, index === count - 1);
    pos = next;
    raw.push({ type: kind, data, offset: start, baseOffset, baseRef });
  }
  return resolveRaw(raw, lookup);
}

interface RawEntry {
  type: ObjectType | 'ofs' | 'ref';
  data: Buffer;
  offset: number;
  baseOffset: number;
  baseRef: string;
}

/** Resolve delta entries (in any order) into whole objects. */
function resolveRaw(raw: RawEntry[], lookup?: (oid: string) => { type: ObjectType; data: Buffer } | undefined): PackObject[] {
  const byOffset = new Map<number, PackObject>();
  const resolve = (entry: RawEntry, depth: number): PackObject => {
    if (depth > 100) throw new Error('delta chain too deep');
    if (entry.type !== 'ofs' && entry.type !== 'ref') {
      const done: PackObject = { type: entry.type, data: entry.data, oid: objectId(entry.type, entry.data) };
      byOffset.set(entry.offset, done);
      return done;
    }
    let base: PackObject | undefined;
    if (entry.type === 'ofs') {
      base = byOffset.get(entry.baseOffset);
      if (base === undefined) {
        const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry, depth + 1);
      }
    } else {
      base = lookup?.(entry.baseRef);
      if (base === undefined) {
        const baseEntry = raw.find((candidate) => candidate.type !== 'ofs' && candidate.type !== 'ref' && objectId(candidate.type, candidate.data) === entry.baseRef);
        if (baseEntry !== undefined) base = resolve(baseEntry, depth + 1);
      }
      if (base === undefined) throw new Error('ref-delta base missing');
    }
    const data = applyDelta(base.data, entry.data);
    const done: PackObject = { type: base.type, data, oid: objectId(base.type, data) };
    byOffset.set(entry.offset, done);
    return done;
  };
  return raw.map((entry) => resolve(entry, 0));
}

/** Inflate exactly one zlib stream; resolves with its bytes and consumption. */
function inflateOne(buf: Buffer): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.on('error', reject);
    stream.end(buf);
  });
}

/**
 * The streaming pack parser the receive path uses: one Inflate stream per
 * entry reports exactly how many compressed bytes it consumed, which is
 * several times faster than searching for boundaries with repeated sync
 * inflates.
 */
export async function parsePackAsync(pack: Buffer, lookup?: (oid: string) => { type: ObjectType; data: Buffer } | undefined): Promise<PackObject[]> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const start = pos;
    if (pos >= end) throw new Error('pack entry truncated');
    let byte = pack[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    let guard = 0;
    while (byte & 0x80) {
      guard += 1;
      if (guard > 10) throw new Error('pack entry header runaway');
      byte = pack[pos]!;
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseRef = '';
    let kind: RawEntry['type'];
    if (typeCode === 6) {
      let back = pack[pos]!;
      pos += 1;
      let value = back & 0x7f;
      guard = 0;
      while (back & 0x80) {
        guard += 1;
        if (guard > 10) throw new Error('ofs-delta header runaway');
        back = pack[pos]!;
        pos += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - value;
      kind = 'ofs';
    } else if (typeCode === 7) {
      baseRef = pack.toString('hex', pos, pos + 20);
      pos += 20;
      kind = 'ref';
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode} unknown`);
      kind = type;
    }
    const { data, consumed } = await inflateOne(pack.subarray(pos, end));
    if (data.length !== size) throw new Error('pack object size mismatch');
    pos += consumed;
    raw.push({ type: kind, data, offset: start, baseOffset, baseRef });
  }
  return resolveRaw(raw, lookup);
}

// ------------------------------------------------------------------ commits

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function serializeCommit(commit: CommitData): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** The committer timestamp (seconds) of a raw commit, 0 when unparsable. */
export function commitTime(data: Buffer): number {
  const match = /committer .* (\d+) [+-]\d{4}/.exec(data.toString('latin1'));
  return match === null ? 0 : Number(match[1]);
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'latin1'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  let guard = 0;
  while (pos < data.length) {
    guard += 1;
    if (guard > 100000) throw new Error('tree entry runaway');
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new Error('tree entry malformed');
    const mode = data.toString('latin1', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('tree entry malformed');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

