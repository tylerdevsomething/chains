// Checks the snapshot builder (indexer/build-snapshot.ts) and the slot picker on devnet with a
// throwaway token:
//   A gets 3.5M, B 1.2M, C 0.5M, and a program address (PDA) 5M.
//   A sends C 0.6M with a plain transfer (which doesn't name the mint).   → S is this slot
//   After S, B sends D 1M.
// Expected at S: A 2.9M → 2 claims, B 1.2M → 1, C 1.1M → 1, the PDA is left out, D isn't there.
//
//   node scripts/snapshot-devnet.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, createTransferInstruction } from '@solana/spl-token';
import { buildSnapshot } from '../indexer/build-snapshot.ts';
import { pickSlot, revealBlock } from '../tools/snapshot-slot.ts';
import { verify, leaf } from '../tools/snapshot.ts';

const conn = new Connection(process.env.CHAINS_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const admin = load(process.env.CHAINS_ADMIN ?? 'C:/Users/Admin/neurals-keys/payer-devnet.json');
const [A, B, C, D] = Array.from({ length: 4 }, () => Keypair.generate());
const pdaOwner = PublicKey.findProgramAddressSync([Buffer.from('vault')], new PublicKey('11111111111111111111111111111111'))[0];
const M = 1_000_000n * 1_000_000n; // 1M at 6 decimals

const mint = await createMint(conn, admin, admin.publicKey, null, 6);
console.log(`mint ${mint.toBase58()}`);
const ata = async (owner: PublicKey, offCurve = false) => (await getOrCreateAssociatedTokenAccount(conn, admin, mint, owner, offCurve)).address;
const [a, b, c, d, p] = [await ata(A.publicKey), await ata(B.publicKey), await ata(C.publicKey), await ata(D.publicKey), await ata(pdaOwner, true)];
await mintTo(conn, admin, mint, a, admin, 3_500_000n * 1_000_000n);
await mintTo(conn, admin, mint, b, admin, 1_200_000n * 1_000_000n);
await mintTo(conn, admin, mint, c, admin, 500_000n * 1_000_000n);
await mintTo(conn, admin, mint, p, admin, 5n * M);

const t1 = await sendAndConfirmTransaction(conn, new Transaction().add(createTransferInstruction(a, c, A.publicKey, 600_000n * 1_000_000n)), [admin, A]);
const S = (await conn.getTransaction(t1, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.slot;
console.log(`S = ${S}`);
await sendAndConfirmTransaction(conn, new Transaction().add(createTransferInstruction(b, d, B.publicKey, M)), [admin, B]);

// The builder reads finalized history only.
const fin = new Connection(conn.rpcEndpoint, 'finalized');
while ((await fin.getSlot('finalized')) < S + 40) await new Promise((r) => setTimeout(r, 2000));
await new Promise((r) => setTimeout(r, 4000));

const r = await buildSnapshot(fin, mint, S, (m) => console.log('  ' + m));
const claims = (k: PublicKey) => r.holdings.find((h) => h.owner === k.toBase58());
assert.equal(claims(A.publicKey)?.claims, 2, 'A: 2.9M → 2');
assert.equal(claims(A.publicKey)?.raw, 2_900_000n * 1_000_000n);
assert.equal(claims(B.publicKey)?.claims, 1, 'B: 1.2M at S → 1 (the later transfer does not count)');
assert.equal(claims(C.publicKey)?.claims, 1, 'C: 1.1M → 1');
assert.equal(claims(D.publicKey), undefined, 'D only got tokens after S');
assert.equal(claims(pdaOwner)?.counted, false, 'program-owned balances are left out');
assert.equal(r.snapshot!.entries.length, 3);
for (const e of r.snapshot!.entries) assert.ok(verify(r.snapshot!.proof(e.wallet).proof, leaf(e), r.snapshot!.root));
console.log('ok  snapshot at S: A 2, B 1, C 1, PDA left out, later transfer ignored');

// The slot picker: deterministic, inside the window, and the same from the reveal block.
const W0 = BigInt(S - 100), W1 = BigInt(S);
const rb = await revealBlock(fin, S + 10);
const s1 = pickSlot(W0, W1, rb.blockhash);
assert.ok(s1 >= W0 && s1 <= W1);
assert.equal(pickSlot(W0, W1, rb.blockhash), s1);
console.log(`ok  slot picker: window [${W0}, ${W1}], reveal block ${rb.slot} → S = ${s1}`);
