// Client for the Chains program: PDAs, instructions (encoded from idl/chains.json so they can't
// drift from the program), the state table reader, guest addresses and event decoding.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction, SystemProgram, type AccountMeta, type Connection } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';

export const IDL = JSON.parse(readFileSync(new URL('../idl/chains.json', import.meta.url), 'utf8'));
export const PROGRAM_ID = new PublicKey(IDL.address);
export const MPL_CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export const keccak = (...parts: Uint8Array[]) => keccak_256(Buffer.concat(parts.map((p) => Buffer.from(p))));
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export const u64be = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

// ---------------------------------------------------------------- PDAs

const find = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const pda = {
  registry: () => find(Buffer.from('registry')),
  collection: () => find(Buffer.from('collection')),
  asset: (id: number) => find(Buffer.from('asset'), u32le(id)),
  claimed: (wallet: PublicKey) => find(Buffer.from('claimed'), wallet.toBuffer()),
  chain: (id: number) => find(Buffer.from('chain'), u32le(id)),
  state: (id: number) => find(Buffer.from('state'), u32le(id)),
  code: (id: number, address: Uint8Array) => find(Buffer.from('code'), u32le(id), address),
  eventAuthority: () => find(Buffer.from('__event_authority')),
  programData: () => PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE)[0],
};

// ---------------------------------------------------------------- instructions

type IdlType = string | { array: [IdlType, number] } | { vec: IdlType } | { option: IdlType };

function encode(t: IdlType, v: unknown): Buffer {
  if (typeof t === 'string') {
    switch (t) {
      case 'u8': return Buffer.from([Number(v)]);
      case 'bool': return Buffer.from([v ? 1 : 0]);
      case 'u32': return u32le(Number(v));
      case 'u64': { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v as bigint)); return b; }
      case 'i64': { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v as bigint)); return b; }
      case 'pubkey': return (v as PublicKey).toBuffer();
      case 'bytes': { const d = Buffer.from(v as Uint8Array); return Buffer.concat([u32le(d.length), d]); }
      case 'string': { const d = Buffer.from(v as string, 'utf8'); return Buffer.concat([u32le(d.length), d]); }
    }
    throw new Error(`unsupported type ${t}`);
  }
  if ('array' in t) {
    const [inner, n] = t.array;
    if (inner === 'u8') {
      const d = Buffer.from(v as Uint8Array);
      if (d.length !== n) throw new Error(`expected ${n} bytes, got ${d.length}`);
      return d;
    }
    return Buffer.concat((v as unknown[]).map((x) => encode(inner, x)));
  }
  if ('vec' in t) {
    const xs = v as unknown[];
    return Buffer.concat([u32le(xs.length), ...xs.map((x) => encode(t.vec, x))]);
  }
  if ('option' in t) return v == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encode(t.option, v)]);
  throw new Error('unsupported type');
}

function decode(t: IdlType, d: Buffer, o: { at: number }): unknown {
  const take = (n: number) => { const b = d.subarray(o.at, o.at + n); if (b.length < n) throw new Error('short data'); o.at += n; return b; };
  if (typeof t === 'string') {
    switch (t) {
      case 'u8': return take(1)[0];
      case 'bool': return take(1)[0] !== 0;
      case 'u32': return take(4).readUInt32LE();
      case 'u64': return take(8).readBigUInt64LE();
      case 'i64': return take(8).readBigInt64LE();
      case 'pubkey': return new PublicKey(take(32));
      case 'bytes': return new Uint8Array(take(take(4).readUInt32LE()));
      case 'string': return take(take(4).readUInt32LE()).toString('utf8');
    }
    throw new Error(`unsupported type ${t}`);
  }
  if ('array' in t) {
    const [inner, n] = t.array;
    if (inner === 'u8') return new Uint8Array(take(n));
    return Array.from({ length: n }, () => decode(inner, d, o));
  }
  if ('vec' in t) return Array.from({ length: take(4).readUInt32LE() }, () => decode(t.vec, d, o));
  if ('option' in t) return take(1)[0] ? decode(t.option, d, o) : null;
  throw new Error('unsupported type');
}

export type DecodedIx = { name: string; args: Record<string, unknown>; accounts: Record<string, PublicKey> };

/** Decodes one of this program's instructions: its name, arguments and named accounts. */
export function decodeIx(data: Buffer, accountKeys: PublicKey[]): DecodedIx | null {
  const def = IDL.instructions.find((i: { discriminator: number[] }) => Buffer.from(i.discriminator).equals(data.subarray(0, 8)));
  if (!def) return null;
  const o = { at: 8 };
  const args: Record<string, unknown> = {};
  for (const a of def.args as { name: string; type: IdlType }[]) args[a.name.replace(/^_/, '')] = decode(a.type, data, o);
  const accounts: Record<string, PublicKey> = {};
  (def.accounts as { name: string }[]).forEach((a, i) => { if (accountKeys[i]) accounts[a.name] = accountKeys[i]; });
  return { name: def.name, args, accounts };
}

const FIXED: Record<string, () => PublicKey> = {
  system_program: () => SystemProgram.programId,
  mpl_core_program: () => MPL_CORE_ID,
  event_authority: pda.eventAuthority,
  program: () => PROGRAM_ID,
  this_program: () => PROGRAM_ID,
  program_data: pda.programData,
  registry: pda.registry,
  collection: pda.collection,
};

/** Builds an instruction. Accounts and arguments by their IDL names (leading "_" optional). */
export function ix(name: string, accounts: Record<string, PublicKey>, args: Record<string, unknown>, remaining: AccountMeta[] = []): TransactionInstruction {
  const def = IDL.instructions.find((i: { name: string }) => i.name === name);
  if (!def) throw new Error(`no instruction ${name}`);
  const keys: AccountMeta[] = def.accounts.map((a: { name: string; writable?: boolean; signer?: boolean }) => {
    const pubkey = accounts[a.name] ?? FIXED[a.name]?.();
    if (!pubkey) throw new Error(`${name}: missing account ${a.name}`);
    return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  const data = Buffer.concat([
    Buffer.from(def.discriminator),
    ...def.args.map((a: { name: string; type: IdlType }) => {
      const key = a.name.replace(/^_/, '');
      if (!(key in args)) throw new Error(`${name}: missing argument ${key}`);
      return encode(a.type, args[key]);
    }),
  ]);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [...keys, ...remaining], data });
}

/** The accounts every per-chain instruction needs. */
export const chainAccounts = (id: number) => ({ header: pda.chain(id), state: pda.state(id), asset: pda.asset(id) });

// ---------------------------------------------------------------- the table (programs/chains/src/table.rs)

const HDR = 40, PER_PAGE = 4, ENTRY = 64, PAGE = 16 + PER_PAGE * ENTRY, NONE = 0xffffffff;
export const KIND = { balance: 0, nonce: 1, storage: 2, guest: 3 } as const;
const ZERO = new Uint8Array(32);

export const ledgerKey = (kind: number, addr: Uint8Array, slot: Uint8Array = ZERO) => keccak(Uint8Array.of(kind), addr, slot);

/** The 32-byte value at `key` in a state account's data (zeros if absent). */
export function tableGet(data: Buffer, key: Uint8Array): Uint8Array {
  if (data.length < HDR || data.readUInt32LE(0) !== 0x31544843) throw new Error('not a Chains state table');
  const level = data.readUInt32LE(4), split = data.readUInt32LE(8);
  const h = BigInt(Buffer.from(key).readUInt32LE(0));
  let b = h % (1n << BigInt(level));
  if (b < BigInt(split)) b = h % (1n << BigInt(level + 1));
  let p = Number(b);
  while (p !== NONE) {
    const at = HDR + p * PAGE;
    const count = data.readUInt32LE(at + 12);
    for (let i = 0; i < count; i++) {
      const e = at + 16 + i * ENTRY;
      if (Buffer.compare(data.subarray(e, e + 32), Buffer.from(key)) === 0) return new Uint8Array(data.subarray(e + 32, e + 64));
    }
    p = data.readUInt32LE(at);
  }
  return new Uint8Array(32);
}

export const wordToBig = (w: Uint8Array) => BigInt('0x' + (Buffer.from(w).toString('hex') || '0'));
export const balanceOf = (state: Buffer, addr: PublicKey | Uint8Array) =>
  wordToBig(tableGet(state, ledgerKey(KIND.balance, addr instanceof PublicKey ? addr.toBytes() : addr)));
export const nonceOf = (state: Buffer, addr: PublicKey) => wordToBig(tableGet(state, ledgerKey(KIND.nonce, addr.toBytes())));
export const storageAt = (state: Buffer, guest: Uint8Array, slot: Uint8Array) => tableGet(state, ledgerKey(KIND.storage, guest, slot));
export const tableCount = (state: Buffer) => state.readBigUInt64LE(32);
/** Storage rent per table entry (SPEC §6: 68 bytes, paid by whoever adds the entry). */
export const entryRent = async (conn: Connection) =>
  BigInt(await conn.getMinimumBalanceForRentExemption(68)) - BigInt(await conn.getMinimumBalanceForRentExemption(0));

/** Guest address (§8): keccak256("chains:guest" ‖ chain id ‖ creator ‖ nonce ‖ salt). */
export const guestAddress = (id: number, creator: PublicKey, nonce: bigint, salt: Uint8Array) =>
  keccak(Buffer.from('chains:guest'), u32be(id), creator.toBytes(), u64be(nonce), salt);

// ---------------------------------------------------------------- accounts

export type Header = {
  id: number; name: string; status: number; height: bigint; head: Uint8Array; expiry: bigint; launchedAt: bigint;
  totalDeposits: bigint; feesAccrued: bigint; feesClaimed: bigint;
};

export function decodeHeader(d: Buffer): Header {
  let o = 8;
  const id = d.readUInt32LE(o); o += 4;
  const nameBytes = d.subarray(o, o + 24); o += 24;
  const nameLen = d[o++];
  const status = d[o++];
  o += 2; // bumps
  const height = d.readBigUInt64LE(o); o += 8;
  const head = new Uint8Array(d.subarray(o, o + 32)); o += 32;
  const expiry = d.readBigInt64LE(o); o += 8;
  const launchedAt = d.readBigInt64LE(o); o += 8;
  const totalDeposits = d.readBigUInt64LE(o); o += 8;
  const feesAccrued = d.readBigUInt64LE(o); o += 8;
  const feesClaimed = d.readBigUInt64LE(o);
  return { id, name: nameBytes.subarray(0, nameLen).toString('utf8'), status, height, head, expiry, launchedAt, totalDeposits, feesAccrued, feesClaimed };
}

export function decodeRegistry(d: Buffer) {
  let o = 8;
  const pk = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const launchAuthority = pk(), treasury = pk(), chainsMint = pk(), collection = pk();
  const snapshotRoot = d.subarray(o, o + 32); o += 32;
  o += 32; // snapshot hash
  const snapshotSlot = d.readBigUInt64LE(o); o += 8;
  const claimed = d.readUInt32LE(o); o += 4;
  const feeLamportsPerMcu = d.readBigUInt64LE(o); o += 8;
  const claimsOpenAt = d.readBigInt64LE(o);
  return { launchAuthority, treasury, chainsMint, collection, snapshotRoot, snapshotSlot, claimed, feeLamportsPerMcu, claimsOpenAt };
}

// ---------------------------------------------------------------- history and events

export const opHash = (tag: string, ...fields: Uint8Array[]) => keccak(Buffer.from(tag), ...fields);
export const nextHead = (prev: Uint8Array, height: bigint, op: Uint8Array) => keccak(prev, u64be(height), op);

const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

export type Event =
  | { name: 'BlockCommitted'; chain: number; height: bigint; prev: Uint8Array; head: Uint8Array; opHash: Uint8Array }
  | { name: 'GuestLog'; chain: number; address: PublicKey; topics: Uint8Array[]; data: Uint8Array | null }
  | { name: 'Swept'; chain: number; holder: PublicKey; holderLamports: bigint; treasuryLamports: bigint }
  | { name: string };

export function decodeEvent(data: Buffer): Event | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  const disc = data.subarray(8, 16);
  const ev = IDL.events.find((e: { discriminator: number[] }) => Buffer.from(e.discriminator).equals(disc));
  if (!ev) return null;
  const d = data.subarray(16);
  switch (ev.name) {
    case 'BlockCommitted':
      return { name: ev.name, chain: d.readUInt32LE(0), height: d.readBigUInt64LE(4), prev: d.subarray(12, 44), head: d.subarray(44, 76), opHash: d.subarray(76, 108) };
    case 'GuestLog': {
      const chain = d.readUInt32LE(0);
      const address = new PublicKey(d.subarray(4, 36));
      const n = d.readUInt32LE(36);
      const topics = Array.from({ length: n }, (_, i) => new Uint8Array(d.subarray(40 + 32 * i, 72 + 32 * i)));
      const o = 40 + 32 * n;
      return { name: ev.name, chain, address, topics, data: d[o] ? new Uint8Array(d.subarray(o + 1, o + 33)) : null };
    }
    case 'Swept':
      return { name: ev.name, chain: d.readUInt32LE(0), holder: new PublicKey(d.subarray(4, 36)), holderLamports: d.readBigUInt64LE(36), treasuryLamports: d.readBigUInt64LE(44) };
    default:
      return { name: ev.name };
  }
}

// ---------------------------------------------------------------- misc

/** Anchor error name for a custom program error code. */
export const errorName = (code: number) => IDL.errors.find((e: { code: number }) => e.code === code)?.name ?? `0x${code.toString(16)}`;

export const anchorDiscriminator = (ns: string, name: string) => createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8);
