// Launch-day rehearsal on a fresh local validator, with the mainnet build and throwaway keys.
// Runs every step of LAUNCH.md through scripts/launch.ts, exactly as on mainnet, and checks the
// results: a fake $CHAINS token (6 decimals, like pump.fun) with known holders, the announced
// window, the slot picked from the reveal blockhash, the snapshot built from chain history (a
// program-owned vault must not count), set_snapshot, and the claim API serving proofs.
//
//   anchor build                    (the real build: no localnet feature)
//   bash scripts/localnet.sh        (WSL; fresh validator)
//   node scripts/rehearse-launch.ts
//
// Env: CHAINS_RPC (default http://127.0.0.1:8899), LOCAL_ADMIN (the validator's upgrade authority).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer } from '@solana/spl-token';
import { pda, decodeRegistry } from '../tools/chains.ts';
import { Snapshot } from '../tools/snapshot.ts';
import { Claims } from '../indexer/claims.ts';

const RPC = process.env.CHAINS_RPC ?? 'http://127.0.0.1:8899';
const ADMIN = process.env.LOCAL_ADMIN ?? 'C:/Users/Admin/chains-keys/localnet-admin.json';
const conn = new Connection(RPC, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEC = 6;
const M = (n: number) => BigInt(n) * 1_000_000n * 10n ** BigInt(DEC); // n million tokens

const env = { ...process.env, CHAINS_CLUSTER: 'localnet', CHAINS_RPC: RPC, CHAINS_ADMIN: ADMIN };
function launch(...args: string[]) {
  const out = execFileSync(process.execPath, ['scripts/launch.ts', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out.trim().split('\n').map((l) => '    ' + l).join('\n'));
  return out;
}
function launchFails(expect: RegExp, ...args: string[]) {
  try {
    execFileSync(process.execPath, ['scripts/launch.ts', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? e);
    assert.match(msg, expect);
    console.log(`    refused as expected: ${msg.trim().split('\n').pop()}`);
    return;
  }
  assert.fail(`expected launch.ts ${args[0]} to refuse`);
}
async function step(name: string, f: () => Promise<void> | void) {
  console.log(`\n▸ ${name}`);
  await f();
}
async function waitSlot(target: number, commitment: 'confirmed' | 'finalized' = 'finalized') {
  for (;;) {
    const s = await conn.getSlot(commitment);
    if (s >= target) return;
    await sleep(Math.min(5000, Math.max(400, (target - s) * 300)));
  }
}

for (const f of ['announcement.localnet.json', 'snapshot.localnet.csv', 'snapshot.localnet.json']) rmSync(new URL(`../deploy/${f}`, import.meta.url), { force: true });

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ADMIN, 'utf8'))));
const treasury = Keypair.generate().publicKey; // stands in for the Squads vault
const [creator, h1, h2, h3, h4, late] = Array.from({ length: 6 }, () => Keypair.generate());
const vaultOwner = PublicKey.findProgramAddressSync([Buffer.from('pool')], new PublicKey('11111111111111111111111111111112'))[0]; // off-curve, like a bonding curve

await step('fresh validator with the mainnet build', async () => {
  assert.equal(await conn.getAccountInfo(pda.registry()), null, 'registry already exists: restart the validator (scripts/localnet.sh)');
  for (const k of [admin, creator, h1, h2, h3, h4, late]) {
    const sig = await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  launch('status');
});

await step('init (dry run, then send); bad inputs refused', async () => {
  launchFails(/uri-base/, 'init', '--treasury', treasury.toBase58(), '--uri-base', 'https://chains.test');
  const dry = launch('init', '--treasury', treasury.toBase58(), '--uri-base', 'https://chains.test/');
  assert.match(dry, /dry run/);
  assert.equal(await conn.getAccountInfo(pda.registry()), null, 'dry run sent nothing');
  launch('init', '--treasury', treasury.toBase58(), '--uri-base', 'https://chains.test/', '--send');
  const r = decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
  assert.ok(r.treasury.equals(treasury));
  assert.ok(r.launchAuthority.equals(admin.publicKey));
  assert.equal(r.feeLamportsPerMcu, 1_000_000n);
  launchFails(/already initialized/, 'init', '--treasury', treasury.toBase58(), '--uri-base', 'https://chains.test/', '--send');
});

let mint: PublicKey;
await step('a fake $CHAINS: 1B supply, 6 decimals; holders before the window', async () => {
  mint = await createMint(conn, creator, creator.publicKey, null, DEC);
  const ata = async (owner: PublicKey, offCurve = false) => (await getOrCreateAssociatedTokenAccount(conn, creator, mint, owner, offCurve)).address;
  const src = await ata(creator.publicKey);
  await mintTo(conn, creator, mint, src, creator, M(1000));
  for (const [k, n] of [[h1, 3.5], [h2, 1.2], [h3, 0.9], [h4, 2]] as const) await transfer(conn, creator, src, await ata(k.publicKey), creator, BigInt(n * 1e6) * 10n ** BigInt(DEC));
  await transfer(conn, creator, src, await ata(vaultOwner, true), creator, M(300)); // a "bonding curve" vault: must not count
  launchFails(/not a token mint/, 'set-mint', '--mint', h1.publicKey.toBase58(), '--send');
  launch('set-mint', '--mint', mint.toBase58(), '--send');
});

let w0 = 0, w1 = 0, reveal = 0;
await step('announce the window and reveal slot', async () => {
  const now = await conn.getSlot('finalized');
  w0 = now + 40;
  w1 = w0 + 60;
  reveal = w1 + 150;
  launchFails(/reveal/, 'announce', '--w0', String(w0), '--w1', String(w1), '--reveal', String(w1 + 10));
  launch('announce', '--w0', String(w0), '--w1', String(w1), '--reveal', String(reveal));
});

await step('after the window: holders move tokens (must not change the snapshot)', async () => {
  await waitSlot(w1 + 1, 'confirmed');
  const ata = async (owner: PublicKey) => (await getOrCreateAssociatedTokenAccount(conn, creator, mint, owner)).address;
  await transfer(conn, h4, await ata(h4.publicKey), await ata(late.publicKey), h4, M(2)); // h4 sells everything after the window
  await transfer(conn, creator, await ata(creator.publicKey), await ata(h3.publicKey), creator, M(5)); // h3 buys after the window
});

let snapSlot = 0;
await step('pick-slot from the reveal blockhash (refused until it is finalized)', async () => {
  if ((await conn.getSlot('finalized')) < reveal) launchFails(/no finalized block|not available/, 'pick-slot');
  await waitSlot(reveal + 2);
  launch('pick-slot');
  const a = JSON.parse(readFileSync(new URL('../deploy/announcement.localnet.json', import.meta.url), 'utf8'));
  snapSlot = a.snapshotSlot;
  assert.ok(snapSlot >= w0 && snapSlot <= w1, 'slot inside the window');
});

await step('snapshot from chain history at the slot', async () => {
  await waitSlot(snapSlot + 40);
  launch('snapshot');
  const csv = readFileSync(new URL('../deploy/snapshot.localnet.csv', import.meta.url), 'utf8');
  const got = Object.fromEntries(csv.trim().split('\n').map((l) => l.split(',')).map(([w, c]) => [w, Number(c)]));
  // Creator: 1000 − 7.6 − 300 = 692.4M → 692 claims. h1 3, h2 1, h4 2 (held at S), h3 0 (0.9M at S).
  const want = { [creator.publicKey.toBase58()]: 692, [h1.publicKey.toBase58()]: 3, [h2.publicKey.toBase58()]: 1, [h4.publicKey.toBase58()]: 2 };
  assert.deepEqual(got, want, 'claims at the slot; the off-curve vault and post-window moves are ignored');
});

await step('set-snapshot; claims open shortly', async () => {
  launchFails(/future/, 'set-snapshot', '--opens-at', '2020-01-01T00:00:00Z', '--send');
  launch('set-snapshot', '--opens-at', new Date(Date.now() + 15_000).toISOString(), '--send');
  const r = decodeRegistry((await conn.getAccountInfo(pda.registry()))!.data);
  const snap = Snapshot.parse(readFileSync(new URL('../deploy/snapshot.localnet.csv', import.meta.url), 'utf8'));
  assert.deepEqual(new Uint8Array(r.snapshotRoot), new Uint8Array(snap.root));
  assert.equal(Number(r.snapshotSlot), snapSlot);
  launchFails(/already set/, 'set-snapshot', '--opens-at', new Date(Date.now() + 60_000).toISOString(), '--send');
});

await step('claim through the site API (one per wallet in the first 24h)', async () => {
  const claims = new Claims(conn, new URL('../deploy/snapshot.localnet.csv', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  let s = await claims.status(h1.publicKey);
  assert.equal(s.problem, null);
  assert.equal(s.claims, 3);
  assert.equal(s.canClaimNow, 0, 'not open yet');
  await sleep(Math.max(0, (s.opensAt - s.now + 3) * 1000));
  s = await claims.status(h1.publicKey);
  assert.equal(s.canClaimNow, 1, 'one per wallet in the window');
  const t = await claims.tx(h1.publicKey, 1);
  const tx = Transaction.populate((await import('@solana/web3.js')).Message.from((await import('bs58')).default.decode(t.message)));
  tx.sign(h1);
  await sendAndConfirmTransaction(conn, tx, [h1], { commitment: 'confirmed' }).catch(async () => {
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
  });
  s = await claims.status(h1.publicKey);
  assert.equal(s.used, 1);
  assert.equal(s.canClaimNow, 0);
  assert.equal((await claims.status(h3.publicKey)).listed, false, 'h3 held under 1M at the slot');
  launch('status');
});

await step('handover prints the upgrade-authority command', () => {
  assert.match(launch('handover', '--to', treasury.toBase58()), /set-upgrade-authority/);
});

console.log('\n✓ launch rehearsal passed');
