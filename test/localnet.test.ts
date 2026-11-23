// Full rehearsal on a local validator (SPEC §17 verification):
// initialize → snapshot → claim (to SoldOut) → launch → deposit/withdraw → deploy Swap and
// Collection → buy/sell/mint/transfer → reads → fees → end date → sweep, checking history and the
// fully-backed invariant along the way.
//
// Needs a fresh validator from scripts/localnet.sh with a `--features localnet` build. Skipped when
// nothing answers at CHAINS_RPC (default http://127.0.0.1:8899).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ix, pda, MPL_CORE_ID, chainAccounts, balanceOf, nonceOf, tableCount, entryRent, guestAddress, decodeRegistry, opHash, u64be, keccak, type Event,
} from '../tools/chains.ts';
import { Client } from '../tools/client.ts';
import { assemble, word } from '../tools/asm.ts';
import { Snapshot } from '../tools/snapshot.ts';

const RPC = process.env.CHAINS_RPC ?? 'http://127.0.0.1:8899';
const conn = new Connection(RPC, 'confirmed');
const up = await conn.getVersion().then(() => true, () => false);
const ADMIN_PATH = process.env.CHAINS_ADMIN ?? 'C:/Users/Admin/chains-keys/localnet-admin.json';

const RATE = 1_000_000n; // lamports per million CU: 1 lamport per compute unit
const SOL = BigInt(LAMPORTS_PER_SOL);
const i64be = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(n); return b; };
const words = (...ws: (bigint | string | Uint8Array)[]) => Buffer.concat(ws.map((w) => (w instanceof Uint8Array ? Buffer.from(w) : Buffer.from(word(w)))));
const big = (w: Uint8Array) => BigInt('0x' + Buffer.from(w).toString('hex'));

const c = new Client(conn);
const send = c.send.bind(c);
const fails = c.fails.bind(c);
const track = c.track.bind(c);
const sendGrow = c.sendGrow.bind(c);
const read = (payer: Keypair, id: number, target: Uint8Array, data: Buffer, codes: PublicKey[]) => c.read(payer.publicKey, id, target, data, codes);
const state = c.state;
const header = c.header;

test('localnet rehearsal', { skip: up ? false : `no validator at ${RPC}`, timeout: 600_000 }, async (t) => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ADMIN_PATH, 'utf8'))));
  const [A, B, C, D] = Array.from({ length: 4 }, () => Keypair.generate());
  // The real treasury is a funded multisig; an unfunded key can't take payouts below rent-exempt.
  const treasuryKey = Keypair.generate();
  const treasury = treasuryKey.publicKey;
  for (const k of [admin, A, B, C, D, treasuryKey]) {
    const s = await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(s, 'confirmed');
  }
  assert.equal(await conn.getAccountInfo(pda.registry()), null, 'start from a fresh validator (scripts/localnet.sh)');

  await t.test('initialize: only the upgrade authority', async () => {
    const args = { launch_authority: admin.publicKey, treasury, fee_lamports_per_mcu: RATE, uri_base: 'https://chains.example/' };
    await fails(send([A], ix('initialize', { deployer: A.publicKey }, args)), 'Unauthorized');
    await send([admin], ix('initialize', { deployer: admin.publicKey }, args));
    const r = decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
    assert.ok(r.treasury.equals(treasury));
    assert.equal(r.feeLamportsPerMcu, RATE);
    assert.ok((await conn.getAccountInfo(pda.collection()))!.owner.toBase58().startsWith('CoRE'));
  });

  // A: 3 claims, B: 2, C: 2 → 7 claims for 6 chains (localnet MAX_CHAINS).
  const snap = new Snapshot([{ wallet: A.publicKey, claims: 3 }, { wallet: B.publicKey, claims: 2 }, { wallet: C.publicKey, claims: 2 }]);
  const auth = { launch_authority: admin.publicKey };
  const claim = (k: Keypair, n: number, first: number, claims?: number) => {
    const p = snap.proof(k.publicKey);
    return send([k], ix('claim', { claimer: k.publicKey, claim_record: pda.claimed(k.publicKey) },
      { proof: p.proof, total_claims: claims ?? p.claims, n },
      Array.from({ length: n }, (_, j) => ({ pubkey: pda.asset(first + j), isSigner: false, isWritable: true }))));
  };

  const now = async () => BigInt((await conn.getBlockTime(await conn.getSlot('confirmed')))!);
  const until = async (t: bigint) => { while ((await now()) < t) await new Promise((r) => setTimeout(r, 500)); };
  let opensAt = 0n;

  await t.test('mint and snapshot are set once', async () => {
    await fails(send([admin], ix('set_snapshot', auth, { slot: 1n, root: snap.root, hash: snap.fileHash(), claims_open_at: 0n })), 'SnapshotNotSet');
    await fails(send([A], ix('set_mint', { launch_authority: A.publicKey }, { mint: Keypair.generate().publicKey })), 'Unauthorized');
    await send([admin], ix('set_mint', auth, { mint: Keypair.generate().publicKey }));
    await fails(send([admin], ix('set_mint', auth, { mint: Keypair.generate().publicKey })), 'AlreadySet');
    opensAt = (await now()) + 3n;
    await send([admin], ix('set_snapshot', auth, { slot: 123n, root: snap.root, hash: snap.fileHash(), claims_open_at: opensAt }));
    await fails(send([admin], ix('set_snapshot', auth, { slot: 124n, root: snap.root, hash: snap.fileHash(), claims_open_at: 0n })), 'AlreadySet');
    assert.equal(decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data).claimsOpenAt, opensAt);
  });

  await t.test('claim: opening time, one per wallet first, limits, ids in order, SoldOut', async () => {
    await fails(claim(A, 1, 1), 'ClaimsNotOpen');
    await until(opensAt);
    await fails(claim(B, 1, 1, 5), 'NotListed');
    await fails(claim(A, 2, 1), 'OnePerWallet');
    await claim(A, 1, 1);
    await fails(claim(A, 1, 2), 'OnePerWallet');
    await claim(B, 1, 2);
    await until(opensAt + 8n); // localnet PRIORITY_WINDOW
    await claim(A, 2, 3);
    await fails(claim(A, 1, 5), 'TooManyClaims');
    await claim(B, 1, 5);
    await fails(claim(C, 2, 6), 'SoldOut');
    await claim(C, 1, 6);
    await fails(claim(C, 1, 7), 'SoldOut');
    for (const [id, k] of [[1, A], [2, B], [3, A], [4, A], [5, B], [6, C]] as const) {
      const d = (await conn.getAccountInfo(pda.asset(id)))!.data;
      assert.ok(new PublicKey(d.subarray(1, 33)).equals(k.publicKey), `chain ${id} owner`);
    }
  });

  const launch = (k: Keypair, id: number, expiry: bigint) =>
    send([k], ix('launch', { holder: k.publicKey, ...chainAccounts(id) }, { id, expiry }));
  let endsAt = 0n;

  await t.test('launch: holder only, end date rule, block 1', async () => {
    await fails(launch(A, 2, 0n), 'NotHolder');
    await fails(launch(A, 3, (await now()) + 1n), 'BadExpiry');
    // Someone pre-funds chain 1's state address; launching must still work.
    await send([D], SystemProgram.transfer({ fromPubkey: D.publicKey, toPubkey: pda.state(1), lamports: 1_000_000 }));
    track(await launch(A, 1, 0n), [opHash('launch', A.publicKey.toBytes(), i64be(0n))]);
    endsAt = (await now()) + 40n;
    track(await launch(A, 3, endsAt));
    const h = await header(1);
    assert.equal(h.height, 1n);
    assert.deepEqual(h.head, c.heads.get(1)!.head);
    await assert.rejects(launch(A, 1, 0n), 'a chain launches once');
  });

  await t.test('set_name', async () => {
    const setName = (k: Keypair, name: string) => send([k], ix('set_name', { holder: k.publicKey, ...chainAccounts(1) }, { id: 1, name }));
    await setName(A, 'Ruby One');
    assert.equal((await header(1)).name, 'Ruby One');
    await fails(setName(A, ' Ruby'), 'BadName');
    await fails(setName(B, 'Mine'), 'NotHolder');
  });

  const dep = async (k: Keypair, to: PublicKey, lamports: bigint, id = 1) =>
    track(await sendGrow(id, [k], ix('deposit', { payer: k.publicKey, ...chainAccounts(id) }, { id, beneficiary: to, lamports })));

  await t.test('deposit and withdraw', async () => {
    track(await dep(A, A.publicKey, 20n * SOL), [opHash('deposit', A.publicKey.toBytes(), A.publicKey.toBytes(), u64be(20n * SOL))]);
    track(await dep(B, B.publicKey, 10n * SOL));
    track(await dep(D, C.publicKey, 5n * SOL)); // anyone can fund anyone
    assert.equal(balanceOf(await state(1), A.publicKey), 20n * SOL);
    assert.equal(balanceOf(await state(1), C.publicKey), 5n * SOL);
    const to = Keypair.generate().publicKey;
    track(await send([B], ix('withdraw', { account: B.publicKey, recipient: to, ...chainAccounts(1) }, { id: 1, lamports: SOL })));
    assert.equal(BigInt(await conn.getBalance(to)), SOL);
    assert.equal(balanceOf(await state(1), B.publicKey), 9n * SOL);
    await fails(send([B], ix('withdraw', { account: B.publicKey, recipient: to, ...chainAccounts(1) }, { id: 1, lamports: 100n * SOL })), 'InsufficientBalance');
    await fails(dep(A, A.publicKey, 0n), 'ZeroAmount');
  });

  /** Uploads code in pieces (§8) and returns the guest address and its code account. */
  async function deploy(k: Keypair, id: number, code: Uint8Array) {
    const salt = keccak(Buffer.from(Math.random().toString()));
    const nonce = nonceOf(await state(id), k.publicKey);
    const address = guestAddress(id, k.publicKey, nonce, salt);
    const codeAcc = pda.code(id, address);
    const acc = { creator: k.publicKey, ...chainAccounts(id), code: codeAcc };
    await sendGrow(id, [k], ix('deploy_begin', acc, { id, salt, len: code.length, address }));
    for (let off = 0; off < code.length; off += 800) {
      await send([k], ix('deploy_write', acc, { id, address, offset: off, bytes: code.subarray(off, off + 800) }));
    }
    const s = track(await sendGrow(id, [k], ix('deploy_seal', acc, { id, address, max_fee: SOL })));
    const ops = s.events.filter((e) => e.name === 'BlockCommitted') as Extract<Event, { name: 'BlockCommitted' }>[];
    assert.deepEqual(new Uint8Array(ops[0].opHash), opHash('deploy', k.publicKey.toBytes(), u64be(nonce), address, Uint8Array.of(1), keccak(code)));
    return { address, codeAcc };
  }

  const call = async (k: Keypair, id: number, target: Uint8Array, value: bigint, data: Buffer, codes: PublicKey[], maxFee = SOL) =>
    track(await sendGrow(id, [k], ix('transact', { sender: k.publicKey, ...chainAccounts(id) }, { id, target: new PublicKey(target), value, data, max_steps: 10_000, max_fee: maxFee },
      codes.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })))));

  let swap: { address: Uint8Array; codeAcc: PublicKey };
  let coll: { address: Uint8Array; codeAcc: PublicKey };
  const cuLog: string[] = [];

  await t.test('deploy: bad code is rejected at seal', async () => {
    const bad = Uint8Array.of(0xff, 0, 0, 0);
    await fails(deploy(A, 1, bad), 'InvalidOpcode');
  });

  await t.test('swap: seed, buy, sell, reads, fees', async () => {
    swap = await deploy(A, 1, assemble(readFileSync(new URL('../tools/apps/swap.asm', import.meta.url), 'utf8')));
    const codes = [swap.codeAcc];
    const h0 = await header(1);
    const a0 = balanceOf(await state(1), A.publicKey);
  const n0 = tableCount(await state(1));
  const stateLamports0 = BigInt(await conn.getBalance(pda.state(1)));
    const seeded = track(await call(A, 1, swap.address, 2n * SOL, words(1n, 'Ruby Gem', 'RUBY'), codes));
    cuLog.push(`seed ${seeded.cu} CU`);
    assert.equal(big(seeded.ret!), 1_000_000n);
    const logs = seeded.events.filter((e) => e.name === 'GuestLog') as Extract<Event, { name: 'GuestLog' }>[];
    assert.equal(logs.length, 1);
    assert.equal(Buffer.from(logs[0].topics[0]).toString().replace(/\0+$/, ''), 'seed');
    const h1 = await header(1);
    const fee = h1.feesAccrued - h0.feesAccrued;
    assert.ok(fee > 20_000n, `fee ${fee} covers the overhead`);
    // Storage rent for the new entries comes out of the sender's balance and into the state account.
    const rent = (tableCount(await state(1)) - n0) * await entryRent(conn);
    assert.ok(rent > 0n, 'seeding stores new entries');
    assert.ok(BigInt(await conn.getBalance(pda.state(1))) - stateLamports0 >= rent, 'rent moved to the state account');
    assert.equal(balanceOf(await state(1), A.publicKey), a0 - 2n * SOL - fee - rent);
    assert.equal(balanceOf(await state(1), pda.chain(1)), h1.feesAccrued - h1.feesClaimed);

    // B buys with 1 SOL: 0.3% to the seeder, the rest priced on x*y=k.
    const aBefore = balanceOf(await state(1), A.publicKey);
    const bought = track(await call(B, 1, swap.address, SOL, words(2n, 1n), codes));
    cuLog.push(`buy ${bought.cu} CU`);
    const feeIn = SOL * 3n / 1000n, inn = SOL - feeIn;
    const out = 1_000_000n * inn / (2n * SOL + inn);
    assert.equal(big(bought.ret!), out);
    assert.equal(balanceOf(await state(1), A.publicKey), aBefore + feeIn);
    assert.equal(big((await read(B, 1, swap.address, words(4n, B.publicKey.toBytes()), codes))!), out);
    assert.equal(big((await read(B, 1, swap.address, words(7n), codes))!), 2n * SOL + inn);

    // B sells half back.
    const half = out / 2n;
    const solR = 2n * SOL + inn, tokR = 1_000_000n - out;
    const gross = solR * half / (tokR + half);
    const net = gross - gross * 3n / 1000n;
    const bBefore = balanceOf(await state(1), B.publicKey);
    const sold = track(await call(B, 1, swap.address, 0n, words(3n, half, 1n), codes));
    cuLog.push(`sell ${sold.cu} CU`);
    assert.equal(big(sold.ret!), net);
    assert.ok(balanceOf(await state(1), B.publicKey) < bBefore + net, 'paid a chain fee');

    // Failure cases change nothing and charge nothing.
    const before = await header(1);
    await fails(call(B, 1, swap.address, 0n, words(3n, 10n ** 12n, 0n), codes), 'RequireFailed');
    await fails(call(B, 1, swap.address, SOL, words(2n, 1n), []), 'MissingCode');
    await fails(call(B, 1, swap.address, SOL, words(2n, 1n), codes, 0n), 'FeeTooHigh');
    await fails(call(B, 1, swap.address, 0n, words(9n), codes), 'Reverted');
    const after = await header(1);
    assert.equal(after.height, before.height);
    assert.equal(after.feesAccrued, before.feesAccrued);
  });

  await t.test('collection: create, mint at price, cap, transfer', async () => {
    coll = await deploy(C, 1, assemble(readFileSync(new URL('../tools/apps/collection.asm', import.meta.url), 'utf8')));
    const codes = [coll.codeAcc];
    const price = SOL / 10n;
    track(await call(C, 1, coll.address, 0n, words(1n, keccak(Buffer.from('meta')), 2n, price), codes));
    const cBefore = balanceOf(await state(1), C.publicKey);
    const m1 = track(await call(B, 1, coll.address, price, words(2n), codes));
    cuLog.push(`mint ${m1.cu} CU`);
    assert.equal(big(m1.ret!), 1n);
    assert.equal(balanceOf(await state(1), C.publicKey), cBefore + price);
    await fails(call(B, 1, coll.address, price - 1n, words(2n), codes), 'RequireFailed');
    assert.equal(big((await call(A, 1, coll.address, price, words(2n), codes)).ret!), 2n);
    await fails(call(B, 1, coll.address, price, words(2n), codes), 'RequireFailed');
    await call(B, 1, coll.address, 0n, words(3n, 1n, D.publicKey.toBytes()), codes);
    assert.ok(new PublicKey((await read(B, 1, coll.address, words(4n, 1n), codes))!).equals(D.publicKey));
    await fails(call(B, 1, coll.address, 0n, words(3n, 1n, B.publicKey.toBytes()), codes), 'RequireFailed');
  });

  await t.test('deep calls: MAX_DEPTH nested calls fit in a transaction', async () => {
    const rec = await deploy(A, 1, assemble(readFileSync(new URL('../tools/apps/recurse.asm', import.meta.url), 'utf8')));
    const deep = await call(A, 1, rec.address, 0n, words(8n), [rec.codeAcc]);
    assert.equal(big(deep.ret!), 8n);
    cuLog.push(`depth-8 call ${deep.cu} CU`);
    await fails(call(A, 1, rec.address, 0n, words(9n), [rec.codeAcc]), 'DepthLimit');
  });

  await t.test('fully backed: balances add up to total_deposits', async () => {
    const s = await state(1);
    const who = [A.publicKey, B.publicKey, C.publicKey, D.publicKey, pda.chain(1), new PublicKey(swap.address), new PublicKey(coll.address)];
    const sum = who.reduce((acc, k) => acc + balanceOf(s, k), 0n);
    const h = await header(1);
    assert.equal(sum, h.totalDeposits);
    const info = (await conn.getAccountInfo(pda.chain(1)))!;
    const rent = BigInt(await conn.getMinimumBalanceForRentExemption(info.data.length));
    assert.ok(BigInt(info.lamports) >= rent + h.totalDeposits);
    assert.deepEqual(h.head, c.heads.get(1)!.head);
    assert.equal(h.height, c.heads.get(1)!.height);
  });

  await t.test('claim_fees: half to the holder, half to the treasury', async () => {
    const h = await header(1);
    const unclaimed = h.feesAccrued - h.feesClaimed;
    const aBefore = BigInt(await conn.getBalance(A.publicKey));
    const tBefore = BigInt(await conn.getBalance(treasury));
    const pay = { registry: pda.registry(), ...chainAccounts(1), holder: A.publicKey, treasury };
    await fails(send([B], ix('claim_fees', { ...pay, holder: B.publicKey }, { id: 1 })), 'BadPayee');
    track(await send([D], ix('claim_fees', pay, { id: 1 })), [opHash('claim', A.publicKey.toBytes(), treasury.toBytes(), u64be(unclaimed))]);
    assert.equal(BigInt(await conn.getBalance(A.publicKey)) - aBefore, unclaimed - unclaimed / 2n);
    assert.equal(BigInt(await conn.getBalance(treasury)) - tBefore, unclaimed / 2n);
    assert.equal(balanceOf(await state(1), pda.chain(1)), 0n);
    await fails(send([D], ix('claim_fees', pay, { id: 1 })), 'ZeroAmount');
  });

  await t.test('end date and sweep', async () => {
    track(await dep(B, B.publicKey, 3n * SOL, 3));
    track(await call(B, 3, D.publicKey.toBytes(), SOL, Buffer.alloc(0), [])); // a plain transfer, with a fee
    assert.equal(balanceOf(await state(3), D.publicKey), SOL);
    const pay = { registry: pda.registry(), ...chainAccounts(3), holder: A.publicKey, treasury };
    await fails(send([D], ix('sweep', pay, { id: 3 })), 'NotEnded');
    while ((await now()) < endsAt) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 1500));
    await fails(dep(B, B.publicKey, SOL, 3), 'ChainEnded');
    await fails(send([D], ix('claim_fees', pay, { id: 3 })), 'ChainEnded');

    // The holder burns the chain's NFT: the holder's share goes to the treasury instead of getting stuck.
    await send([A], new TransactionInstruction({
      programId: MPL_CORE_ID,
      keys: [
        { pubkey: pda.asset(3), isSigner: false, isWritable: true },
        { pubkey: pda.collection(), isSigner: false, isWritable: true },
        { pubkey: A.publicKey, isSigner: true, isWritable: true },
        ...[MPL_CORE_ID, MPL_CORE_ID, MPL_CORE_ID].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      ],
      data: Buffer.from([12, 0]), // BurnV1, no compression proof
    }));
    await fails(send([D], ix('sweep', pay, { id: 3 })), 'BadPayee');
    const burned = { ...pay, holder: treasury };

    const h = await header(3);
    const fees = h.feesAccrued - h.feesClaimed;
    const stateLamports = BigInt(await conn.getBalance(pda.state(3)));
    const aBefore = BigInt(await conn.getBalance(A.publicKey));
    const tBefore = BigInt(await conn.getBalance(treasury));
    const s = await send([D], ix('sweep', burned, { id: 3 }));
    assert.equal(BigInt(await conn.getBalance(treasury)) - tBefore, h.totalDeposits + stateLamports);
    assert.equal(BigInt(await conn.getBalance(A.publicKey)), aBefore);
    assert.equal(await conn.getAccountInfo(pda.state(3)), null, 'state account closed');
    const after = await header(3);
    assert.equal(after.status, 1);
    assert.equal(after.totalDeposits, 0n);
    assert.equal(after.height, h.height, 'header keeps its final head and height');
    assert.ok(s.events.some((e) => e.name === 'Swept'));
    await fails(send([D], ix('sweep', burned, { id: 3 })), 'AlreadySwept');
  });

  t.diagnostic(`compute: ${cuLog.join(', ')}`);
});
