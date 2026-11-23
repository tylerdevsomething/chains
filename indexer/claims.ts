// Claiming (SPEC §4) for the site: who is in the published snapshot, how many they've used, and a
// ready-to-sign claim transaction for the wallet to sign and send.

import { existsSync, readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from '@solana/web3.js';
import { ix, pda, decodeRegistry } from '../tools/chains.ts';
import { Snapshot } from '../tools/snapshot.ts';

export const PRIORITY_WINDOW = 24 * 60 * 60;
/** Chains per claim transaction (each one is a Core asset CPI). */
export const MAX_PER_TX = 4;

export class Claims {
  readonly conn: Connection;
  snapshot: Snapshot | null = null;
  /** Why the snapshot isn't usable, if it isn't. */
  problem: string | null = null;
  private file: string | null;

  constructor(conn: Connection, file: string | null) {
    this.conn = conn;
    this.file = file;
    if (!file || !existsSync(file)) {
      this.problem = 'The snapshot file is not published yet.';
      return;
    }
    const entries = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [w, c] = line.split(',');
      return { wallet: new PublicKey(w), claims: Number(c) };
    });
    this.snapshot = new Snapshot(entries);
  }

  /** Checks the published file against the root on chain. */
  check(registryRoot: Uint8Array) {
    if (!this.snapshot) return;
    if (registryRoot.every((b) => b === 0)) this.problem = 'The snapshot is not set on chain yet.';
    else if (!Buffer.from(this.snapshot.root).equals(Buffer.from(registryRoot))) this.problem = `The published file (${this.file}) does not match the root on chain.`;
    else this.problem = null;
  }

  async status(wallet: PublicKey) {
    const reg = decodeRegistry((await this.conn.getAccountInfo(pda.registry()))!.data);
    this.check(reg.snapshotRoot);
    const rec = await this.conn.getAccountInfo(pda.claimed(wallet));
    const used = rec ? rec.data.readUInt32LE(8 + 32) : 0;
    const entry = this.problem ? undefined : this.snapshot?.entries.find((e) => e.wallet.equals(wallet));
    const opensAt = Number(reg.claimsOpenAt);
    const now = Math.floor(Date.now() / 1000);
    const left = Math.max(0, 500 - reg.claimed);
    const inWindow = reg.snapshotSlot > 0n && now >= opensAt && now < opensAt + PRIORITY_WINDOW;
    const allowed = !entry ? 0 : inWindow ? Math.max(0, 1 - used) : Math.max(0, entry.claims - used);
    return {
      problem: this.problem,
      snapshotSlot: Number(reg.snapshotSlot),
      opensAt,
      windowEndsAt: opensAt + PRIORITY_WINDOW,
      now,
      claimed: reg.claimed,
      left,
      listed: !!entry,
      claims: entry?.claims ?? 0,
      used,
      canClaimNow: reg.snapshotSlot > 0n && now >= opensAt ? Math.min(allowed, left) : 0,
    };
  }

  /** An unsigned claim transaction for `n` chains, as a base58 message for the wallet to sign. */
  async tx(wallet: PublicKey, n: number) {
    if (!this.snapshot || this.problem) throw new Error(this.problem ?? 'no snapshot');
    if (!Number.isInteger(n) || n < 1 || n > MAX_PER_TX) throw new Error(`n must be 1 to ${MAX_PER_TX}`);
    const p = this.snapshot.proof(wallet);
    const reg = decodeRegistry((await this.conn.getAccountInfo(pda.registry()))!.data);
    const first = reg.claimed + 1;
    const t = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 120_000 + 90_000 * n) }),
      ix('claim', { claimer: wallet, claim_record: pda.claimed(wallet) }, { proof: p.proof, total_claims: p.claims, n },
        Array.from({ length: n }, (_, j) => ({ pubkey: pda.asset(first + j), isSigner: false, isWritable: true }))),
    );
    t.feePayer = wallet;
    t.recentBlockhash = (await this.conn.getLatestBlockhash('confirmed')).blockhash;
    return { message: bs58.encode(t.serializeMessage()), firstId: first, n };
  }
}
