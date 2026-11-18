// A standalone GitHub-compatible forge in one Node process: git smart HTTP (v0 + v2),
// the REST v3 API, a GraphQL subset, and an MCP endpoint, all over one in-memory store.
// Standard library only; the git object model (packs, deltas, trees, shallow fetch) is
// implemented in-process with node:zlib / node:crypto.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, createInflate } from 'node:zlib';

// ---------------------------------------------------------------------------
// Scenario identity. The conformance suite derives every name from one fixed
// published seed; the token owner is the first generated user. The generator
// below is the suite's own algorithm (FNV-1a + splitmix64 + xorshift64*), so
// the viewer/teammate/stranger identities match without any configuration.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioRng(label: string): Rng {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface ForgeUser { id: number; login: string; name: string; email: string }

function generateUsers(rng: Rng, count: number): ForgeUser[] {
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = generateUsers(scenarioRng('users'), 12);
const VIEWER: ForgeUser = SCENARIO_USERS[0] as ForgeUser;

// ---------------------------------------------------------------------------
// Logical clock: deterministic timestamps. Base = MAKEFUN_TRIAL_NOW when the
// harness provides one, else a fixed epoch; a monotonic counter orders events.
// ---------------------------------------------------------------------------

function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1_735_689_600; // the scenario epoch
}

const CLOCK_BASE = parseTrialNow();
let clockCounter = 0;
function tick(): number {
  clockCounter += 1;
  return CLOCK_BASE + clockCounter;
}
function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface StoredObject { type: GitObjectType; data: Buffer }

interface CommentRec { id: number; body: string; createdAt: number; author: string }

interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  nextCommentId: number;
  createdAt: number;
  isPull: false;
}

interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  isPull: true;
}

interface RepoRec {
  key: string; // `${owner}/${name}` lowercased owner
  databaseId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  createdAt: number;
  objects: Map<string, StoredObject>;
  refs: Map<string, string>; // full ref name -> oid
  headTarget: string; // refs/heads/main
  firstBranch: string | null;
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 1;
let requestCounter = 0;

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name}`;
}

function createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec {
  const rec: RepoRec = {
    key: repoKey(owner, name),
    databaseId: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    createdAt: tick(),
    objects: new Map(),
    refs: new Map(),
    headTarget: 'refs/heads/main',
    firstBranch: null,
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  repos.set(rec.key, rec);
  return rec;
}

function findRepo(owner: string, name: string): RepoRec | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

// ---------------------------------------------------------------------------
// Git object model.
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
}

function parsePerson(line: string): { name: string; email: string; time: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', time: 0 };
  return { name: match[1] as string, email: match[2] as string, time: Number(match[3]) };
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', time: 0 };
  let committer = { name: '', email: '', time: 0 };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  return {
    tree, parents, message,
    authorName: author.name, authorEmail: author.email, authorTime: author.time,
    committerName: committer.name, committerEmail: committer.email, committerTime: committer.time,
  };
}

function buildCommit(repo: RepoRec, tree: string, parents: string[], message: string, when: number): string {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${when} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`);
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
}

interface TreeEntry { mode: string; name: string; oid: string }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('latin1', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTree(repo: RepoRec, files: Map<string, string>): string {
  // files: full path -> blob oid. Build nested trees bottom-up.
  interface Node { dirs: Map<string, Node>; files: Map<string, string> }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (next === undefined) { next = { dirs: new Map(), files: new Map() }; node.dirs.set(part, next); }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, oid);
  }
  const writeNode = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child) });
    entries.sort((a, b) => {
      const ka = a.mode === '40000' ? `${a.name}/` : a.name;
      const kb = b.mode === '40000' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.oid, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(chunks));
  };
  return writeNode(root);
}

/** Flatten a tree into path -> blob oid (recursive). */
function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** Peel an oid to a commit oid (through tag objects). Null when not committish. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('latin1'));
      if (match === null) return null;
      current = match[1] as string;
      continue;
    }
    return null;
  }
  return null;
}

/** All commit oids reachable from `tips` (following parents), with depth (1 = tip). */
function reachableCommits(repo: RepoRec, tips: string[], cutAt?: Set<string>): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: { oid: string; d: number }[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(repo, tip);
    if (commit !== null && !depth.has(commit)) { depth.set(commit, 1); queue.push({ oid: commit, d: 1 }); }
  }
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (cutAt !== undefined && cutAt.has(oid)) continue; // shallow boundary: do not follow parents
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      const existing = depth.get(parent);
      if (existing === undefined || existing > d + 1) {
        depth.set(parent, d + 1);
        queue.push({ oid: parent, d: d + 1 });
      }
    }
  }
  return depth;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const anc = peelToCommit(repo, ancestor);
  const desc = peelToCommit(repo, descendant);
  if (anc === null || desc === null) return false;
  if (anc === desc) return true;
  return reachableCommits(repo, [desc]).has(anc);
}

/** Merge-base of two commits: the common ancestor with the smallest depth from `a`. */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const fromA = reachableCommits(repo, [a]);
  const fromB = reachableCommits(repo, [b]);
  let best: string | null = null;
  let bestDepth = Infinity;
  for (const [oid, d] of fromA) {
    if (fromB.has(oid) && d < bestDepth) { best = oid; bestDepth = d; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pack files: reading (with ofs/ref deltas) and writing (plain objects).
// ---------------------------------------------------------------------------

function inflateOne(buf: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesWritten }));
    stream.on('error', reject);
    stream.end(buf.subarray(offset));
  });
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      if (op & 0x01) { cpOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { cpOffset |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x04) { cpOffset |= (delta[offset] as number) << 16; offset += 1; }
      if (op & 0x08) { cpOffset |= (delta[offset] as number) << 24; offset += 1; }
      if (op & 0x10) { cpSize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { cpSize |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x40) { cpSize |= (delta[offset] as number) << 16; offset += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return result;
}

const PACK_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Parse a pack into the repo store. Throws on malformed input. */
async function receivePack(repo: RepoRec, pack: Buffer): Promise<void> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface Pending { type: GitObjectType | 'ofs' | 'ref'; data: Buffer; baseOid?: string; baseOffset?: number; start: number }
  const pending: Pending[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeNum === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = await inflateOne(pack, offset);
    offset += inflated.consumed;
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    if (typeNum === 6) pending.push({ type: 'ofs', data: inflated.data, baseOffset, start });
    else if (typeNum === 7) pending.push({ type: 'ref', data: inflated.data, baseOid, start });
    else {
      const type = PACK_TYPE_NAMES[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      pending.push({ type, data: inflated.data, start });
    }
  }
  // Resolve in passes: plain objects first (recording start->oid), then deltas.
  const byStart = new Map<number, string>();
  const byOid = new Map<string, StoredObject>();
  const remember = (oid: string, type: GitObjectType, data: Buffer, start: number): void => {
    byStart.set(start, oid);
    byOid.set(oid, { type, data });
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  };
  let remaining = pending;
  for (let pass = 0; pass < 64 && remaining.length > 0; pass += 1) {
    const deferred: Pending[] = [];
    for (const item of remaining) {
      if (item.type !== 'ofs' && item.type !== 'ref') {
        remember(objectId(item.type, item.data), item.type, item.data, item.start);
        continue;
      }
      let base: StoredObject | undefined;
      if (item.type === 'ofs') {
        const baseOidKnown = byStart.get(item.baseOffset as number);
        if (baseOidKnown !== undefined) base = byOid.get(baseOidKnown) ?? repo.objects.get(baseOidKnown);
      } else {
        base = byOid.get(item.baseOid as string) ?? repo.objects.get(item.baseOid as string);
      }
      if (base === undefined) { deferred.push(item); continue; }
      const data = applyDelta(base.data, item.data);
      remember(objectId(base.type, data), base.type, data, item.start);
    }
    if (deferred.length === remaining.length) throw new Error('unresolvable delta base');
    remaining = deferred;
  }
  if (remaining.length > 0) throw new Error('unresolvable delta base');
}

/** Build a plain (delta-free) pack holding `oids`, in the order given. */
function buildPack(repo: RepoRec, oids: string[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  chunks.push(header);
  const typeNums: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    let size = obj.data.length;
    const first = (typeNums[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    let byte = first;
    while (size > 0) {
      headBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(byte);
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// pkt-lines.
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const prefix = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'latin1'), data]);
}
const PKT_FLUSH = Buffer.from('0000', 'latin1');
const PKT_DELIM = Buffer.from('0001', 'latin1');

interface PktFrame { kind: 'data' | 'flush' | 'delim' | 'end'; data: Buffer }

function parsePkts(buf: Buffer, start = 0): { frames: PktFrame[]; next: number } {
  const frames: PktFrame[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const hex = buf.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const length = parseInt(hex, 16);
    if (length === 0) { frames.push({ kind: 'flush', data: Buffer.alloc(0) }); offset += 4; break; }
    if (length === 1) { frames.push({ kind: 'delim', data: Buffer.alloc(0) }); offset += 4; continue; }
    if (length === 2) { frames.push({ kind: 'end', data: Buffer.alloc(0) }); offset += 4; break; }
    if (length < 4 || offset + length > buf.length) throw new Error('pkt-line overruns body');
    frames.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { frames, next: offset };
}

/** Sideband-frame a pack: band 1 packets of at most 65515 data bytes. */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  if (pack.length === 0) return out;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, offset + 65515);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git smart HTTP.
// ---------------------------------------------------------------------------

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headOid(repo: RepoRec): string | null {
  return repo.refs.get(repo.headTarget) ?? null;
}

function defaultBranchName(repo: RepoRec): string {
  const fromHead = repo.headTarget.replace(/^refs\/heads\//, '');
  if (repo.refs.has(repo.headTarget)) return fromHead;
  if (repo.firstBranch !== null) return repo.firstBranch;
  return fromHead;
}

/** The commit a tag ref peels to, for advertisement `^{}` / ls-refs `peeled:`. */
function peeledOf(repo: RepoRec, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}

const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow thin-pack multi_ack_detailed no-done symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function advertiseRefs(repo: RepoRec, service: string, version2: boolean): Buffer {
  const parts: Buffer[] = [];
  if (service === 'git-receive-pack') {
    parts.push(pktLine('# service=git-receive-pack\n'));
    parts.push(PKT_FLUSH);
    const refs = sortedRefs(repo);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
    } else {
      let first = true;
      const head = headOid(repo);
      if (head !== null) {
        parts.push(pktLine(`${head} HEAD\0${RECEIVE_CAPS}\n`));
        first = false;
      }
      for (const [ref, oid] of refs) {
        parts.push(pktLine(first ? `${oid} ${ref}\0${RECEIVE_CAPS}\n` : `${oid} ${ref}\n`));
        first = false;
        const peeled = peeledOf(repo, oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // upload-pack
  if (version2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('agent=forge/1.0\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow filter\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(PKT_FLUSH);
  const caps = `${UPLOAD_CAPS_V0.replace('symref=HEAD:refs/heads/main', `symref=HEAD:${repo.headTarget}`)}`;
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (head !== null) {
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleLsRefs(repo: RepoRec, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const headIncluded = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (head === null) {
    if (unborn && headIncluded) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${repo.headTarget}` : ''}\n`));
    }
  } else if (headIncluded) {
    let line = `${head} HEAD`;
    if (symrefs) line += ` symref-target:${repo.headTarget}`;
    parts.push(pktLine(`${line}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Objects for a fetch: depth-truncated reachable(wants) minus held(haves with shallow cuts). */
function collectFetchObjects(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  shallowList: string[],
  depthLimit: number | null,
): { oids: string[]; boundary: string[] } {
  const cut = new Set(shallowList);
  const heldCommits = reachableCommits(repo, haves, cut);
  const held = new Set<string>();
  for (const commit of heldCommits.keys()) {
    held.add(commit);
    const obj = repo.objects.get(commit);
    if (obj !== undefined && obj.type === 'commit') {
      const tree = parseCommit(obj.data).tree;
      held.add(tree);
      for (const blob of flattenTree(repo, tree).values()) held.add(blob);
      // include intermediate trees
      collectTreeObjects(repo, tree, held);
    }
  }
  const wantCommits = reachableCommits(repo, wants);
  const included = new Set<string>();
  const boundary: string[] = [];
  for (const [commit, depth] of wantCommits) {
    if (depthLimit !== null && depth > depthLimit) continue;
    if (heldCommits.has(commit)) continue;
    included.add(commit);
    const obj = repo.objects.get(commit);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    included.add(info.tree);
    collectTreeObjects(repo, info.tree, included);
    if (depthLimit !== null && depth === depthLimit && info.parents.length > 0) boundary.push(commit);
  }
  // Also include tag objects pointing at included commits (annotated tag fetch).
  for (const [, oid] of sortedRefs(repo)) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target !== null && included.has(target) && !held.has(oid)) included.add(oid);
    }
  }
  // Never re-send an object the client's haves already prove it holds.
  for (const oid of held) included.delete(oid);
  // Order: commits first (newest depth first), then trees, then blobs, then tags.
  const commits = [...included].filter((oid) => repo.objects.get(oid)?.type === 'commit');
  commits.sort((a, b) => (wantCommits.get(a) ?? 0) - (wantCommits.get(b) ?? 0));
  const rest = [...included].filter((oid) => repo.objects.get(oid)?.type !== 'commit');
  return { oids: [...commits, ...rest], boundary };
}

function collectTreeObjects(repo: RepoRec, treeOid: string, into: Set<string>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

const packCache = new Map<string, { pack: Buffer; boundary: string[] }>();

function fetchPack(repo: RepoRec, wants: string[], haves: string[], shallowList: string[], depthLimit: number | null): { pack: Buffer; boundary: string[] } {
  const cacheKey = `${repo.key}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowList].sort().join(',')}|${depthLimit ?? ''}|${headOid(repo) ?? ''}|${repo.refs.size}`;
  const cached = packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { oids, boundary } = collectFetchObjects(repo, wants, haves, shallowList, depthLimit);
  const pack = buildPack(repo, oids);
  if (packCache.size > 64) packCache.clear();
  const entry = { pack, boundary };
  packCache.set(cacheKey, entry);
  return entry;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function handleFetchV2(repo: RepoRec, args: string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) req.deepen = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) req.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) req.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') req.done = true;
  }
  const parts: Buffer[] = [];
  // Acknowledgments section: only for a negotiation round (no `done` in the
  // request). A `done` request goes straight to shallow-info/packfile — real
  // git rejects an acknowledgments section there ("expected 'packfile'").
  if (!req.done) {
    const heldCommits = reachableCommits(repo, req.haves, new Set(req.shallow));
    const common = req.haves.filter((have) => {
      const commit = peelToCommit(repo, have);
      return commit !== null && heldCommits.has(commit);
    });
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of common) parts.push(pktLine(`ACK ${peelToCommit(repo, have) ?? have} common\n`));
      parts.push(pktLine(`ACK ${peelToCommit(repo, common[common.length - 1] as string) ?? common[common.length - 1]} ready\n`));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // shallow-info + packfile
  let depthLimit: number | null = req.deepen;
  if (req.deepenSince !== null) {
    // Convert a timestamp bound into a depth bound by walking until commits older than the bound.
    depthLimit = depthForSince(repo, req.wants, req.deepenSince);
  }
  const { pack, boundary } = fetchPack(repo, req.wants, req.haves, req.shallow, depthLimit);
  const shallowLines: string[] = [];
  if (depthLimit !== null) {
    const newBoundary = new Set(boundary);
    for (const oid of boundary) {
      if (!req.shallow.includes(oid)) shallowLines.push(`shallow ${oid}`);
    }
    for (const old of req.shallow) {
      // former boundary now interior (included in this fetch's history) -> unshallow
      const depth = reachableCommits(repo, req.wants).get(old);
      if (depth !== undefined && depth < depthLimit && !newBoundary.has(old)) shallowLines.push(`unshallow ${old}`);
    }
  }
  if (shallowLines.length > 0 || depthLimit !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function depthForSince(repo: RepoRec, wants: string[], sinceEpoch: number): number {
  const depths = reachableCommits(repo, wants);
  let max = 1;
  for (const [commit, depth] of depths) {
    const obj = repo.objects.get(commit);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).committerTime >= sinceEpoch && depth > max) max = depth;
  }
  return max;
}

function handleFetchV0(repo: RepoRec, lines: string[], packStart: number, body: Buffer): Buffer {
  const wants: string[] = [];
  let depthLimit: number | null = null;
  const haves: string[] = [];
  const shallow: string[] = [];
  // lines hold the first section (wants + caps); the remainder of the body holds haves/done.
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('deepen ')) depthLimit = Number(line.slice(7).trim());
  }
  const rest = parsePkts(body, packStart);
  for (const frame of rest.frames) {
    if (frame.kind !== 'data') continue;
    const line = frame.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depthLimit = Number(line.slice(7).trim());
  }
  const { pack, boundary } = fetchPack(repo, wants, haves, shallow, depthLimit);
  const parts: Buffer[] = [];
  if (depthLimit !== null) {
    for (const oid of boundary) {
      if (!shallow.includes(oid)) parts.push(pktLine(`shallow ${oid}\n`));
    }
  }
  parts.push(pktLine('NAK\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleReceivePack(repo: RepoRec, body: Buffer): Promise<Buffer> {
  const { frames, next } = parsePkts(body, 0);
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  for (const frame of frames) {
    if (frame.kind !== 'data') continue;
    let line = frame.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  const pack = body.subarray(next);
  let unpackOk = true;
  let unpackError = '';
  if (pack.length > 0) {
    try {
      await receivePack(repo, pack);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: Buffer[] = [];
  report.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const command of commands) {
    let ok = unpackOk;
    let reason = '';
    if (ok) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === ZERO_OID) { ok = false; reason = 'reference not found'; }
        else repo.refs.delete(command.ref);
      } else if (command.oldOid === ZERO_OID) {
        if (current !== ZERO_OID) { ok = false; reason = 'already exists'; }
        else {
          repo.refs.set(command.ref, command.newOid);
          if (command.ref.startsWith('refs/heads/') && repo.firstBranch === null) repo.firstBranch = command.ref.replace(/^refs\/heads\//, '');
        }
      } else {
        if (current !== command.oldOid) { ok = false; reason = 'non-fast-forward'; }
        else if (!isAncestor(repo, command.oldOid, command.newOid)) { ok = false; reason = 'non-fast-forward'; }
        else repo.refs.set(command.ref, command.newOid);
      }
    } else {
      reason = 'unpack failed';
    }
    report.push(pktLine(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBody = Buffer.concat(report);
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < reportBody.length) {
    const chunk = reportBody.subarray(offset, offset + 65515);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Shared views.
// ---------------------------------------------------------------------------

function userView(user: ForgeUser): Record<string, unknown> {
  return { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User' };
}

function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: globalId('Repository', String(repo.databaseId)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    default_branch: defaultBranchName(repo),
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.createdAt),
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.local/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge.local:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + issue.number,
    node_id: globalId('Issue', `${repo.databaseId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? '' };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.createdAt),
    closed_at: null,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentView(repo: RepoRec, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + issue.number * 1000 + comment.id,
    node_id: globalId('Comment', `${repo.databaseId}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: comment.author, id: VIEWER.id, type: 'User' },
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.createdAt),
  };
}

function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: repo.databaseId * 1_000_000 + pull.number,
    node_id: globalId('PullRequest', `${repo.databaseId}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? null : computeMergeable(repo, pull) !== 'CONFLICTING',
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.createdAt),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** Line-based diff counts between two blobs (LCS over lines; fixture files are small). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) {
    // Fallback for very large files: count all lines as changed.
    return { additions: n, deletions: m };
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: n - common, deletions: m - common };
}

interface FileChange { filename: string; status: string; additions: number; deletions: number; changes: number }

function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] | null {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return null;
  const base = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  const filesOf = (commit: string): Map<string, string> => {
    const obj = repo.objects.get(commit);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return flattenTree(repo, parseCommit(obj.data).tree);
  };
  const mbFiles = filesOf(base);
  const headFiles = filesOf(headCommit);
  const textOf = (oid: string | undefined): string => {
    if (oid === undefined) return '';
    const obj = repo.objects.get(oid);
    return obj === undefined ? '' : obj.data.toString('utf8');
  };
  const changes: FileChange[] = [];
  const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = mbFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    const { additions, deletions } = lineDiff(textOf(before), textOf(after));
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

function computeMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return 'UNKNOWN';
  const base = mergeBase(repo, baseCommit, headCommit);
  if (base === null) return 'CONFLICTING';
  const filesOf = (commit: string): Map<string, string> => {
    const obj = repo.objects.get(commit);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return flattenTree(repo, parseCommit(obj.data).tree);
  };
  const mbFiles = filesOf(base);
  const headFiles = filesOf(headCommit);
  const baseFiles = filesOf(baseCommit);
  const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const headChanged = headFiles.get(path) !== mbFiles.get(path);
    const baseChanged = baseFiles.get(path) !== mbFiles.get(path);
    if (headChanged && baseChanged && headFiles.get(path) !== baseFiles.get(path)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge a pull request. Returns the merge commit sha, or null on conflict. */
function squashMerge(repo: RepoRec, pull: PullRec): string | null {
  if (computeMergeable(repo, pull) === 'CONFLICTING') return null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headCommit = peelToCommit(repo, headTip) as string;
  const baseCommit = peelToCommit(repo, baseTip) as string;
  const base = mergeBase(repo, baseCommit, headCommit) as string;
  const filesOf = (commit: string): Map<string, string> => {
    const obj = repo.objects.get(commit);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return flattenTree(repo, parseCommit(obj.data).tree);
  };
  const mbFiles = filesOf(base);
  const headFiles = filesOf(headCommit);
  const result = filesOf(baseCommit);
  const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    if (headFiles.get(path) === mbFiles.get(path)) continue;
    const value = headFiles.get(path);
    if (value === undefined) result.delete(path);
    else result.set(path, value);
  }
  const tree = buildTree(repo, result);
  const when = tick();
  const sha = buildCommit(repo, tree, [baseCommit], pull.title, when);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = when;
  pull.mergeCommitSha = sha;
  return sha;
}

function normalizeBranchRef(value: string): string {
  let ref = value;
  const colon = ref.indexOf(':');
  if (colon >= 0 && !ref.startsWith('refs/')) ref = ref.slice(colon + 1);
  if (ref.startsWith('refs/heads/')) ref = ref.slice('refs/heads/'.length);
  return ref;
}

// ---------------------------------------------------------------------------
// REST v3.
// ---------------------------------------------------------------------------

interface RestResult { status: number; json?: unknown; headers?: Record<string, string> }

function restError(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveCommitRef(repo: RepoRec, ref: string): string | null {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const peeled = peelToCommit(repo, ref);
    if (peeled !== null) return peeled;
    if (repo.objects.has(ref)) return ref;
    return null;
  }
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const oid = repo.refs.get(full);
  if (oid !== undefined) return peelToCommit(repo, oid);
  return null;
}

function commitView(repo: RepoRec, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const info = obj !== undefined && obj.type === 'commit'
    ? parseCommit(obj.data)
    : { tree: '', parents: [] as string[], message: '', authorName: '', authorEmail: '', authorTime: 0, committerName: '', committerEmail: '', committerTime: 0 };
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message: info.message,
      tree: { sha: info.tree },
      author: { name: info.authorName, email: info.authorEmail, date: isoOf(info.authorTime || CLOCK_BASE) },
      committer: { name: info.committerName, email: info.committerEmail, date: isoOf(info.committerTime || CLOCK_BASE) },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

function listCommits(repo: RepoRec, startRef: string | null): Record<string, unknown>[] {
  let start: string | null = null;
  if (startRef !== null && startRef !== '') start = resolveCommitRef(repo, startRef);
  else {
    const head = headOid(repo);
    start = head === null ? null : peelToCommit(repo, head);
    if (start === null) {
      // fall back to the first branch that exists
      for (const [, oid] of sortedRefs(repo)) {
        start = peelToCommit(repo, oid);
        if (start !== null) break;
      }
    }
  }
  if (start === null) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    order.push(current);
    const obj = repo.objects.get(current);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return order.map((sha) => commitView(repo, sha));
}

/** Create a commit through the contents API. Returns {status, view} or a RestResult error. */
function contentsCommit(
  repo: RepoRec,
  path: string,
  message: string,
  branch: string | undefined,
  apply: (files: Map<string, string>) => { ok: true } | { ok: false; error: RestResult },
): RestResult & { commitSha?: string } {
  const branchName = branch !== undefined && branch !== '' ? normalizeBranchRef(branch) : defaultBranchName(repo);
  const refName = `refs/heads/${branchName}`;
  let tip = repo.refs.get(refName) ?? null;
  if (tip === null) {
    // A write to a missing branch forks it from the default branch (or from empty).
    tip = headOid(repo);
  }
  const tipCommit = tip === null ? null : peelToCommit(repo, tip);
  const files = new Map<string, string>();
  if (tipCommit !== null) {
    const obj = repo.objects.get(tipCommit);
    if (obj !== undefined && obj.type === 'commit') {
      for (const [p, oid] of flattenTree(repo, parseCommit(obj.data).tree)) files.set(p, oid);
    }
  }
  const applied = apply(files);
  if (!applied.ok) return applied.error;
  const tree = buildTree(repo, files);
  const sha = buildCommit(repo, tree, tipCommit === null ? [] : [tipCommit], message, tick());
  repo.refs.set(refName, sha);
  if (repo.firstBranch === null) repo.firstBranch = branchName;
  void path;
  return { status: 200, commitSha: sha };
}

async function handleRest(method: string, segments: string[], query: URLSearchParams, body: unknown, host: string): Promise<RestResult> {
  // segments are the path parts after /api/v3
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        json: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          installed_version: '1.0.0',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return restError(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, json: { installed_version: '1.0.0', github_services_sha: 'forge' } };
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, json: userView(VIEWER) };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      if (!isRecord(body)) return restError(400, 'Invalid request body');
      const name = str(body.name);
      if (name === undefined || name === '') return restError(422, 'Validation Failed: name is required');
      if (findRepo(VIEWER.login, name) !== null) return restError(422, 'Validation Failed: name already exists on this account');
      const rec = createRepo(VIEWER.login, name, body.private === true, str(body.description) ?? '');
      return { status: 201, json: repoView(rec) };
    }
    if (method === 'GET') {
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
      const mine = [...repos.values()].filter((rec) => rec.owner === VIEWER.login).sort((a, b) => a.databaseId - b.databaseId);
      const start = (page - 1) * perPage;
      const slice = mine.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < mine.length) {
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(mine.length / perPage)}`;
        headers.link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
      }
      return { status: 200, json: slice.map(repoView), headers };
    }
    return restError(404, 'Not Found');
  }
  if (segments[0] !== 'repos' || segments.length < 3) return restError(404, 'Not Found');
  const owner = decodeURIComponent(segments[1] as string);
  const repoName = decodeURIComponent(segments[2] as string);
  const repo = findRepo(owner, repoName);
  if (repo === null || repo.owner !== owner) return restError(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoView(repo) };
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          repos.delete(repo.key);
          repo.name = body.name;
          repo.key = repoKey(repo.owner, repo.name);
          repos.set(repo.key, repo);
        }
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      return { status: 200, json: repoView(repo) };
    }
    if (method === 'DELETE') {
      repos.delete(repo.key);
      return { status: 204 };
    }
    return restError(404, 'Not Found');
  }

  // ---- branches & git refs ----
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: peelToCommit(repo, oid) ?? oid }, protected: false }));
      branches.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, json: branches };
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1] as string);
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return restError(404, 'Branch not found');
      return { status: 200, json: { name: branch, commit: { sha: peelToCommit(repo, oid) ?? oid }, protected: false } };
    }
    return restError(404, 'Not Found');
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        return {
          status: 200,
          json: sortedRefs(repo).map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } })),
        };
      }
      if (method === 'POST') {
        if (!isRecord(body)) return restError(400, 'Invalid request body');
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (ref === undefined || sha === undefined) return restError(422, 'Validation Failed: ref and sha are required');
        if (!repo.objects.has(sha)) return restError(422, 'Validation Failed: sha does not exist');
        if (repo.refs.has(ref)) return restError(422, 'Validation Failed: Reference already exists');
        repo.refs.set(ref, sha);
        if (ref.startsWith('refs/heads/') && repo.firstBranch === null) repo.firstBranch = ref.slice('refs/heads/'.length);
        return { status: 201, json: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
      }
      return restError(404, 'Not Found');
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return restError(404, 'Reference not found');
      return { status: 200, json: { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } } };
    }
    return restError(404, 'Not Found');
  }

  // ---- commits ----
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    return { status: 200, json: listCommits(repo, query.get('sha')) };
  }

  // ---- contents ----
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') {
      const refParam = query.get('ref');
      const commit = refParam !== null && refParam !== '' ? resolveCommitRef(repo, refParam) : (() => {
        const head = headOid(repo);
        return head === null ? null : peelToCommit(repo, head);
      })();
      if (commit === null) return restError(404, 'Not Found');
      const commitObj = repo.objects.get(commit);
      if (commitObj === undefined || commitObj.type !== 'commit') return restError(404, 'Not Found');
      const rootTree = parseCommit(commitObj.data).tree;
      // Walk to the target.
      let currentTree = rootTree;
      let found: { oid: string; isTree: boolean } | null = path === '' ? { oid: rootTree, isTree: true } : null;
      if (path !== '') {
        const parts = path.split('/');
        let tree = rootTree;
        for (let i = 0; i < parts.length; i += 1) {
          const treeObj = repo.objects.get(tree);
          if (treeObj === undefined || treeObj.type !== 'tree') { found = null; break; }
          const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
          if (entry === undefined) { found = null; break; }
          if (i === parts.length - 1) found = { oid: entry.oid, isTree: entry.mode === '40000' };
          else if (entry.mode === '40000') tree = entry.oid;
          else { found = null; break; }
        }
        currentTree = tree;
        void currentTree;
      }
      if (found === null) return restError(404, 'Not Found');
      const name = path === '' ? '' : (path.split('/').pop() as string);
      if (!found.isTree) {
        const blob = repo.objects.get(found.oid);
        if (blob === undefined) return restError(404, 'Not Found');
        return {
          status: 200,
          json: {
            type: 'file', name, path, sha: found.oid, size: blob.data.length,
            encoding: 'base64', content: blob.data.toString('base64'),
          },
        };
      }
      const treeObj = repo.objects.get(found.oid);
      if (treeObj === undefined || treeObj.type !== 'tree') return restError(404, 'Not Found');
      const entries = parseTree(treeObj.data).map((entry) => {
        const isDir = entry.mode === '40000';
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const child = repo.objects.get(entry.oid);
        return {
          type: isDir ? 'dir' : 'file', name: entry.name, path: childPath, sha: entry.oid,
          size: isDir ? 0 : (child?.data.length ?? 0),
        };
      });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, json: entries };
    }
    if (method === 'PUT') {
      if (!isRecord(body)) return restError(400, 'Invalid request body');
      const message = str(body.message);
      const content = str(body.content);
      if (message === undefined || content === undefined) return restError(422, 'Validation Failed: message and content are required');
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content, 'base64');
      } catch {
        return restError(422, 'Validation Failed: content is not base64');
      }
      const expectedSha = str(body.sha);
      let created = false;
      const result = contentsCommit(repo, path, message, str(body.branch), (files) => {
        const existing = files.get(path);
        created = existing === undefined;
        if (existing !== undefined && expectedSha !== undefined && expectedSha !== existing) {
          return { ok: false, error: restError(409, 'Conflict: sha does not match the current blob') };
        }
        files.set(path, storeObject(repo, 'blob', bytes));
        return { ok: true };
      });
      if (result.commitSha === undefined) return result;
      const blobOid = objectId('blob', bytes);
      return {
        status: created ? 201 : 200,
        json: {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha },
        },
      };
    }
    if (method === 'DELETE') {
      if (!isRecord(body)) return restError(400, 'Invalid request body');
      const message = str(body.message);
      const sha = str(body.sha);
      if (message === undefined || sha === undefined) return restError(422, 'Validation Failed: message and sha are required');
      const result = contentsCommit(repo, path, message, str(body.branch), (files) => {
        const existing = files.get(path);
        if (existing === undefined) return { ok: false, error: restError(404, 'Not Found') };
        if (existing !== sha) return { ok: false, error: restError(409, 'Conflict: sha does not match the current blob') };
        files.delete(path);
        return { ok: true };
      });
      if (result.commitSha === undefined) return result;
      return { status: 200, json: { content: null, commit: { sha: result.commitSha } } };
    }
    return restError(404, 'Not Found');
  }

  // ---- labels ----
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      if (!isRecord(body)) return restError(400, 'Invalid request body');
      const name = str(body.name);
      if (name === undefined || name === '') return restError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return restError(422, 'Validation Failed: name already exists');
      const label = { name, color: str(body.color) ?? '000000', description: str(body.description) ?? '' };
      repo.labels.set(name, label);
      return { status: 201, json: { id: repo.databaseId * 1000 + repo.labels.size, name: label.name, color: label.color, description: label.description, default: false } };
    }
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, json: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description, default: false })) };
    }
    return restError(404, 'Not Found');
  }

  // ---- issues ----
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!isRecord(body)) return restError(400, 'Invalid request body');
        const title = str(body.title);
        if (title === undefined || title === '') return restError(422, 'Validation Failed: title is required');
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const entry of body.labels) {
            const labelName = typeof entry === 'string' ? entry : (isRecord(entry) ? str(entry.name) : undefined);
            if (labelName === undefined) continue;
            if (!repo.labels.has(labelName)) return restError(422, `Validation Failed: label "${labelName}" does not exist`);
            labelNames.push(labelName);
          }
        }
        const issue: IssueRec = {
          number: repo.nextNumber, title, body: str(body.body) ?? '', state: 'open',
          labels: labelNames, comments: [], nextCommentId: 1, createdAt: tick(), isPull: false,
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return { status: 201, json: issueView(repo, issue) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return { status: 200, json: list.map((issue) => issueView(repo, issue)) };
      }
      return restError(404, 'Not Found');
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return restError(404, 'Not Found');
      if (method === 'GET') return { status: 200, json: issueView(repo, issue) };
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
        }
        return { status: 200, json: issueView(repo, issue) };
      }
      return restError(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return restError(404, 'Not Found');
      if (method === 'POST') {
        if (!isRecord(body)) return restError(400, 'Invalid request body');
        const text = str(body.body);
        if (text === undefined) return restError(422, 'Validation Failed: body is required');
        const comment: CommentRec = { id: issue.nextCommentId, body: text, createdAt: tick(), author: repo.owner };
        issue.nextCommentId += 1;
        issue.comments.push(comment);
        return { status: 201, json: commentView(repo, issue, comment) };
      }
      if (method === 'GET') {
        return { status: 200, json: issue.comments.map((comment) => commentView(repo, issue, comment)) };
      }
      return restError(404, 'Not Found');
    }
    return restError(404, 'Not Found');
  }

  // ---- pulls ----
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!isRecord(body)) return restError(400, 'Invalid request body');
        const title = str(body.title);
        const headRaw = str(body.head);
        const baseRaw = str(body.base);
        if (title === undefined || headRaw === undefined || baseRaw === undefined) {
          return restError(422, 'Validation Failed: title, head and base are required');
        }
        const headRef = normalizeBranchRef(headRaw);
        const baseRef = normalizeBranchRef(baseRaw);
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined) return restError(422, `Validation Failed: head branch "${headRef}" does not exist`);
        if (baseSha === undefined) return restError(422, `Validation Failed: base branch "${baseRef}" does not exist`);
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
            return restError(422, 'Validation Failed: a pull request already exists for this branch combination');
          }
        }
        const pull: PullRec = {
          number: repo.nextNumber, title, body: str(body.body) ?? '', state: 'open',
          headRef, baseRef, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
          createdAt: tick(), isPull: true,
        };
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        return { status: 201, json: pullView(repo, pull) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        return { status: 200, json: list.map((pull) => pullView(repo, pull)) };
      }
      return restError(404, 'Not Found');
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2) {
      if (pull === undefined) return restError(404, 'Not Found');
      if (method === 'GET') return { status: 200, json: pullView(repo, pull) };
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
        }
        return { status: 200, json: pullView(repo, pull) };
      }
      return restError(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return restError(404, 'Not Found');
      const files = pullFiles(repo, pull);
      if (files === null) return restError(404, 'Not Found');
      return { status: 200, json: files };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return restError(404, 'Not Found');
      if (pull.state !== 'open') return restError(405, 'Pull Request is not mergeable: it is closed');
      const sha = squashMerge(repo, pull);
      if (sha === null) return restError(405, 'Pull Request is not mergeable: conflict');
      return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return restError(404, 'Not Found');
  }

  return restError(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL: global ids, a small parser, and an executor over the same store.
// ---------------------------------------------------------------------------

function globalId(type: string, payload: string): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; payload: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { type: decoded.slice(0, colon), payload: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: GqlValue }[];
  selectionSet: GqlSelection[] | null;
}
type GqlSelection =
  | GqlField
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, GqlValue>;
  selectionSet: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>;
}

function tokenizeGraphql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = source.slice(i + 3, end < 0 ? source.length : end);
        tokens.push(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') { value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)); j += 4; }
          else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push(`"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  constructor(source: string) {
    this.tokens = tokenizeGraphql(source);
  }
  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.parseArguments(); // parsed and discarded
    }
  }
  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as string;
      if (token === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') {
          name = this.next();
        }
        const variableDefaults = new Map<string, GqlValue>();
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.parseType();
            if (this.peek() === '=') {
              this.next();
              variableDefaults.set(varName, this.parseValue());
            }
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }
  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      let args: { name: string; value: GqlValue }[] = [];
      if (this.peek() === '(') args = this.parseArguments();
      this.skipDirectives();
      let selectionSet: GqlSelection[] | null = null;
      if (this.peek() === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }
  private parseArguments(): { name: string; value: GqlValue }[] {
    this.expect('(');
    const args: { name: string; value: GqlValue }[] = [];
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }
  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evalGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name];
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((entry) => evalGqlValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalGqlValue(field.value, variables);
      return out;
    }
  }
}

interface GqlObj { __type: string; data: any }

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'organization', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'private', 'viewerPermission',
    'hasIssuesEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'sshUrl',
    'createdAt', 'updatedAt', 'isEmpty', 'isFork', 'isArchived', 'isTemplate', 'visibility', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'url',
    'mergeCommit', 'additions', 'deletions', 'changedFiles', 'comments', 'commits',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl'],
  Organization: ['id', 'databaseId', 'login', 'name', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'messageHeadline', 'authoredDate', 'committedDate', 'tree', 'author', 'committer'],
  Tree: ['oid'],
  GitActor: ['name', 'email', 'date'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used', 'nodeCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergePullRequest: [],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

function userByLogin(login: string): ForgeUser {
  return SCENARIO_USERS.find((user) => user.login === login) ?? { id: 2000, login, name: login, email: `${login}@example.invalid` };
}

function repoByDatabaseId(databaseId: number): RepoRec | null {
  for (const repo of repos.values()) if (repo.databaseId === databaseId) return repo;
  return null;
}

function gqlRepo(repo: RepoRec): GqlObj {
  return { __type: 'Repository', data: repo };
}
function gqlIssue(repo: RepoRec, issue: IssueRec): GqlObj {
  return { __type: 'Issue', data: { repo, issue } };
}
function gqlPull(repo: RepoRec, pull: PullRec): GqlObj {
  return { __type: 'PullRequest', data: { repo, pull } };
}
function gqlUser(user: ForgeUser): GqlObj {
  return { __type: 'User', data: user };
}

function connectionOf(type: string, nodes: GqlObj[], hasNextPage: boolean, endCursor: string | null, startCursor: string | null, totalCount: number): GqlObj {
  return { __type: type, data: { nodes, pageInfo: { hasNextPage, hasPreviousPage: false, startCursor, endCursor }, totalCount } };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexFromCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function paginate<T>(items: T[], args: Record<string, unknown>): { page: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 30;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = indexFromCursor(args.after);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + first);
  return {
    page,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length > 0 ? cursorFor(start + page.length - 1) : (typeof args.after === 'string' ? args.after : null),
    startCursor: page.length > 0 ? cursorFor(start) : null,
  };
}

function nodeFromGlobalId(id: string): GqlObj | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByDatabaseId(Number(parsed.payload));
    return repo === null ? null : gqlRepo(repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [dbId, number] = parsed.payload.split(':').map(Number);
    const repo = repoByDatabaseId(dbId as number);
    if (repo === null) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number as number);
      return issue === undefined ? null : gqlIssue(repo, issue);
    }
    const pull = repo.pulls.get(number as number);
    return pull === undefined ? null : gqlPull(repo, pull);
  }
  if (parsed.type === 'Comment') {
    const [dbId, number, commentId] = parsed.payload.split(':').map(Number);
    const repo = repoByDatabaseId(dbId as number);
    if (repo === null) return null;
    const issue = repo.issues.get(number as number);
    const comment = issue?.comments.find((entry) => entry.id === commentId);
    if (issue === undefined || comment === undefined) return null;
    return { __type: 'IssueComment', data: { repo, issue, comment } };
  }
  if (parsed.type === 'User') {
    const user = SCENARIO_USERS.find((entry) => entry.id === Number(parsed.payload));
    return user === undefined ? null : gqlUser(user);
  }
  return null;
}

class GqlFieldError extends Error {}

function resolveGqlField(obj: GqlObj, field: string, args: Record<string, unknown>): unknown {
  const type = obj.__type;
  const known = TYPE_FIELDS[type];
  if (known !== undefined && !known.includes(field) && field !== '__typename') {
    throw new GqlFieldError(`Field '${field}' doesn't exist on type '${type}'`);
  }
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return gqlUser(VIEWER);
      if (field === 'repository') {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === null || repo.owner !== String(args.owner ?? '')) return null;
        return gqlRepo(repo);
      }
      if (field === 'node') return typeof args.id === 'string' ? nodeFromGlobalId(args.id) : null;
      if (field === 'user') {
        const login = String(args.login ?? '');
        const user = SCENARIO_USERS.find((entry) => entry.login === login);
        return user === undefined ? null : gqlUser(user);
      }
      if (field === 'organization') return null;
      if (field === 'rateLimit') {
        return { __type: 'RateLimit', data: { limit: 5000, cost: 1, remaining: 4999, resetAt: isoOf(CLOCK_BASE + 3600), used: 1, nodeCount: 0 } };
      }
      if (field === '__type') return { __type: '__Type', data: { name: String(args.name ?? '') } };
      if (field === '__schema') {
        return {
          __type: '__Schema',
          data: {
            queryType: { __type: '__Type', data: { name: 'Query' } },
            mutationType: { __type: '__Type', data: { name: 'Mutation' } },
            subscriptionType: null,
          },
        };
      }
      break;
    }
    case 'Mutation': {
      const input = isRecord(args.input) ? args.input : {};
      const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
      if (field === 'createIssue') {
        const repoObj = typeof input.repositoryId === 'string' ? nodeFromGlobalId(input.repositoryId) : null;
        if (repoObj === null || repoObj.__type !== 'Repository') throw new GqlFieldError('repository not found');
        const repo = repoObj.data as RepoRec;
        const issue: IssueRec = {
          number: repo.nextNumber, title: String(input.title ?? ''), body: String(input.body ?? ''),
          state: 'open', labels: [], comments: [], nextCommentId: 1, createdAt: tick(), isPull: false,
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return { __type: 'CreateIssuePayload', data: { issue: gqlIssue(repo, issue), clientMutationId } };
      }
      if (field === 'closeIssue' || field === 'reopenIssue' || field === 'updateIssue') {
        const issueObj = typeof input.issueId === 'string' ? nodeFromGlobalId(input.issueId) : null;
        if (issueObj === null || issueObj.__type !== 'Issue') throw new GqlFieldError('issue not found');
        const { repo, issue } = issueObj.data as { repo: RepoRec; issue: IssueRec };
        if (field === 'closeIssue') issue.state = 'closed';
        if (field === 'reopenIssue') issue.state = 'open';
        if (field === 'updateIssue') {
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'CLOSED') issue.state = 'closed';
          if (input.state === 'OPEN') issue.state = 'open';
        }
        const payloadType = field === 'closeIssue' ? 'CloseIssuePayload' : field === 'reopenIssue' ? 'ReopenIssuePayload' : 'UpdateIssuePayload';
        return { __type: payloadType, data: { issue: gqlIssue(repo, issue), clientMutationId } };
      }
      if (field === 'createPullRequest') {
        const repoObj = typeof input.repositoryId === 'string' ? nodeFromGlobalId(input.repositoryId) : null;
        if (repoObj === null || repoObj.__type !== 'Repository') throw new GqlFieldError('repository not found');
        const repo = repoObj.data as RepoRec;
        const headRef = normalizeBranchRef(String(input.headRefName ?? ''));
        const baseRef = normalizeBranchRef(String(input.baseRefName ?? ''));
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) throw new GqlFieldError('head or base branch not found');
        const pull: PullRec = {
          number: repo.nextNumber, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
          headRef, baseRef, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
          createdAt: tick(), isPull: true,
        };
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        return { __type: 'CreatePullRequestPayload', data: { pullRequest: gqlPull(repo, pull), clientMutationId } };
      }
      if (field === 'mergePullRequest') {
        const pullObj = typeof input.pullRequestId === 'string' ? nodeFromGlobalId(input.pullRequestId) : null;
        if (pullObj === null || pullObj.__type !== 'PullRequest') throw new GqlFieldError('pull request not found');
        const { repo, pull } = pullObj.data as { repo: RepoRec; pull: PullRec };
        if (pull.state === 'open') {
          const sha = squashMerge(repo, pull);
          if (sha === null) throw new GqlFieldError('pull request is not mergeable');
        }
        return { __type: 'MergePullRequestPayload', data: { pullRequest: gqlPull(repo, pull), clientMutationId } };
      }
      if (field === 'addComment') {
        const subject = typeof input.subjectId === 'string' ? nodeFromGlobalId(input.subjectId) : null;
        if (subject === null || subject.__type !== 'Issue') throw new GqlFieldError('subject not found');
        const { repo, issue } = subject.data as { repo: RepoRec; issue: IssueRec };
        const comment: CommentRec = { id: issue.nextCommentId, body: String(input.body ?? ''), createdAt: tick(), author: repo.owner };
        issue.nextCommentId += 1;
        issue.comments.push(comment);
        const node = { __type: 'IssueComment', data: { repo, issue, comment } };
        return {
          __type: 'AddCommentPayload',
          data: {
            commentEdge: { __type: 'CommentEdge', data: { node, cursor: cursorFor(issue.comments.length - 1) } },
            clientMutationId,
            subject: gqlIssue(repo, issue),
          },
        };
      }
      break;
    }
    case 'Repository': {
      const repo = obj.data as RepoRec;
      switch (field) {
        case 'id': return globalId('Repository', String(repo.databaseId));
        case 'databaseId': return repo.databaseId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return gqlUser(userByLogin(repo.owner));
        case 'description': return repo.description === '' ? null : repo.description;
        case 'isPrivate': case 'private': return repo.isPrivate;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': {
          const name = defaultBranchName(repo);
          const oid = repo.refs.get(`refs/heads/${name}`);
          if (oid === undefined) return null;
          return { __type: 'Ref', data: { repo, name, oid } };
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : gqlIssue(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as unknown[]).map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
          const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
          list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
          const { page, hasNextPage, endCursor, startCursor } = paginate(list, args);
          return connectionOf('IssueConnection', page.map((issue) => gqlIssue(repo, issue)), hasNextPage, endCursor, startCursor, list.length);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : gqlPull(repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as unknown[]).map((state) => String(state).toUpperCase()));
            list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          } else {
            list = list.filter((pull) => pull.state === 'open');
          }
          list.sort((a, b) => b.number - a.number);
          const { page, hasNextPage, endCursor, startCursor } = paginate(list, args);
          return connectionOf('PullRequestConnection', page.map((pull) => gqlPull(repo, pull)), hasNextPage, endCursor, startCursor, list.length);
        }
        case 'url': return `https://forge.local/${repo.owner}/${repo.name}`;
        case 'sshUrl': return `git@forge.local:${repo.owner}/${repo.name}.git`;
        case 'createdAt': case 'updatedAt': return isoOf(repo.createdAt);
        case 'isEmpty': return repo.refs.size === 0;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'isTemplate': return false;
        case 'visibility': return repo.isPrivate ? 'PRIVATE' : 'PUBLIC';
        case 'stargazerCount': case 'forkCount': return 0;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = obj.data as { repo: RepoRec; issue: IssueRec };
      switch (field) {
        case 'id': return globalId('Issue', `${repo.databaseId}:${issue.number}`);
        case 'databaseId': return repo.databaseId * 1_000_000 + issue.number;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'url': return `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author': return gqlUser(userByLogin(repo.owner));
        case 'repository': return gqlRepo(repo);
        case 'labels': {
          const nodes = issue.labels.map((name) => ({ __type: 'Label', data: { repo, name } }));
          return connectionOf('LabelConnection', nodes, false, null, null, nodes.length);
        }
        case 'comments': {
          const { page, hasNextPage, endCursor, startCursor } = paginate(issue.comments, args);
          return connectionOf('IssueCommentConnection', page.map((comment) => ({ __type: 'IssueComment', data: { repo, issue, comment } })), hasNextPage, endCursor, startCursor, issue.comments.length);
        }
        case 'createdAt': case 'updatedAt': return isoOf(issue.createdAt);
        case 'closedAt': return issue.state === 'closed' ? isoOf(issue.createdAt) : null;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = obj.data as { repo: RepoRec; pull: PullRec };
      const files = pullFiles(repo, pull) ?? [];
      switch (field) {
        case 'id': return globalId('PullRequest', `${repo.databaseId}:${pull.number}`);
        case 'databaseId': return repo.databaseId * 1_000_000 + pull.number;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pull.merged ? 'UNKNOWN' : computeMergeable(repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        case 'baseRefOid': return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        case 'files': {
          const { page, hasNextPage, endCursor, startCursor } = paginate(files, args);
          const nodes = page.map((file) => ({
            __type: 'PullRequestChangedFile',
            data: { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' },
          }));
          return connectionOf('PullRequestChangedFileConnection', nodes, hasNextPage, endCursor, startCursor, files.length);
        }
        case 'author': return gqlUser(userByLogin(repo.owner));
        case 'repository': return gqlRepo(repo);
        case 'createdAt': case 'updatedAt': return isoOf(pull.createdAt);
        case 'mergedAt': return pull.mergedAt === null ? null : isoOf(pull.mergedAt);
        case 'url': return `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : { __type: 'Commit', data: { repo, oid: pull.mergeCommitSha } };
        case 'additions': return files.reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return files.reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return files.length;
        case 'comments': return connectionOf('IssueCommentConnection', [], false, null, null, 0);
        case 'commits': return connectionOf('PullRequestConnection', [], false, null, null, 0);
      }
      break;
    }
    case 'User': {
      const user = obj.data as ForgeUser;
      switch (field) {
        case 'id': return globalId('User', String(user.id));
        case 'databaseId': return user.id;
        case 'login': return user.login;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'url': return `https://forge.local/${user.login}`;
        case 'avatarUrl': return '';
      }
      break;
    }
    case 'Ref': {
      const { repo, name, oid } = obj.data as { repo: RepoRec; name: string; oid: string };
      if (field === 'name') return name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return { __type: 'Commit', data: { repo, oid: peelToCommit(repo, oid) ?? oid } };
      break;
    }
    case 'Commit': {
      const { repo, oid } = obj.data as { repo: RepoRec; oid: string };
      const stored = repo.objects.get(oid);
      const info = stored !== undefined && stored.type === 'commit' ? parseCommit(stored.data) : null;
      switch (field) {
        case 'oid': return oid;
        case 'message': return info?.message ?? '';
        case 'messageHeadline': return (info?.message ?? '').split('\n')[0] ?? '';
        case 'authoredDate': return isoOf(info?.authorTime || CLOCK_BASE);
        case 'committedDate': return isoOf(info?.committerTime || CLOCK_BASE);
        case 'tree': return { __type: 'Tree', data: { oid: info?.tree ?? ZERO_OID } };
        case 'author': return { __type: 'GitActor', data: { name: info?.authorName ?? '', email: info?.authorEmail ?? '', date: isoOf(info?.authorTime || CLOCK_BASE) } };
        case 'committer': return { __type: 'GitActor', data: { name: info?.committerName ?? '', email: info?.committerEmail ?? '', date: isoOf(info?.committerTime || CLOCK_BASE) } };
      }
      break;
    }
    case 'Tree': {
      if (field === 'oid') return (obj.data as { oid: string }).oid;
      break;
    }
    case 'GitActor': {
      const actor = obj.data as { name: string; email: string; date: string };
      if (field === 'name') return actor.name;
      if (field === 'email') return actor.email;
      if (field === 'date') return actor.date;
      break;
    }
    case 'Label': {
      const { repo, name } = obj.data as { repo: RepoRec; name: string };
      const label = repo.labels.get(name);
      if (field === 'id') return globalId('Label', `${repo.databaseId}:${name}`);
      if (field === 'name') return name;
      if (field === 'color') return label?.color ?? '000000';
      if (field === 'description') return label?.description ?? null;
      break;
    }
    case 'IssueComment': {
      const { repo, issue, comment } = obj.data as { repo: RepoRec; issue: IssueRec; comment: CommentRec };
      switch (field) {
        case 'id': return globalId('Comment', `${repo.databaseId}:${issue.number}:${comment.id}`);
        case 'databaseId': return repo.databaseId * 1_000_000 + issue.number * 1000 + comment.id;
        case 'body': return comment.body;
        case 'author': return gqlUser(userByLogin(comment.author));
        case 'createdAt': case 'updatedAt': return isoOf(comment.createdAt);
      }
      break;
    }
    case 'PageInfo': {
      const info = obj.data as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field === 'hasNextPage') return info.hasNextPage;
      if (field === 'hasPreviousPage') return info.hasPreviousPage;
      if (field === 'startCursor') return info.startCursor;
      if (field === 'endCursor') return info.endCursor;
      break;
    }
    case 'RateLimit': {
      const data = obj.data as Record<string, unknown>;
      if (field in data) return data[field];
      break;
    }
    case '__Type': {
      const name = (obj.data as { name: string }).name;
      if (field === 'name') return name;
      if (field === 'kind') return TYPE_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return fields.map((fieldName) => ({ __type: '__Field', data: { name: fieldName } }));
      }
      if (field === 'enumValues') {
        const values = TYPE_ENUMS[name];
        if (values === undefined) return null;
        return values.map((valueName) => ({ __type: '__EnumValue', data: { name: valueName } }));
      }
      if (field === 'possibleTypes' || field === 'inputFields') return null;
      if (field === 'ofType') return null;
      if (field === 'specifiedByURL') return null;
      break;
    }
    case '__Field': {
      const data = obj.data as { name: string };
      if (field === 'name') return data.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return { __type: '__Type', data: { name: 'String' } };
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      const data = obj.data as { name: string };
      if (field === 'name') return data.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      const data = obj.data as Record<string, unknown>;
      if (field in data) return data[field];
      if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => ({ __type: '__Type', data: { name } }));
      if (field === 'directives') return [];
      break;
    }
    default: {
      // Connections and mutation payloads carry ready-made records.
      const data = obj.data as Record<string, unknown>;
      if (data !== null && typeof data === 'object' && field in data) {
        if (field === 'pageInfo' && isRecord(data.pageInfo)) return { __type: 'PageInfo', data: data.pageInfo };
        if (field === 'edges' && Array.isArray(data.nodes)) {
          return (data.nodes as GqlObj[]).map((node) => ({ __type: 'CommentEdge', data: { node, cursor: null } }));
        }
        return data[field];
      }
      break;
    }
  }
  throw new GqlFieldError(`Field '${field}' doesn't exist on type '${type}'`);
}

function isGqlObj(value: unknown): value is GqlObj {
  return isRecord(value) && typeof value.__type === 'string' && 'data' in value;
}

function shapeGqlValue(
  value: unknown,
  selectionSet: GqlSelection[] | null,
  doc: GqlDocument,
  variables: Record<string, unknown>,
  errors: { message: string }[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => shapeGqlValue(entry, selectionSet, doc, variables, errors));
  if (isGqlObj(value)) {
    if (selectionSet === null) return value.data === null ? null : String(value.__type);
    return executeGqlSelections(value, selectionSet, doc, variables, errors);
  }
  return value;
}

function executeGqlSelections(
  obj: GqlObj,
  selections: GqlSelection[],
  doc: GqlDocument,
  variables: Record<string, unknown>,
  errors: { message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== null && fragment.typeCondition !== obj.__type && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeGqlSelections(obj, fragment.selectionSet, doc, variables, errors));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== obj.__type && selection.typeCondition !== 'Node') continue;
      Object.assign(out, executeGqlSelections(obj, selection.selectionSet, doc, variables, errors));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj.__type;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = evalGqlValue(arg.value, variables);
    try {
      const value = resolveGqlField(obj, selection.name, args);
      out[key] = shapeGqlValue(value, selection.selectionSet, doc, variables, errors);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function executeGraphqlOperation(body: Record<string, unknown>): Record<string, unknown> {
  const queryText = typeof body.query === 'string' ? body.query : '';
  let doc: GqlDocument;
  try {
    doc = new GqlParser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = doc.operations.find((op) => operationName === null || op.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in document' }] };
  const variables: Record<string, unknown> = {};
  for (const [name, defaultValue] of operation.variableDefaults) variables[name] = evalGqlValue(defaultValue, {});
  if (isRecord(body.variables)) {
    for (const [name, value] of Object.entries(body.variables)) {
      if (value !== undefined) variables[name] = value;
    }
  }
  const root: GqlObj = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query', data: null };
  const errors: { message: string }[] = [];
  const data = executeGqlSelections(root, operation.selectionSet, doc, variables, errors);
  const result: Record<string, unknown> = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function handleGraphql(body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((entry) => (isRecord(entry) ? executeGraphqlOperation(entry) : { errors: [{ message: 'Invalid operation' }] })) };
  }
  if (!isRecord(body)) return { status: 200, json: { errors: [{ message: 'Invalid request body' }] } };
  return { status: 200, json: executeGraphqlOperation(body) };
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP).
// ---------------------------------------------------------------------------

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };

const MCP_TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function mcpToolCall(name: string, args: Record<string, unknown>): { ok: boolean; value?: unknown; error?: string } {
  const needRepo = (): RepoRec | null => {
    const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
    const repoName = typeof args.repo === 'string' ? args.repo : '';
    const repo = findRepo(owner, repoName);
    return repo !== null && repo.owner === owner ? repo : null;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return { ok: false, error: 'name is required' };
      const existing = findRepo(VIEWER.login, repoName);
      if (existing !== null) return { ok: true, value: repoView(existing) };
      const repo = createRepo(VIEWER.login, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { ok: true, value: repoView(repo) };
    }
    case 'get_repo': {
      const repo = needRepo();
      if (repo === null) return { ok: false, error: 'repository not found' };
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      const repo = needRepo();
      if (repo === null) return { ok: false, error: 'repository not found' };
      const issue: IssueRec = {
        number: repo.nextNumber, title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: [], comments: [], nextCommentId: 1, createdAt: tick(), isPull: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_issues': {
      const repo = needRepo();
      if (repo === null) return { ok: false, error: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return { ok: true, value: list.map((issue) => issueView(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = needRepo();
      if (repo === null) return { ok: false, error: 'repository not found' };
      const headRef = normalizeBranchRef(String(args.head ?? ''));
      const baseRef = normalizeBranchRef(String(args.base ?? ''));
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) return { ok: false, error: 'head or base branch not found' };
      const pull: PullRec = {
        number: repo.nextNumber, title: String(args.title ?? ''), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', headRef, baseRef, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
        createdAt: tick(), isPull: true,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { ok: true, value: pullView(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      if (repo === null) return { ok: false, error: 'repository not found' };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { ok: false, error: 'pull request not found' };
      if (pull.state !== 'open') return { ok: false, error: 'pull request is not open' };
      const sha = squashMerge(repo, pull);
      if (sha === null) return { ok: false, error: 'pull request is not mergeable' };
      return { ok: true, value: pullView(repo, pull) };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

interface McpReply { status: number; json?: unknown; session?: boolean }

function handleMcpMessage(message: Record<string, unknown>): McpReply | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  if (id === undefined || id === null) return null; // notification: no reply
  const result = (value: unknown, session = false): McpReply => ({ status: 200, json: { jsonrpc: '2.0', id, result: value }, session });
  const rpcError = (code: number, text: string): McpReply => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message: text } } });
  switch (method) {
    case 'server/discover':
      return result({
        protocolVersion: '2026-07-28',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO }, true);
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return rpcError(-32602, `unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const schema = tool.inputSchema as { required?: string[] };
      const missing = (schema.required ?? []).filter((required) => args[required] === undefined);
      if (missing.length > 0) return rpcError(-32602, `missing required argument(s): ${missing.join(', ')}`);
      const outcome = mcpToolCall(name, args);
      if (!outcome.ok) {
        return result({ content: [{ type: 'text', text: outcome.error ?? 'tool error' }], isError: true });
      }
      const text = JSON.stringify(outcome.value);
      return result({ content: [{ type: 'text', text }], structuredContent: outcome.value, isError: false });
    }
    case 'resources/list':
      return result({ resources: [] });
    case 'prompts/list':
      return result({ prompts: [] });
    default:
      return rpcError(-32601, `method not found: ${method}`);
  }
}

function handleMcp(rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.filter(isRecord).map((entry) => handleMcpMessage(entry)).filter((reply) => reply !== null);
    if (replies.length === 0) return { status: 202 };
    return { status: 200, json: replies.map((reply) => reply.json) };
  }
  if (!isRecord(parsed)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
  }
  const reply = handleMcpMessage(parsed);
  if (reply === null) return { status: 202 };
  return reply;
}

// ---------------------------------------------------------------------------
// HTTP plumbing.
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isApi = path === '/api/v3' || path.startsWith('/api/v3/');
        const isGraphql = path === '/api/graphql';
        const isMcp = path === '/mcp';
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);

        if ((isApi || isGraphql || isMcp || gitMatch !== null) && !authorized(req)) {
          requestCounter += 1;
          const headers: Record<string, string> = isApi
            ? { 'x-github-request-id': `F${requestCounter.toString(16).toUpperCase().padStart(4, '0')}` }
            : {};
          sendJson(res, 401, { message: 'Bad credentials' }, headers);
          return;
        }

        if (isGraphql) {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = (await readBody(req)).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const result = handleGraphql(parsed);
          sendJson(res, result.status, result.json);
          return;
        }

        if (isMcp) {
          if (method !== 'POST') {
            res.writeHead(405, { 'content-type': JSON_TYPE });
            res.end();
            return;
          }
          const raw = (await readBody(req)).toString('utf8');
          const reply = handleMcp(raw);
          if (reply.status === 202 || reply.json === undefined) {
            res.writeHead(202, { 'content-type': JSON_TYPE });
            res.end();
            return;
          }
          const headers: Record<string, string> = {};
          if (reply.session === true) headers['mcp-session-id'] = 'forge-session';
          sendJson(res, reply.status, reply.json, headers);
          return;
        }

        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const service = gitMatch[3] as string;
          const repo = findRepo(owner, repoName);
          if (repo === null || repo.owner !== owner) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found\n');
            return;
          }
          if (service === 'info/refs' && method === 'GET') {
            const serviceParam = url.searchParams.get('service') ?? '';
            if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
              res.writeHead(400, { 'content-type': 'text/plain' });
              res.end('unknown service\n');
              return;
            }
            const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            const body = advertiseRefs(repo, serviceParam, version2);
            res.writeHead(200, {
              'content-type': `application/x-${serviceParam}-advertisement`,
              'content-length': body.length,
              'cache-control': 'no-cache',
            });
            res.end(body);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            try {
              const { frames, next } = parsePkts(body, 0);
              const firstData = frames.find((frame) => frame.kind === 'data');
              const firstLine = firstData === undefined ? '' : firstData.data.toString('utf8').replace(/\n$/, '');
              let answer: Buffer;
              if (firstLine.startsWith('command=')) {
                const command = firstLine.slice('command='.length);
                const args: string[] = [];
                let pastDelim = false;
                for (const frame of frames) {
                  if (frame.kind === 'delim') { pastDelim = true; continue; }
                  if (frame.kind !== 'data' || !pastDelim) continue;
                  args.push(frame.data.toString('utf8').replace(/\n$/, ''));
                }
                if (command === 'ls-refs') answer = handleLsRefs(repo, args);
                else if (command === 'fetch') answer = handleFetchV2(repo, args);
                else {
                  res.writeHead(400, { 'content-type': 'text/plain' });
                  res.end('unknown command\n');
                  return;
                }
              } else {
                const lines: string[] = [];
                for (const frame of frames) {
                  if (frame.kind !== 'data') continue;
                  lines.push(frame.data.toString('utf8').replace(/\n$/, ''));
                }
                answer = handleFetchV0(repo, lines, next, body);
              }
              res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': answer.length });
              res.end(answer);
            } catch {
              res.writeHead(400, { 'content-type': 'text/plain' });
              res.end('bad request\n');
            }
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            try {
              const answer = await handleReceivePack(repo, body);
              res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': answer.length });
              res.end(answer);
            } catch {
              res.writeHead(400, { 'content-type': 'text/plain' });
              res.end('bad request\n');
            }
            return;
          }
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found\n');
          return;
        }

        if (isApi) {
          requestCounter += 1;
          const headers: Record<string, string> = { 'x-github-request-id': `F${requestCounter.toString(16).toUpperCase().padStart(4, '0')}` };
          const segments = path.slice('/api/v3'.length).split('/').filter((segment) => segment !== '');
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = (await readBody(req)).toString('utf8');
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
                return;
              }
            }
          }
          const result = await handleRest(method, segments, url.searchParams, body, req.headers.host ?? 'entry');
          if (result.status === 204) {
            res.writeHead(204, headers);
            res.end();
            return;
          }
          sendJson(res, result.status, result.json ?? {}, { ...headers, ...(result.headers ?? {}) });
          return;
        }

        if (method === 'GET' && path === '/') {
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
          else res.end();
        } catch {
          // connection already gone
        }
      }
    })();
  });
}
