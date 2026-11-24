// Chain follower (SPEC §17): keeps the registry, every claimed chain and each launched chain's
// history in memory. History comes from the program's own transactions: each one carries the
// decoded instruction and its BlockCommitted events, which are checked against the hash chain.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import bs58 from 'bs58';
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  PROGRAM_ID, pda, decodeHeader, decodeRegistry, decodeEvent, decodeIx, nextHead, balanceOf, nonceOf, keccak,
  anchorDiscriminator, type Header, type Event,
} from '../tools/chains.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ChainRow = {
  id: number;
  stage: 'claimed' | 'launched';
  holder: string;
  header: Header | null;
};

/** One committed block, JSON-safe. */
export type Block = {
  height: number;
  head: string;
  opHash: string;
  sig: string;
  time: number | null;
  op: string;
  /** Who signed (the fee payer / main actor). */
  signer: string;
  args: Record<string, string>;
  logs: { address: string; topics: string[]; data: string | null }[];
  result: string | null;
  /** Ledger addresses this block touched (base58). */
  addresses: string[];
};

type History = { blocks: Block[]; newest: string | null; verified: boolean };

const CODE_DISC = anchorDiscriminator('account', 'CodeAccount');

function argString(v: unknown): string {
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return v.length === 32 ? new PublicKey(v).toBase58() : hex(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return String(v);
}

export class Follower {
  readonly conn: Connection;
  readonly dataDir: string | null;
  registry: ReturnType<typeof decodeRegistry> | null = null;
  chains = new Map<number, ChainRow>();
  history = new Map<number, History>();
  updatedAt = 0;
  private wake: (() => void) | null = null;
  /** Refresh now (after a user's transaction lands). */
  poke() {
    this.wake?.();
  }
  private stateCache = new Map<number, { at: number; data: Buffer | null }>();
  private appsCache = new Map<number, { at: number; apps: { address: string; account: string; creator: string; len: number; codeHash: string; sealed: boolean }[] }>();

  private allAppsCache: { at: number; apps: { chain: number; address: string; account: string; creator: string; len: number; codeHash: string; sealed: boolean }[] } | null = null;

  constructor(conn: Connection, dataDir: string | null) {
    this.conn = conn;
    this.dataDir = dataDir;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      for (let id = 1; id <= 500; id++) {
        const f = `${dataDir}/history-${id}.json`;
        if (existsSync(f)) this.history.set(id, JSON.parse(readFileSync(f, 'utf8')));
      }
    }
  }

  async refresh() {
    const reg = await this.conn.getAccountInfo(pda.registry());
    if (!reg) return;
    this.registry = decodeRegistry(reg.data);
    const ids = Array.from({ length: this.registry.claimed }, (_, i) => i + 1);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const infos = await this.conn.getMultipleAccountsInfo([...batch.map(pda.asset), ...batch.map(pda.chain)]);
      batch.forEach((id, k) => {
        const asset = infos[k] as AccountInfo<Buffer> | null;
        const hdr = infos[batch.length + k] as AccountInfo<Buffer> | null;
        this.chains.set(id, {
          id,
          stage: hdr ? 'launched' : 'claimed',
          holder: asset ? new PublicKey(asset.data.subarray(1, 33)).toBase58() : '',
          header: hdr ? decodeHeader(hdr.data) : null,
        });
      });
    }
    this.updatedAt = Date.now();
  }

  /** Pulls new transactions for every launched chain whose height moved. */
  async followAll() {
    for (const row of this.chains.values()) {
      if (!row.header) continue;
      const h = this.history.get(row.id);
      const known = h?.blocks.length ? h.blocks[h.blocks.length - 1].height : 0;
      if (BigInt(known) < row.header.height) await this.follow(row.id);
    }
  }

  async follow(id: number) {
    const h: History = this.history.get(id) ?? { blocks: [], newest: null, verified: true };
    // Newest first, back to the last one we know.
    const sigs: { signature: string; err: unknown; blockTime?: number | null }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.conn.getSignaturesForAddress(pda.chain(id), { before, until: h.newest ?? undefined, limit: 1000 }, 'confirmed');
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const fresh = sigs.filter((s) => !s.err).reverse();
    for (const s of fresh) {
      const t = await this.conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!t || t.meta?.err) continue;
      const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses }).staticAccountKeys;
      const msg = t.transaction.message;
      const ixs = msg.compiledInstructions
        .filter((i) => keys[i.programIdIndex].equals(PROGRAM_ID))
        .map((i) => decodeIx(Buffer.from(i.data), i.accountKeyIndexes.map((k) => keys[k])))
        .filter((d) => d !== null);
      const events: Event[] = [];
      for (const inner of t.meta?.innerInstructions ?? []) {
        for (const i of inner.instructions) {
          if (!keys[i.programIdIndex]?.equals(PROGRAM_ID)) continue;
          const e = decodeEvent(Buffer.from(bs58.decode(i.data)));
          if (e) events.push(e);
        }
      }
      const blocks = events.filter((e): e is Extract<Event, { name: 'BlockCommitted' }> => e.name === 'BlockCommitted' && (e as { chain?: number }).chain === id);
      const logs = events.filter((e): e is Extract<Event, { name: 'GuestLog' }> => e.name === 'GuestLog' && (e as { chain?: number }).chain === id);
      const rd = (t.meta as unknown as { returnData?: { data: [string, string] } }).returnData;
      const ix = ixs.find((d) => Number(d.args.id) === id) ?? ixs[0];
      for (const b of blocks) {
        const prev = h.blocks[h.blocks.length - 1];
        if (b.height <= BigInt(prev?.height ?? 0)) continue; // already have it
        const prevHead = prev ? Buffer.from(prev.head, 'hex') : new Uint8Array(32);
        if (Number(b.height) !== (prev?.height ?? 0) + 1 || hex(nextHead(prevHead, b.height, b.opHash)) !== hex(b.head)) h.verified = false;
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(ix?.args ?? {})) if (k !== 'id' && k !== 'proof' && k !== 'bytes') args[k] = argString(v);
        if (ix?.name === 'transact') args.data = hex(ix.args.data as Uint8Array);
        const addresses = new Set<string>();
        for (const k of ['payer', 'holder', 'account', 'sender', 'creator']) if (ix?.accounts[k]) addresses.add(ix.accounts[k].toBase58());
        for (const k of ['beneficiary', 'target']) if (ix?.args[k] instanceof PublicKey) addresses.add((ix.args[k] as PublicKey).toBase58());
        if (ix?.args.address instanceof Uint8Array) addresses.add(new PublicKey(ix.args.address).toBase58());
        h.blocks.push({
          height: Number(b.height),
          head: hex(b.head),
          opHash: hex(b.opHash),
          sig: s.signature,
          time: t.blockTime ?? null,
          op: ix?.name ?? 'unknown',
          signer: keys[0].toBase58(),
          args,
          logs: logs.map((l) => ({ address: l.address.toBase58(), topics: l.topics.map(hex), data: l.data ? hex(l.data) : null })),
          result: ix?.name === 'transact' && rd ? Buffer.from(rd.data[0], 'base64').toString('hex') : null,
          addresses: [...addresses],
        });
      }
      h.newest = s.signature;
      await sleep(200);
    }
    this.history.set(id, h);
    if (this.dataDir && fresh.length) writeFileSync(`${this.dataDir}/history-${id}.json`, JSON.stringify(h));
  }

  async state(id: number): Promise<Buffer | null> {
    const c = this.stateCache.get(id);
    if (c && Date.now() - c.at < 4000) return c.data;
    const info = await this.conn.getAccountInfo(pda.state(id));
    const data = info?.data ?? null;
    this.stateCache.set(id, { at: Date.now(), data });
    return data;
  }

  /** Every ledger address seen in history, with its balance and nonce now. */
  async accounts(id: number) {
    const s = await this.state(id);
    if (!s) return [];
    const addrs = new Set<string>([pda.chain(id).toBase58()]);
    for (const b of this.history.get(id)?.blocks ?? []) for (const a of b.addresses) addrs.add(a);
    return [...addrs]
      .map((a) => {
        const k = new PublicKey(a);
        return { address: a, balance: balanceOf(s, k).toString(), nonce: nonceOf(s, k).toString(), chain: k.equals(pda.chain(id)) };
      })
      .filter((x) => x.balance !== '0' || x.nonce !== '0' || x.chain)
      .sort((x, y) => (BigInt(y.balance) > BigInt(x.balance) ? 1 : BigInt(y.balance) < BigInt(x.balance) ? -1 : 0));
  }

  async apps(id: number) {
    const c = this.appsCache.get(id);
    if (c && Date.now() - c.at < 15000) return c.apps;
    const idLe = Buffer.alloc(4);
    idLe.writeUInt32LE(id);
    const list = await this.conn.getProgramAccounts(PROGRAM_ID, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 123 },
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(CODE_DISC) } }, { memcmp: { offset: 8, bytes: bs58.encode(idLe) } }],
    });
    const apps = list
      .map(({ pubkey, account }) => {
        const d = account.data;
        return {
          address: new PublicKey(d.subarray(12, 44)).toBase58(),
          account: pubkey.toBase58(),
          creator: new PublicKey(d.subarray(44, 76)).toBase58(),
          sealed: d[85] === 1,
          len: d.readUInt32LE(86),
          codeHash: hex(d.subarray(90, 122)),
        };
      })
      .filter((a) => a.sealed);
    this.appsCache.set(id, { at: Date.now(), apps });
    return apps;
  }

  /** Every sealed app on every chain, in one call. */
  async allApps() {
    const c = this.allAppsCache;
    if (c && Date.now() - c.at < 15000) return c.apps;
    const list = await this.conn.getProgramAccounts(PROGRAM_ID, {
      commitment: 'confirmed',
      dataSlice: { offset: 0, length: 123 },
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(CODE_DISC) } }],
    });
    const apps = list
      .map(({ pubkey, account }) => {
        const d = account.data;
        return {
          chain: d.readUInt32LE(8),
          address: new PublicKey(d.subarray(12, 44)).toBase58(),
          account: pubkey.toBase58(),
          creator: new PublicKey(d.subarray(44, 76)).toBase58(),
          sealed: d[85] === 1,
          len: d.readUInt32LE(86),
          codeHash: hex(d.subarray(90, 122)),
        };
      })
      .filter((a) => a.sealed);
    this.allAppsCache = { at: Date.now(), apps };
    return apps;
  }

  async code(id: number, address: string): Promise<{ creator: string; code: Uint8Array } | null> {
    const info = await this.conn.getAccountInfo(pda.code(id, new PublicKey(address).toBytes()));
    if (!info || info.data[85] !== 1) return null;
    const len = info.data.readUInt32LE(86);
    return { creator: new PublicKey(info.data.subarray(44, 76)).toBase58(), code: new Uint8Array(info.data.subarray(123, 123 + len)) };
  }

  /** Runs forever: refresh the registry and chains, then pull history. */
  async run(everyMs = 10_000) {
    for (;;) {
      try {
        await this.refresh();
        await this.followAll();
      } catch (e) {
        console.error('follower:', (e as Error).message);
      }
      await new Promise<void>((r) => {
        const timer = setTimeout(r, everyMs);
        this.wake = () => { clearTimeout(timer); r(); };
      });
      this.wake = null;
    }
  }
}

export const codeHashOf = (code: Uint8Array) => hex(keccak(code));
