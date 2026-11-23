// Picks the snapshot slot S inside an announced window (SPEC §3.1):
//
//   S = W0 + (x mod (W1 − W0 + 1)), x = first 8 bytes BE of keccak256("chains:snapshot" ‖ blockhash(R'))
//
// where R' is R, or the first slot after R that has a block. Anyone can run it to check.
//
//   node tools/snapshot-slot.ts <W0> <W1> <R> [rpc]

import bs58 from 'bs58';
import { Connection } from '@solana/web3.js';
import { keccak } from './chains.ts';

export function pickSlot(w0: bigint, w1: bigint, blockhash: string): bigint {
  if (w1 < w0) throw new Error('window end is before its start');
  const h = keccak(Buffer.from('chains:snapshot'), bs58.decode(blockhash));
  const x = Buffer.from(h).readBigUInt64BE(0);
  return w0 + (x % (w1 - w0 + 1n));
}

/** The reveal block: slot R, or the first later slot that has a block. Needs R finalized. */
export async function revealBlock(conn: Connection, r: number): Promise<{ slot: number; blockhash: string }> {
  const slots = await conn.getBlocks(r, r + 200, 'finalized');
  if (!slots.length) throw new Error(`no finalized block at or after slot ${r} yet`);
  const b = await conn.getBlock(slots[0], { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 });
  if (!b) throw new Error(`block ${slots[0]} not available`);
  return { slot: slots[0], blockhash: b.blockhash };
}

if (import.meta.main) {
  const [w0, w1, r, rpc] = process.argv.slice(2);
  if (!r) {
    console.error('usage: node tools/snapshot-slot.ts <W0> <W1> <R> [rpc]');
    process.exit(1);
  }
  if (BigInt(r) < BigInt(w1) + 150n) console.error(`warning: R should be at least 150 slots after W1`);
  const conn = new Connection(rpc ?? 'https://api.mainnet-beta.solana.com', 'finalized');
  const rb = await revealBlock(conn, Number(r));
  const s = pickSlot(BigInt(w0), BigInt(w1), rb.blockhash);
  console.log(JSON.stringify({ window: [w0, w1], reveal: r, revealBlock: rb.slot, blockhash: rb.blockhash, snapshotSlot: s.toString() }, null, 2));
}
