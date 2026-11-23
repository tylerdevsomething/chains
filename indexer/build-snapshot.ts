// The $CHAINS snapshot (SPEC §3): every wallet's balance at the end of slot S, from finalized
// history only, and the claims list with its SHA-256 and Merkle root.
//
//   node indexer/build-snapshot.ts --mint <MINT> --slot <S> [--rpc URL] [--out DIR]
//
// How: every token account that ever held the mint shows up in a transaction that touched the
// mint (its creation does). For each one, its balance and owner at S come from postTokenBalances
// of its last successful transaction at or before S. Owners are summed per wallet; only on-curve
// (ed25519) owners count, which leaves out the bonding curve, pools and other program vaults.

import { mkdirSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey, type ConfirmedSignatureInfo, type TokenBalance, type VersionedTransactionResponse } from '@solana/web3.js';
import { Snapshot, type Entry } from '../tools/snapshot.ts';

export type Holding = { owner: string; raw: bigint; claims: number; counted: boolean; note: string };

type Seen = { sig: string; slot: number; raw: bigint; owner: string | null };

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}

/** All successful signatures for `addr`, newest first, stopping once older than `minSlot` is reached (if set). */
async function signatures(conn: Connection, addr: PublicKey, opts: { stopAtOrBelow?: number } = {}): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(addr, { before, limit: 1000 }, 'finalized');
    out.push(...page);
    if (page.length < 1000) break;
    if (opts.stopAtOrBelow !== undefined && page[page.length - 1].slot <= opts.stopAtOrBelow) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

async function tx(conn: Connection, sig: string): Promise<VersionedTransactionResponse> {
  for (let i = 0; ; i++) {
    const t = await conn.getTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (t) return t;
    if (i > 5) throw new Error(`transaction ${sig} not found`);
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
}

function keysOf(t: VersionedTransactionResponse): PublicKey[] {
  const m = t.transaction.message;
  const lookups = t.meta?.loadedAddresses;
  return [...m.staticAccountKeys, ...(lookups?.writable ?? []), ...(lookups?.readonly ?? [])];
}

/** Post-transaction balance and owner of each account of `mint` the transaction lists. */
function postBalances(t: VersionedTransactionResponse, mint: string): Map<string, { raw: bigint; owner: string | null }> {
  const keys = keysOf(t);
  const out = new Map<string, { raw: bigint; owner: string | null }>();
  const pre = (t.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint);
  const post = (t.meta?.postTokenBalances ?? []).filter((b) => b.mint === mint);
  // Listed before but not after: the account was closed in this transaction.
  for (const b of pre) out.set(keys[b.accountIndex].toBase58(), { raw: 0n, owner: b.owner ?? null });
  for (const b of post as TokenBalance[]) out.set(keys[b.accountIndex].toBase58(), { raw: BigInt(b.uiTokenAmount.amount), owner: b.owner ?? null });
  return out;
}

export async function buildSnapshot(conn: Connection, mintKey: PublicKey, slot: number, log = (_: string) => {}) {
  const mint = mintKey.toBase58();
  const mintInfo = await conn.getAccountInfo(mintKey, 'finalized');
  if (!mintInfo) throw new Error(`mint ${mint} not found`);
  const decimals = mintInfo.data[44];
  const perClaim = 1_000_000n * 10n ** BigInt(decimals);

  // 1. Every token account of the mint, and its last balance among the mint's own transactions.
  const mintSigs = (await signatures(conn, mintKey)).filter((s) => !s.err && s.slot <= slot);
  log(`${mintSigs.length} transactions touched the mint up to slot ${slot}`);
  const seen = new Map<string, Seen>();
  // Oldest first, so later transactions overwrite earlier ones.
  const ordered = mintSigs.slice().reverse();
  const results: (Map<string, { raw: bigint; owner: string | null }> | null)[] = new Array(ordered.length).fill(null);
  let done = 0;
  await pool(ordered.map((s, i) => ({ s, i })), 6, async ({ s, i }) => {
    results[i] = postBalances(await tx(conn, s.signature), mint);
    if (++done % 200 === 0) log(`  mint history ${done}/${ordered.length}`);
  });
  ordered.forEach((s, i) => {
    for (const [acc, b] of results[i]!) seen.set(acc, { sig: s.signature, slot: s.slot, raw: b.raw, owner: b.owner ?? seen.get(acc)?.owner ?? null });
  });
  log(`${seen.size} token accounts`);

  // 2. Each account's last transaction at or before S may not mention the mint (a plain transfer).
  done = 0;
  await pool([...seen.keys()], 6, async (acc) => {
    const sigs = await signatures(conn, new PublicKey(acc), { stopAtOrBelow: slot });
    const last = sigs.find((s) => !s.err && s.slot <= slot);
    const cur = seen.get(acc)!;
    if (last && last.signature !== cur.sig) {
      const b = postBalances(await tx(conn, last.signature), mint).get(acc);
      seen.set(acc, { sig: last.signature, slot: last.slot, raw: b?.raw ?? cur.raw, owner: b?.owner ?? cur.owner });
    }
    if (++done % 200 === 0) log(`  accounts ${done}/${seen.size}`);
  });

  // 3. Per owner.
  const byOwner = new Map<string, bigint>();
  for (const s of seen.values()) {
    if (!s.owner || s.raw === 0n) continue;
    byOwner.set(s.owner, (byOwner.get(s.owner) ?? 0n) + s.raw);
  }
  const holdings: Holding[] = [...byOwner.entries()]
    .map(([owner, raw]) => {
      const onCurve = PublicKey.isOnCurve(new PublicKey(owner).toBytes());
      const claims = onCurve ? Number(raw / perClaim) : 0;
      return { owner, raw, claims, counted: onCurve, note: onCurve ? (claims ? '' : 'under 1M') : 'owner is a program address (PDA)' };
    })
    .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : a.owner.localeCompare(b.owner)));
  const entries: Entry[] = holdings.filter((h) => h.claims > 0).map((h) => ({ wallet: new PublicKey(h.owner), claims: h.claims }));
  return { mint, slot, decimals, holdings, snapshot: entries.length ? new Snapshot(entries) : null };
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (import.meta.main) {
  const mint = arg('mint'), slot = arg('slot');
  if (!mint || !slot) {
    console.error('usage: node indexer/build-snapshot.ts --mint <MINT> --slot <S> [--rpc URL] [--out DIR]');
    process.exit(1);
  }
  const conn = new Connection(arg('rpc') ?? process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'finalized');
  const out = arg('out') ?? `out/snapshot-${slot}`;
  const r = await buildSnapshot(conn, new PublicKey(mint), Number(slot), (m) => console.error(m));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/balances.csv`, 'owner,raw_balance,claims,counted,note\n' + r.holdings.map((h) => `${h.owner},${h.raw},${h.claims},${h.counted},${h.note}`).join('\n') + '\n');
  if (!r.snapshot) {
    console.error('nobody holds 1M or more: no snapshot');
    process.exit(1);
  }
  writeFileSync(`${out}/snapshot.csv`, r.snapshot.file());
  const summary = {
    mint: r.mint, slot: r.slot, decimals: r.decimals,
    wallets: r.snapshot.entries.length,
    claims: r.snapshot.entries.reduce((a, e) => a + e.claims, 0),
    sha256: Buffer.from(r.snapshot.fileHash()).toString('hex'),
    root: Buffer.from(r.snapshot.root).toString('hex'),
  };
  writeFileSync(`${out}/snapshot.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
