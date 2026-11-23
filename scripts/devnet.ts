// Devnet rehearsal: the localnet rehearsal against the real (500-chain, 30-day) build, with small
// amounts. Safe to re-run: initialize, mint, snapshot, claims and launches are skipped once done,
// and everything after that runs again on fresh guests.
//
// Not covered here: SoldOut (needs 500 claims) and the end date and sweep (30-day minimum).
//
//   node scripts/devnet.ts
//
// Env: CHAINS_RPC (default devnet), CHAINS_ADMIN (the upgrade authority, also launch authority,
// treasury and funder), CHAINS_DEVNET_KEYS (where the test wallets are kept).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { ix, pda, chainAccounts, balanceOf, nonceOf, guestAddress, decodeRegistry, opHash, u64be, keccak, type Event } from '../tools/chains.ts';
import { assemble, word } from '../tools/asm.ts';
import { Snapshot } from '../tools/snapshot.ts';
import { Client } from '../tools/client.ts';

const RPC = process.env.CHAINS_RPC ?? 'https://api.devnet.solana.com';
const ADMIN_PATH = process.env.CHAINS_ADMIN ?? 'C:/Users/Admin/neurals-keys/payer-devnet.json';
const KEYS = process.env.CHAINS_DEVNET_KEYS ?? 'C:/Users/Admin/chains-keys/devnet';

const SOL = BigInt(LAMPORTS_PER_SOL);
const MILLI = SOL / 1000n;
const RATE = 1_000_000n; // 1 lamport per compute unit
const DAY = 86_400n;

const conn = new Connection(RPC, 'confirmed');
const c = new Client(conn, 10_000);
const loadKey = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const words = (...ws: (bigint | string | Uint8Array)[]) => Buffer.concat(ws.map((w) => (w instanceof Uint8Array ? Buffer.from(w) : Buffer.from(word(w)))));
const big = (w: Uint8Array) => BigInt('0x' + Buffer.from(w).toString('hex'));
const i64be = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(n); return b; };

function wallet(name: string): Keypair {
  mkdirSync(KEYS, { recursive: true });
  const p = `${KEYS}/${name}.json`;
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return loadKey(p);
}

async function step(name: string, f: () => Promise<void>) {
  const t0 = Date.now();
  await f();
  console.log(`ok  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const admin = loadKey(ADMIN_PATH);
const treasury = admin.publicKey;
const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map(wallet);
const auth = { launch_authority: admin.publicKey };
// E is never claimed here: import its key into a wallet to try the site's claim page.
const snap = new Snapshot([{ wallet: A.publicKey, claims: 3 }, { wallet: B.publicKey, claims: 2 }, { wallet: C.publicKey, claims: 1 }, { wallet: E.publicKey, claims: 3 }]);
// The published file the site serves claims from (indexer/claims.ts).
writeFileSync(new URL('../deploy/snapshot.devnet.csv', import.meta.url), snap.file());
const cuLog: string[] = [];
const now = async () => BigInt((await conn.getBlockTime(await conn.getSlot('confirmed')))!);
const startBalance = await conn.getBalance(admin.publicKey);
console.log(`rpc ${RPC}\nadmin ${admin.publicKey.toBase58()} ${startBalance / LAMPORTS_PER_SOL} SOL`);

await step('fund test wallets', async () => {
  for (const [k, target] of [[A, 600n], [B, 400n], [C, 300n], [D, 60n], [E, 50n]] as const) {
    const have = BigInt(await conn.getBalance(k.publicKey));
    const want = target * MILLI;
    if (have < want / 2n) {
      await c.send([admin], SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: k.publicKey, lamports: want - have }));
    }
  }
});

await step('initialize (once; only the upgrade authority)', async () => {
  if (await conn.getAccountInfo(pda.registry())) return;
  const args = { launch_authority: admin.publicKey, treasury, fee_lamports_per_mcu: RATE, uri_base: 'https://chains.example/' };
  await c.fails(c.send([A], ix('initialize', { deployer: A.publicKey }, args)), 'Unauthorized');
  await c.send([admin], ix('initialize', { deployer: admin.publicKey }, args));
});

await step('mint and snapshot (once)', async () => {
  let r = decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
  assert.ok(r.treasury.equals(treasury));
  assert.equal(r.feeLamportsPerMcu, RATE);
  if (r.chainsMint.equals(PublicKey.default)) await c.send([admin], ix('set_mint', auth, { mint: Keypair.generate().publicKey }));
  await c.fails(c.send([admin], ix('set_mint', auth, { mint: Keypair.generate().publicKey })), 'AlreadySet');
  r = decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
  if (r.snapshotSlot === 0n) await c.send([admin], ix('set_snapshot', auth, {
    slot: BigInt(await conn.getSlot()), root: snap.root, hash: snap.fileHash(),
    // Opened a day ago less 60s: the one-per-wallet window closes a minute from now.
    claims_open_at: (await now()) - DAY + 60n,
  }));
  r = decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
  assert.deepEqual(new Uint8Array(r.snapshotRoot), new Uint8Array(snap.root), 'registry holds this snapshot (keys in CHAINS_DEVNET_KEYS)');
  await c.fails(c.send([admin], ix('set_snapshot', auth, { slot: 1n, root: snap.root, hash: snap.fileHash(), claims_open_at: 0n })), 'AlreadySet');
});

const claim = (k: Keypair, n: number, first: number, claims?: number) => {
  const p = snap.proof(k.publicKey);
  return c.send([k], ix('claim', { claimer: k.publicKey, claim_record: pda.claimed(k.publicKey) },
    { proof: p.proof, total_claims: claims ?? p.claims, n },
    Array.from({ length: n }, (_, j) => ({ pubkey: pda.asset(first + j), isSigner: false, isWritable: true }))));
};

await step('claim: one per wallet first, then limits, ids in order', async () => {
  const reg = async () => decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
  if ((await reg()).claimed === 0) {
    await c.fails(claim(B, 1, 1, 5), 'NotListed');
    await c.fails(claim(A, 2, 1), 'OnePerWallet');
    await claim(A, 1, 1);
    await c.fails(claim(A, 1, 2), 'OnePerWallet');
    await claim(B, 1, 2);
    const windowEnds = (await reg()).claimsOpenAt + DAY;
    while ((await now()) < windowEnds + 2n) await new Promise((r) => setTimeout(r, 2000));
    await claim(A, 2, 3);
    await c.fails(claim(A, 1, 5), 'TooManyClaims');
    await claim(B, 1, 5);
    await claim(C, 1, 6);
  }
  assert.equal((await reg()).claimed, 6);
  for (const [id, k] of [[1, A], [2, B], [3, A], [4, A], [5, B], [6, C]] as const) {
    const d = (await conn.getAccountInfo(pda.asset(id)))!.data;
    assert.ok(new PublicKey(d.subarray(1, 33)).equals(k.publicKey), `chain ${id} owner`);
  }
});

const launch = (k: Keypair, id: number, expiry: bigint) => c.send([k], ix('launch', { holder: k.publicKey, ...chainAccounts(id) }, { id, expiry }));

await step('launch: holder only, end date rule, block 1', async () => {
  if (!(await conn.getAccountInfo(pda.chain(1)))) {
    await c.fails(launch(A, 2, 0n), 'NotHolder');
    await c.fails(launch(A, 3, (await now()) + DAY), 'BadExpiry');
    c.track(await launch(A, 1, 0n), [opHash('launch', A.publicKey.toBytes(), i64be(0n))]);
    c.track(await launch(A, 3, (await now()) + 31n * DAY));
  }
  await c.follow(1);
  await c.follow(3);
  assert.ok((await c.header(1)).height >= 1n);
  await assert.rejects(launch(A, 1, 0n), 'a chain launches once');
});

await step('set_name', async () => {
  const setName = (k: Keypair, name: string) => c.send([k], ix('set_name', { holder: k.publicKey, ...chainAccounts(1) }, { id: 1, name }));
  await setName(A, 'Ruby One');
  assert.equal((await c.header(1)).name, 'Ruby One');
  await c.fails(setName(A, ' Ruby'), 'BadName');
  await c.fails(setName(B, 'Mine'), 'NotHolder');
});

const dep = async (k: Keypair, to: PublicKey, lamports: bigint, id = 1) =>
  c.track(await c.sendGrow(id, [k], ix('deposit', { payer: k.publicKey, ...chainAccounts(id) }, { id, beneficiary: to, lamports })));

await step('deposit and withdraw', async () => {
  const s0 = await c.state(1);
  const [a0, b0, c0] = [A, B, C].map((k) => balanceOf(s0, k.publicKey));
  c.track(await dep(A, A.publicKey, 150n * MILLI), [opHash('deposit', A.publicKey.toBytes(), A.publicKey.toBytes(), u64be(150n * MILLI))]);
  await dep(B, B.publicKey, 100n * MILLI);
  await dep(D, C.publicKey, 20n * MILLI); // anyone can fund anyone
  assert.equal(balanceOf(await c.state(1), A.publicKey), a0 + 150n * MILLI);
  assert.equal(balanceOf(await c.state(1), C.publicKey), c0 + 20n * MILLI);
  const to = Keypair.generate().publicKey;
  c.track(await c.send([B], ix('withdraw', { account: B.publicKey, recipient: to, ...chainAccounts(1) }, { id: 1, lamports: 10n * MILLI })));
  assert.equal(BigInt(await conn.getBalance(to)), 10n * MILLI);
  assert.equal(balanceOf(await c.state(1), B.publicKey), b0 + 90n * MILLI);
  await c.fails(c.send([B], ix('withdraw', { account: B.publicKey, recipient: to, ...chainAccounts(1) }, { id: 1, lamports: 100n * SOL })), 'InsufficientBalance');
  await c.fails(dep(A, A.publicKey, 0n), 'ZeroAmount');
});

async function deploy(k: Keypair, id: number, code: Uint8Array) {
  const salt = keccak(Buffer.from(Math.random().toString()));
  const nonce = nonceOf(await c.state(id), k.publicKey);
  const address = guestAddress(id, k.publicKey, nonce, salt);
  const codeAcc = pda.code(id, address);
  const acc = { creator: k.publicKey, ...chainAccounts(id), code: codeAcc };
  await c.sendGrow(id, [k], ix('deploy_begin', acc, { id, salt, len: code.length, address }));
  for (let off = 0; off < code.length; off += 800) {
    await c.send([k], ix('deploy_write', acc, { id, address, offset: off, bytes: code.subarray(off, off + 800) }));
  }
  const s = c.track(await c.sendGrow(id, [k], ix('deploy_seal', acc, { id, address, max_fee: SOL })));
  const ops = s.events.filter((e) => e.name === 'BlockCommitted') as Extract<Event, { name: 'BlockCommitted' }>[];
  assert.deepEqual(new Uint8Array(ops[0].opHash), opHash('deploy', k.publicKey.toBytes(), u64be(nonce), address, Uint8Array.of(1), keccak(code)));
  return { address, codeAcc };
}

const call = async (k: Keypair, id: number, target: Uint8Array, value: bigint, data: Buffer, codes: PublicKey[], maxFee = SOL) =>
  c.track(await c.sendGrow(id, [k], ix('transact', { sender: k.publicKey, ...chainAccounts(id) }, { id, target: new PublicKey(target), value, data, max_steps: 10_000, max_fee: maxFee },
    codes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })))));

await step('deploy: bad code is rejected at seal', async () => {
  await c.fails(deploy(A, 1, Uint8Array.of(0xff, 0, 0, 0)), 'InvalidOpcode');
});

let swap: { address: Uint8Array; codeAcc: PublicKey };
let coll: { address: Uint8Array; codeAcc: PublicKey };

await step('swap: seed, buy, sell, reads, fees', async () => {
  swap = await deploy(A, 1, assemble(readFileSync(new URL('../tools/apps/swap.asm', import.meta.url), 'utf8')));
  const codes = [swap.codeAcc];
  const seedSol = 50n * MILLI;
  const h0 = await c.header(1);
  const a0 = balanceOf(await c.state(1), A.publicKey);
  const seeded = await call(A, 1, swap.address, seedSol, words(1n, 'Ruby Gem', 'RUBY'), codes);
  cuLog.push(`seed ${seeded.cu} CU`);
  assert.equal(big(seeded.ret!), 1_000_000n);
  const h1 = await c.header(1);
  const fee = h1.feesAccrued - h0.feesAccrued;
  assert.ok(fee > 20_000n, `fee ${fee} covers the overhead`);
  console.log(`    seed fee ${fee} lamports`);
  assert.equal(balanceOf(await c.state(1), A.publicKey), a0 - seedSol - fee);

  const amt = 20n * MILLI;
  const aBefore = balanceOf(await c.state(1), A.publicKey);
  const bought = await call(B, 1, swap.address, amt, words(2n, 1n), codes);
  cuLog.push(`buy ${bought.cu} CU`);
  const feeIn = amt * 3n / 1000n, inn = amt - feeIn;
  const out = 1_000_000n * inn / (seedSol + inn);
  assert.equal(big(bought.ret!), out);
  assert.equal(balanceOf(await c.state(1), A.publicKey), aBefore + feeIn);
  assert.equal(big((await c.read(B.publicKey, 1, swap.address, words(4n, B.publicKey.toBytes()), codes))!), out);
  assert.equal(big((await c.read(B.publicKey, 1, swap.address, words(7n), codes))!), seedSol + inn);

  const half = out / 2n;
  const solR = seedSol + inn, tokR = 1_000_000n - out;
  const gross = solR * half / (tokR + half);
  const net = gross - gross * 3n / 1000n;
  const sold = await call(B, 1, swap.address, 0n, words(3n, half, 1n), codes);
  cuLog.push(`sell ${sold.cu} CU`);
  assert.equal(big(sold.ret!), net);

  const before = await c.header(1);
  await c.fails(call(B, 1, swap.address, 0n, words(3n, 10n ** 12n, 0n), codes), 'RequireFailed');
  await c.fails(call(B, 1, swap.address, amt, words(2n, 1n), []), 'MissingCode');
  await c.fails(call(B, 1, swap.address, amt, words(2n, 1n), codes, 0n), 'FeeTooHigh');
  await c.fails(call(B, 1, swap.address, 0n, words(9n), codes), 'Reverted');
  const after = await c.header(1);
  assert.equal(after.height, before.height);
  assert.equal(after.feesAccrued, before.feesAccrued);
});

await step('collection: create, mint at price, cap, transfer', async () => {
  coll = await deploy(C, 1, assemble(readFileSync(new URL('../tools/apps/collection.asm', import.meta.url), 'utf8')));
  const codes = [coll.codeAcc];
  const price = 5n * MILLI;
  await call(C, 1, coll.address, 0n, words(1n, keccak(Buffer.from('meta')), 2n, price), codes);
  const cBefore = balanceOf(await c.state(1), C.publicKey);
  const m1 = await call(B, 1, coll.address, price, words(2n), codes);
  cuLog.push(`mint ${m1.cu} CU`);
  assert.equal(big(m1.ret!), 1n);
  assert.equal(balanceOf(await c.state(1), C.publicKey), cBefore + price);
  await c.fails(call(B, 1, coll.address, price - 1n, words(2n), codes), 'RequireFailed');
  assert.equal(big((await call(A, 1, coll.address, price, words(2n), codes)).ret!), 2n);
  await c.fails(call(B, 1, coll.address, price, words(2n), codes), 'RequireFailed');
  await call(B, 1, coll.address, 0n, words(3n, 1n, D.publicKey.toBytes()), codes);
  assert.ok(new PublicKey((await c.read(B.publicKey, 1, coll.address, words(4n, 1n), codes))!).equals(D.publicKey));
  await c.fails(call(B, 1, coll.address, 0n, words(3n, 1n, B.publicKey.toBytes()), codes), 'RequireFailed');
});

await step('chain 3: deposit and a plain transfer', async () => {
  await dep(B, B.publicKey, 30n * MILLI, 3);
  const d0 = balanceOf(await c.state(3), D.publicKey);
  await call(B, 3, D.publicKey.toBytes(), 10n * MILLI, Buffer.alloc(0), []);
  assert.equal(balanceOf(await c.state(3), D.publicKey), d0 + 10n * MILLI);
  const pay = { registry: pda.registry(), ...chainAccounts(3), holder: A.publicKey, treasury };
  await c.fails(c.send([D], ix('sweep', pay, { id: 3 })), 'NotEnded');
});

await step('history and backing: header matches every block seen', async () => {
  for (const id of [1, 3]) {
    const h = await c.header(id);
    assert.deepEqual(new Uint8Array(h.head), c.heads.get(id)!.head);
    assert.equal(h.height, c.heads.get(id)!.height);
    const info = (await conn.getAccountInfo(pda.chain(id)))!;
    const rent = BigInt(await conn.getMinimumBalanceForRentExemption(info.data.length));
    assert.ok(BigInt(info.lamports) >= rent + h.totalDeposits, `chain ${id} is fully backed`);
  }
});

await step('claim_fees: half to the holder, half to the treasury', async () => {
  const h = await c.header(1);
  const unclaimed = h.feesAccrued - h.feesClaimed;
  const aBefore = BigInt(await conn.getBalance(A.publicKey));
  const tBefore = BigInt(await conn.getBalance(treasury));
  const pay = { registry: pda.registry(), ...chainAccounts(1), holder: A.publicKey, treasury };
  await c.fails(c.send([B], ix('claim_fees', { ...pay, holder: B.publicKey }, { id: 1 })), 'BadPayee');
  c.track(await c.send([D], ix('claim_fees', pay, { id: 1 })), [opHash('claim', A.publicKey.toBytes(), treasury.toBytes(), u64be(unclaimed))]);
  assert.equal(BigInt(await conn.getBalance(A.publicKey)) - aBefore, unclaimed - unclaimed / 2n);
  assert.equal(BigInt(await conn.getBalance(treasury)) - tBefore, unclaimed / 2n);
  assert.equal(balanceOf(await c.state(1), pda.chain(1)), 0n);
  await c.fails(c.send([D], ix('claim_fees', pay, { id: 1 })), 'ZeroAmount');
});

const spent = startBalance - (await conn.getBalance(admin.publicKey));
console.log(`compute: ${cuLog.join(', ')}`);
console.log(`admin spent ${spent / LAMPORTS_PER_SOL} SOL this run`);
