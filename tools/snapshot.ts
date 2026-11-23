// Snapshot Merkle tree (SPEC §3, §4; programs/chains/src/merkle.rs).
// Leaf = keccak256(0x00 ‖ wallet ‖ claims u32 BE). Node = keccak256(0x01 ‖ smaller ‖ larger).
// Leaves are in wallet order; an odd node at the end of a level moves up unchanged.
// The real snapshot builder (replaying $CHAINS history to slot S) is part of the indexer.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { keccak } from './chains.ts';

export type Entry = { wallet: PublicKey; claims: number };

export const TOKENS_PER_CLAIM = 1_000_000n * 1_000_000n; // 1M $CHAINS at 6 decimals

export const claimsFor = (rawBalance: bigint) => Number(rawBalance / TOKENS_PER_CLAIM);

export function leaf(e: Entry): Uint8Array {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(e.claims);
  return keccak(Uint8Array.of(0), e.wallet.toBytes(), c);
}

export function node(a: Uint8Array, b: Uint8Array): Uint8Array {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? keccak(Uint8Array.of(1), a, b) : keccak(Uint8Array.of(1), b, a);
}

export class Snapshot {
  readonly entries: Entry[];
  private levels: Uint8Array[][];

  constructor(entries: Entry[]) {
    const seen = new Set<string>();
    this.entries = entries
      .filter((e) => e.claims > 0)
      .sort((x, y) => Buffer.compare(x.wallet.toBuffer(), y.wallet.toBuffer()));
    for (const e of this.entries) {
      if (seen.has(e.wallet.toBase58())) throw new Error(`duplicate wallet ${e.wallet.toBase58()}`);
      seen.add(e.wallet.toBase58());
    }
    if (this.entries.length === 0) throw new Error('empty snapshot');
    this.levels = [this.entries.map(leaf)];
    while (this.levels[this.levels.length - 1].length > 1) {
      const cur = this.levels[this.levels.length - 1];
      const next: Uint8Array[] = [];
      for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? node(cur[i], cur[i + 1]) : cur[i]);
      this.levels.push(next);
    }
  }

  get root(): Uint8Array {
    return this.levels[this.levels.length - 1][0];
  }

  /** The published file: one "wallet,claims" line per entry, in wallet order. */
  file(): string {
    return this.entries.map((e) => `${e.wallet.toBase58()},${e.claims}`).join('\n') + '\n';
  }

  fileHash(): Uint8Array {
    return createHash('sha256').update(this.file()).digest();
  }

  proof(wallet: PublicKey): { claims: number; proof: Uint8Array[] } {
    let i = this.entries.findIndex((e) => e.wallet.equals(wallet));
    if (i < 0) throw new Error(`${wallet.toBase58()} is not in the snapshot`);
    const claims = this.entries[i].claims;
    const proof: Uint8Array[] = [];
    for (const level of this.levels.slice(0, -1)) {
      const sib = i ^ 1;
      if (sib < level.length) proof.push(level[sib]);
      i >>= 1;
    }
    return { claims, proof };
  }
}

export const verify = (proof: Uint8Array[], l: Uint8Array, root: Uint8Array) =>
  Buffer.from(proof.reduce((acc, p) => node(acc, p), l)).equals(Buffer.from(root));
