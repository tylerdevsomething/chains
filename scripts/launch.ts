// Launch-day steps for a Chains deployment (mainnet or a rehearsal on devnet), one command each.
// Every command prints what it will do and stops; add --send to do it. Safe to re-run: steps that
// are already done on chain are reported and skipped. See LAUNCH.md for the order and the checks.
//
//   node scripts/launch.ts status
//   node scripts/launch.ts init        --treasury <MULTISIG> --uri-base https://<domain>/ [--rate 1000000] [--send]
//   node scripts/launch.ts set-mint    --mint <CHAINS_MINT> [--send]
//   node scripts/launch.ts announce    --w0 <SLOT> --w1 <SLOT> --reveal <SLOT>      (writes the announcement file)
//   node scripts/launch.ts pick-slot                                              (after the reveal slot is finalized)
//   node scripts/launch.ts snapshot                                               (builds the claims list at the slot)
//   node scripts/launch.ts set-snapshot --opens-at <ISO time> [--send]
//   node scripts/launch.ts handover    --to <MULTISIG>                             (prints the upgrade-authority command)
//
// Env: CHAINS_CLUSTER (mainnet-beta | devnet; default devnet), CHAINS_RPC (default: the public RPC of
// the cluster; use a private one on mainnet), CHAINS_ADMIN (keypair path: the upgrade authority, which
// becomes the launch authority).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { PROGRAM_ID, ix, pda, decodeRegistry, BPF_LOADER_UPGRADEABLE } from '../tools/chains.ts';
import { Snapshot } from '../tools/snapshot.ts';
import { pickSlot, revealBlock } from '../tools/snapshot-slot.ts';
import { buildSnapshot } from '../indexer/build-snapshot.ts';

const CLUSTER = process.env.CHAINS_CLUSTER ?? 'devnet';
const RPC = process.env.CHAINS_RPC ?? (CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const ADMIN = process.env.CHAINS_ADMIN;
const DEPLOY = new URL('../deploy/', import.meta.url);
const ANNOUNCE = new URL(`announcement.${CLUSTER}.json`, DEPLOY);
const SNAPSHOT_CSV = new URL(`snapshot.${CLUSTER}.csv`, DEPLOY);
const SNAPSHOT_JSON = new URL(`snapshot.${CLUSTER}.json`, DEPLOY);
const PRIORITY_WINDOW = 24 * 3600;

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const need = (k: string) => {
  const v = arg(k);
  if (!v) die(`missing --${k}`);
  return v!;
};
const SEND = argv.includes('--send');
function die(m: string): never {
  console.error(`✗ ${m}`);
  process.exit(1);
}
const say = (m: string) => console.log(m);
const path = (u: URL) => fileURLToPath(u);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const conn = new Connection(RPC, 'confirmed');
const admin = () => {
  if (!ADMIN) die('set CHAINS_ADMIN to the admin keypair path');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ADMIN!, 'utf8'))));
};

type Announcement = { cluster: string; mint: string; w0: number; w1: number; reveal: number; revealBlock?: number; blockhash?: string; snapshotSlot?: number; opensAt?: number; sha256?: string; root?: string };
const readAnn = (): Announcement | null => (existsSync(ANNOUNCE) ? JSON.parse(readFileSync(ANNOUNCE, 'utf8')) : null);
const writeAnn = (a: Announcement) => {
  mkdirSync(DEPLOY, { recursive: true });
  writeFileSync(ANNOUNCE, JSON.stringify(a, null, 2) + '\n');
};

async function registry() {
  const info = await conn.getAccountInfo(pda.registry());
  return info ? decodeRegistry(info.data) : null;
}

async function upgradeAuthority(): Promise<string | null> {
  const pd = await conn.getAccountInfo(pda.programData());
  if (!pd) return null;
  return pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : 'none (immutable)';
}

async function send(label: string, ...ixs: ReturnType<typeof ix>[]) {
  const k = admin();
  if (!SEND) {
    say(`… dry run: would send "${label}" from ${k.publicKey.toBase58()}. Add --send to do it.`);
    return;
  }
  const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs);
  const sig = await sendAndConfirmTransaction(conn, t, [k], { commitment: 'confirmed' });
  say(`✓ ${label}: ${sig}`);
}

say(`cluster ${CLUSTER} · rpc ${RPC.replace(/(api-key|apikey)=[^&]+/i, '$1=…')} · program ${PROGRAM_ID.toBase58()}`);

switch (cmd) {
  case 'status': {
    const prog = await conn.getAccountInfo(PROGRAM_ID);
    say(`program      ${prog ? (prog.owner.equals(BPF_LOADER_UPGRADEABLE) ? 'deployed' : 'exists, wrong owner!') : 'NOT DEPLOYED'}`);
    say(`upgrade auth ${await upgradeAuthority()}`);
    if (ADMIN) {
      const k = admin();
      say(`admin        ${k.publicKey.toBase58()} (${(await conn.getBalance(k.publicKey)) / LAMPORTS_PER_SOL} SOL)`);
    }
    const r = await registry();
    if (!r) {
      say('registry     not initialized → next: init');
      break;
    }
    say(`launch auth  ${r.launchAuthority.toBase58()}`);
    say(`treasury     ${r.treasury.toBase58()}`);
    say(`fee rate     ${r.feeLamportsPerMcu} lamports per million units`);
    say(`collection   ${r.collection.toBase58()}`);
    say(`mint         ${r.chainsMint.equals(PublicKey.default) ? 'not set → next: set-mint' : r.chainsMint.toBase58()}`);
    const a = readAnn();
    say(`announcement ${a ? `window ${a.w0}–${a.w1}, reveal ${a.reveal}${a.snapshotSlot ? `, snapshot slot ${a.snapshotSlot}` : ''}` : 'none → next: announce'}`);
    if (r.snapshotSlot === 0n) say('snapshot     not set → next: pick-slot, snapshot, set-snapshot');
    else {
      say(`snapshot     slot ${r.snapshotSlot}, root ${hex(r.snapshotRoot)}`);
      const open = Number(r.claimsOpenAt);
      say(`claims open  ${new Date(open * 1000).toISOString()} (one per wallet until ${new Date((open + PRIORITY_WINDOW) * 1000).toISOString()})`);
      say(`claimed      ${r.claimed} of 500`);
      if (existsSync(SNAPSHOT_CSV)) {
        const snap = Snapshot.parse(readFileSync(SNAPSHOT_CSV, 'utf8'));
        say(`published    ${Buffer.from(snap.root).equals(Buffer.from(r.snapshotRoot)) ? 'deploy file matches the root on chain ✓' : 'deploy file does NOT match the root on chain ✗'}`);
      }
    }
    break;
  }

  case 'init': {
    if (await registry()) die('already initialized');
    const treasury = new PublicKey(need('treasury'));
    const uriBase = need('uri-base');
    if (!/^https:\/\/[^/]+\/$/.test(uriBase)) die('--uri-base must look like https://domain/ (with the trailing slash)');
    const rate = BigInt(arg('rate') ?? '1000000');
    const k = admin();
    const ua = await upgradeAuthority();
    if (ua !== k.publicKey.toBase58()) die(`only the upgrade authority can initialize (it is ${ua})`);
    if ((await conn.getAccountInfo(treasury))?.owner && CLUSTER === 'mainnet-beta') say(`note: treasury account exists and is owned by ${(await conn.getAccountInfo(treasury))!.owner.toBase58()}`);
    say(`initialize: launch authority ${k.publicKey.toBase58()}, treasury ${treasury.toBase58()}, rate ${rate}, uri base ${uriBase}`);
    say('These can never change. Check the treasury address against your Squads vault, character by character.');
    await send('initialize', ix('initialize', { deployer: k.publicKey }, { launch_authority: k.publicKey, treasury, fee_lamports_per_mcu: rate, uri_base: uriBase }));
    break;
  }

  case 'set-mint': {
    const r = await registry();
    if (!r) die('initialize first');
    if (!r.chainsMint.equals(PublicKey.default)) die(`mint already set: ${r.chainsMint.toBase58()}`);
    const mint = new PublicKey(need('mint'));
    const info = await conn.getParsedAccountInfo(mint);
    const parsed = (info.value?.data as { parsed?: { type: string; info: { decimals: number; supply: string } } })?.parsed;
    if (parsed?.type !== 'mint') die(`${mint.toBase58()} is not a token mint on ${CLUSTER}`);
    say(`$CHAINS mint ${mint.toBase58()}: decimals ${parsed.info.decimals}, supply ${parsed.info.supply}`);
    await send('set_mint', ix('set_mint', { launch_authority: admin().publicKey }, { mint }));
    break;
  }

  case 'announce': {
    const r = await registry();
    if (!r || r.chainsMint.equals(PublicKey.default)) die('set the mint first');
    const w0 = Number(need('w0')), w1 = Number(need('w1')), reveal = Number(need('reveal'));
    const now = await conn.getSlot('finalized');
    if (!(w0 > now && w1 > w0 && reveal >= w1 + 150)) die(`need now (${now}) < w0 < w1 and reveal ≥ w1 + 150`);
    const a: Announcement = { cluster: CLUSTER, mint: r.chainsMint.toBase58(), w0, w1, reveal };
    writeAnn(a);
    const secs = (s: number) => Math.round((s - now) * 0.4);
    say(`✓ wrote ${path(ANNOUNCE)}`);
    say(`Window opens in about ${(secs(w0) / 3600).toFixed(1)}h and closes in about ${(secs(w1) / 3600).toFixed(1)}h; the reveal slot comes about ${secs(reveal - w1 + now)}s after that (slots are ~0.4s; times are estimates).`);
    say('Post the window and reveal slot publicly now, before the window opens, then deploy the site so it shows them.');
    break;
  }

  case 'pick-slot': {
    const a = readAnn() ?? die('announce first');
    const rb = await revealBlock(conn, a.reveal).catch((e) => die((e as Error).message));
    const s = pickSlot(BigInt(a.w0), BigInt(a.w1), rb.blockhash);
    Object.assign(a, { revealBlock: rb.slot, blockhash: rb.blockhash, snapshotSlot: Number(s) });
    writeAnn(a);
    say(`✓ reveal block ${rb.slot} (${rb.blockhash}) → snapshot slot ${s}`);
    say(`Anyone can check: node tools/snapshot-slot.ts ${a.w0} ${a.w1} ${a.reveal}`);
    break;
  }

  case 'snapshot': {
    const a = readAnn() ?? die('announce first');
    if (!a.snapshotSlot) die('pick-slot first');
    const final = await conn.getSlot('finalized');
    if (final < a.snapshotSlot + 32) die(`slot ${a.snapshotSlot} is not finalized yet (finalized: ${final})`);
    const r = await buildSnapshot(new Connection(RPC, 'finalized'), new PublicKey(a.mint), a.snapshotSlot, (m) => console.error(m));
    if (!r.snapshot) die('nobody held 1,000,000 or more at the slot');
    writeFileSync(SNAPSHOT_CSV, r.snapshot.file());
    const out = new URL(`snapshot-${CLUSTER}-${a.snapshotSlot}/`, DEPLOY);
    mkdirSync(out, { recursive: true });
    writeFileSync(new URL('balances.csv', out), 'owner,raw_balance,claims,counted,note\n' + r.holdings.map((h) => `${h.owner},${h.raw},${h.claims},${h.counted},${h.note}`).join('\n') + '\n');
    const summary = {
      mint: a.mint, slot: a.snapshotSlot, decimals: r.decimals, wallets: r.snapshot.entries.length,
      claims: r.snapshot.entries.reduce((x, e) => x + e.claims, 0), sha256: hex(r.snapshot.fileHash()), root: hex(r.snapshot.root),
    };
    writeFileSync(SNAPSHOT_JSON, JSON.stringify(summary, null, 2) + '\n');
    Object.assign(a, { sha256: summary.sha256, root: summary.root });
    writeAnn(a);
    say(JSON.stringify(summary, null, 2));
    say(`✓ wrote ${path(SNAPSHOT_CSV)} and ${path(SNAPSHOT_JSON)}. Check the top holders in ${path(new URL('balances.csv', out))} (pools and vaults must show counted=false).`);
    if (summary.claims < 500) say(`note: only ${summary.claims} claims for 500 chains; the rest stay unclaimed until holders run out.`);
    break;
  }

  case 'set-snapshot': {
    const r = await registry();
    if (!r) die('initialize first');
    if (r.snapshotSlot !== 0n) die(`snapshot already set (slot ${r.snapshotSlot})`);
    const a = readAnn() ?? die('announce first');
    if (!a.snapshotSlot || !existsSync(SNAPSHOT_CSV)) die('run pick-slot and snapshot first');
    const snap = Snapshot.parse(readFileSync(SNAPSHOT_CSV, 'utf8'));
    if (a.root && hex(snap.root) !== a.root) die('the snapshot file changed since it was built');
    const opensAt = Math.floor(new Date(need('opens-at')).getTime() / 1000);
    if (!Number.isFinite(opensAt) || opensAt < Date.now() / 1000) die('--opens-at must be a future time, e.g. 2027-01-15T17:00:00Z');
    Object.assign(a, { opensAt });
    writeAnn(a);
    say(`set_snapshot: slot ${a.snapshotSlot}, root ${hex(snap.root)}, file sha256 ${hex(snap.fileHash())}`);
    say(`claims open ${new Date(opensAt * 1000).toISOString()}; one per wallet until ${new Date((opensAt + PRIORITY_WINDOW) * 1000).toISOString()}`);
    say('Deploy the site with this snapshot file BEFORE claims open, or the claim page has no proofs to give.');
    await send('set_snapshot', ix('set_snapshot', { launch_authority: admin().publicKey }, { slot: BigInt(a.snapshotSlot), root: snap.root, hash: snap.fileHash(), claims_open_at: BigInt(opensAt) }));
    break;
  }

  case 'handover': {
    const to = new PublicKey(need('to'));
    say(`Current upgrade authority: ${await upgradeAuthority()}`);
    say('Run this yourself (Solana CLI, in WSL), with the current authority keypair:');
    say(`  solana program set-upgrade-authority ${PROGRAM_ID.toBase58()} --new-upgrade-authority ${to.toBase58()} --skip-new-upgrade-authority-signer-check -u ${CLUSTER === 'mainnet-beta' ? 'm' : CLUSTER === 'localnet' ? 'l' : 'd'} -k <current-authority.json>`);
    say('Then confirm with: node scripts/launch.ts status');
    say('Or make the program immutable instead (no more fixes, ever): solana program set-upgrade-authority <id> --final');
    break;
  }

  default:
    say('commands: status, init, set-mint, announce, pick-slot, snapshot, set-snapshot, handover (see the top of this file)');
}
