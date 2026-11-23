// Shared client for the rehearsals (test/localnet.test.ts, scripts/devnet.ts): sending with event
// and return-data decoding, expected failures, simulated reads, grow-and-retry, and history checks.

import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import { PROGRAM_ID, ix, pda, chainAccounts, decodeHeader, decodeEvent, errorName, nextHead, type Event } from './chains.ts';

export type Sent = { sig: string; events: Event[]; ret: Uint8Array | null; cu: number };
type Block = Extract<Event, { name: 'BlockCommitted' }>;

const errorOf = (e: unknown) => {
  const s = String((e as Error).message) + JSON.stringify((e as { logs?: string[] }).logs ?? []);
  const m = /custom program error: 0x([0-9a-f]+)/.exec(s);
  return m ? errorName(parseInt(m[1], 16)) : s.slice(0, 300);
};

export class Client {
  /** Per chain: the last height and head seen, checked against every BlockCommitted event. */
  readonly heads = new Map<number, { height: bigint; head: Uint8Array }>();
  private seen = new Set<string>();

  readonly conn: Connection;
  readonly priorityMicroLamports: number;

  constructor(conn: Connection, priorityMicroLamports = 0) {
    this.conn = conn;
    this.priorityMicroLamports = priorityMicroLamports;
  }

  async send(signers: Keypair[], ...ixs: TransactionInstruction[]): Promise<Sent> {
    const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
    if (this.priorityMicroLamports) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityMicroLamports }));
    const tx = new Transaction().add(...pre, ...ixs);
    const sig = await sendAndConfirmTransaction(this.conn, tx, signers, { commitment: 'confirmed' });
    let t = null;
    for (let i = 0; i < 20 && !t; i++) {
      t = await this.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!t) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(t, `transaction ${sig} not found`);
    const keys = t.transaction.message.staticAccountKeys;
    const events: Event[] = [];
    for (const inner of t.meta!.innerInstructions ?? []) {
      for (const i of inner.instructions) {
        if (!keys[i.programIdIndex].equals(PROGRAM_ID)) continue;
        const e = decodeEvent(Buffer.from(bs58.decode(i.data)));
        if (e) events.push(e);
      }
    }
    const rd = (t.meta as unknown as { returnData?: { data: [string, string] } }).returnData;
    return { sig, events, ret: rd ? Buffer.from(rd.data[0], 'base64') : null, cu: t.meta!.computeUnitsConsumed ?? 0 };
  }

  async fails(p: Promise<unknown>, name: string) {
    try {
      await p;
    } catch (e) {
      assert.equal(errorOf(e), name);
      return;
    }
    assert.fail(`expected ${name}`);
  }

  /** Sends; on NoSpace, grows the state account and tries again (§6: clients simulate and grow). */
  async sendGrow(id: number, signers: Keypair[], ...ixs: TransactionInstruction[]): Promise<Sent> {
    for (let i = 0; ; i++) {
      try {
        return await this.send(signers, ...ixs);
      } catch (e) {
        if (i > 5 || errorOf(e) !== 'NoSpace') throw e;
        await this.send([signers[0]], ix('grow', { payer: signers[0].publicKey, ...chainAccounts(id) }, { id, bytes: 10_240 }));
      }
    }
  }

  /** Simulates `read` and returns the guest's result word. */
  async read(payer: PublicKey, id: number, target: Uint8Array, data: Buffer, codes: PublicKey[]): Promise<Uint8Array | null> {
    const i = ix('read', { caller: payer, ...chainAccounts(id) }, { id, target: new PublicKey(target), data, max_steps: 10_000 },
      codes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })));
    const { blockhash } = await this.conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), i] }).compileToV0Message();
    const sim = await this.conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) throw new Error(`read failed: ${JSON.stringify(sim.value.err)} ${sim.value.logs?.join('\n')}`);
    const rd = sim.value.returnData;
    return rd ? Buffer.from(rd.data[0], 'base64') : null;
  }

  state = async (id: number) => (await this.conn.getAccountInfo(pda.state(id)))!.data;
  header = async (id: number) => decodeHeader((await this.conn.getAccountInfo(pda.chain(id)))!.data);

  /** Starts history checks for a chain that already has blocks. */
  async follow(id: number) {
    const h = await this.header(id);
    this.heads.set(id, { height: h.height, head: new Uint8Array(h.head) });
  }

  /** Checks a sent transaction's blocks against the chain's history so far (and the op hashes, if given). */
  track(s: Sent, expectOps?: Uint8Array[]): Sent {
    const blocks = s.events.filter((e): e is Block => e.name === 'BlockCommitted');
    if (this.seen.has(s.sig)) {
      expectOps?.forEach((op, k) => assert.deepEqual(new Uint8Array(blocks[k].opHash), op, 'op hash'));
      return s;
    }
    this.seen.add(s.sig);
    blocks.forEach((b, k) => {
      const cur = this.heads.get(b.chain) ?? { height: 0n, head: new Uint8Array(32) };
      assert.equal(b.height, cur.height + 1n);
      assert.deepEqual(new Uint8Array(b.prev), cur.head);
      assert.deepEqual(new Uint8Array(b.head), nextHead(cur.head, b.height, b.opHash));
      if (expectOps) assert.deepEqual(new Uint8Array(b.opHash), expectOps[k], 'op hash');
      this.heads.set(b.chain, { height: b.height, head: new Uint8Array(b.head) });
    });
    return s;
  }
}
