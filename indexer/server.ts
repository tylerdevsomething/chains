// The Chains service: the follower, the explorer API (/api), the renderer (/chain/<id>.json and
// .svg) and the site (site/). One process, no build step.
//
//   node indexer/server.ts
//
// Env: RPC_URL (default devnet; keep a private RPC server-side), CLUSTER (devnet | mainnet-beta, for
// explorer links), PORT (default 8080), DATA_DIR (optional: caches history between restarts),
// PUBLIC_ORIGIN (optional: the site's URL for asset metadata; else taken from the request),
// SNAPSHOT_FILE (the published snapshot.csv; default deploy/snapshot.<CLUSTER>.csv).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, pda, balanceOf, nonceOf, storageAt, wordToBig, keccak, type Header } from '../tools/chains.ts';
import { assemble, disassemble } from '../tools/asm.ts';
import { svg, metadata, traits, type ArtInput } from '../renderer/art.ts';
import { Follower, codeHashOf, type Block } from './follower.ts';
import { Claims } from './claims.ts';
import { Actions, ActionError } from './actions.ts';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 10_000) reject(new Error('too large'));
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const CLUSTER = process.env.CLUSTER ?? 'devnet';
const PORT = Number(process.env.PORT ?? 8080);
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const MAX_CHAINS = 500;

const conn = new Connection(RPC_URL, 'confirmed');
const follower = new Follower(conn, process.env.DATA_DIR ?? null);
const actions = new Actions(conn);
const snapshotFile = () => process.env.SNAPSHOT_FILE ?? fileURLToPath(new URL(`../deploy/snapshot.${CLUSTER}.csv`, import.meta.url));
const claims = new Claims(conn, snapshotFile());

// Known apps, by code hash.
const KNOWN = new Map<string, string>();
for (const [name, file] of [['Swap', 'swap.asm'], ['Collection', 'collection.asm']]) {
  KNOWN.set(codeHashOf(assemble(readFileSync(new URL(`../tools/apps/${file}`, import.meta.url), 'utf8'))), name);
}

const now = () => Math.floor(Date.now() / 1000);
const ended = (h: Header | null) => !!h && (h.status === 1 || (h.expiry > 0n && BigInt(now()) >= h.expiry));

function artInput(id: number): ArtInput & { name: string } {
  const row = follower.chains.get(id);
  const h = row?.header ?? null;
  return {
    id,
    name: h?.name ?? '',
    stage: !row ? 'unclaimed' : row.stage,
    height: h?.height ?? 0n,
    lamportsHeld: h?.totalDeposits ?? 0n,
    feesEarned: h?.feesAccrued ?? 0n,
    ended: ended(h),
  };
}

function headerJson(h: Header) {
  return {
    name: h.name,
    status: ended(h) ? (h.status === 1 ? 'swept' : 'ended') : 'running',
    height: Number(h.height),
    head: Buffer.from(h.head).toString('hex'),
    expiry: Number(h.expiry),
    launchedAt: Number(h.launchedAt),
    totalDeposits: h.totalDeposits.toString(),
    feesAccrued: h.feesAccrued.toString(),
    feesClaimed: h.feesClaimed.toString(),
  };
}

function chainSummary(id: number) {
  const row = follower.chains.get(id);
  const t = traits(artInput(id));
  return {
    id,
    stage: row?.stage ?? 'unclaimed',
    holder: row?.holder ?? null,
    stone: t.stone.name,
    cut: t.cut,
    ...(row?.header ? headerJson(row.header) : {}),
  };
}

const origin = (req: IncomingMessage) =>
  process.env.PUBLIC_ORIGIN ?? `${(req.headers['x-forwarded-proto'] as string) ?? 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache = 'no-cache') {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache, 'access-control-allow-origin': '*' });
  res.end(body);
}
const json = (res: ServerResponse, v: unknown, status = 200) => send(res, status, JSON.stringify(v), 'application/json');

async function api(path: string, url: URL, req: IncomingMessage, res: ServerResponse) {
  if (path === '/api/health') return json(res, { ok: true, updatedAt: follower.updatedAt });

  if (path === '/api/overview') {
    const r = follower.registry;
    const rows = [...follower.chains.values()];
    const sum = (f: (h: Header) => bigint) => rows.reduce((a, x) => a + (x.header ? f(x.header) : 0n), 0n).toString();
    return json(res, {
      cluster: CLUSTER,
      programId: PROGRAM_ID.toBase58(),
      maxChains: MAX_CHAINS,
      updatedAt: follower.updatedAt,
      registry: r && {
        treasury: r.treasury.toBase58(),
        chainsMint: r.chainsMint.toBase58(),
        collection: r.collection.toBase58(),
        snapshotSlot: Number(r.snapshotSlot),
        claimsOpenAt: Number(r.claimsOpenAt),
        claimed: r.claimed,
        feeLamportsPerMcu: r.feeLamportsPerMcu.toString(),
      },
      launched: rows.filter((x) => x.header).length,
      running: rows.filter((x) => x.header && !ended(x.header)).length,
      totalDeposits: sum((h) => h.totalDeposits),
      feesAccrued: sum((h) => h.feesAccrued),
      operations: sum((h) => h.height),
    });
  }

  if (path === '/api/chains') {
    return json(res, Array.from({ length: MAX_CHAINS }, (_, i) => chainSummary(i + 1)));
  }

  let m = /^\/api\/chain\/(\d+)$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    if (id < 1 || id > MAX_CHAINS) return json(res, { error: 'no such chain' }, 404);
    const row = follower.chains.get(id);
    const base = { ...chainSummary(id), asset: pda.asset(id).toBase58(), address: pda.chain(id).toBase58(), state: pda.state(id).toBase58() };
    if (!row?.header) return json(res, { ...base, apps: [], accounts: [], history: [], verified: true });
    const [apps, accounts] = await Promise.all([follower.apps(id), follower.accounts(id)]);
    const h = follower.history.get(id);
    return json(res, {
      ...base,
      apps: await Promise.all(apps.map(async (a) => {
        const name = KNOWN.get(a.codeHash) ?? null;
        return { ...a, name, state: await appState(id, a.address, name).catch(() => null) };
      })),
      accounts,
      history: (h?.blocks ?? []).slice(-500).reverse(),
      historyComplete: (h?.blocks.length ?? 0) === Number(row.header.height),
      verified: h?.verified ?? true,
    });
  }

  if (path === '/api/activity') return json(res, await activity());

  if (path === '/api/launch') return json(res, await launchInfo());

  m = /^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (m && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, { error: 'bad request body' }, 400);
    }
    try {
      return json(res, await actions.build(new PublicKey(m[1]), body));
    } catch (e) {
      if (e instanceof ActionError) return json(res, { error: e.message }, 400);
      throw e;
    }
  }

  m = /^\/api\/sig\/([1-9A-HJ-NP-Za-km-z]{80,90})$/.exec(path);
  if (m) {
    const st = (await conn.getSignatureStatuses([m[1]])).value[0];
    if (st?.confirmationStatus && st.confirmationStatus !== 'processed') setTimeout(() => follower.poke(), 0);
    return json(res, { status: st?.confirmationStatus ?? null, err: st?.err ?? null });
  }

  if (path === '/api/search') return json(res, search(url.searchParams.get('q') ?? ''));

  m = /^\/api\/chain\/(\d+)\/block\/(\d+)$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    const b = follower.history.get(id)?.blocks.find((x) => x.height === Number(m![2]));
    if (!b) return json(res, { error: 'no such block (yet)' }, 404);
    const apps = (await follower.allApps().catch(() => [])).filter((a) => a.chain === id);
    return json(res, { chain: id, block: b, apps: apps.map((a) => ({ ...a, name: KNOWN.get(a.codeHash) ?? null })) });
  }

  m = /^\/api\/account\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (m) return json(res, await account(m[1]));

  m = /^\/api\/chain\/(\d+)\/app\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    const c = await follower.code(id, m[2]);
    if (!c) return json(res, { error: 'no such app' }, 404);
    const hash = codeHashOf(c.code);
    const name = KNOWN.get(hash) ?? null;
    const calls = (follower.history.get(id)?.blocks ?? []).filter((b) => b.op === 'transact' && b.args.target === m![2]).slice(-100).reverse();
    return json(res, { chain: id, address: m[2], creator: c.creator, len: c.code.length, codeHash: hash, name, state: await appState(id, m[2], name).catch(() => null), calls, disassembly: disassemble(c.code) });
  }

  m = /^\/api\/claim\/([1-9A-HJ-NP-Za-km-z]{32,44})(\/tx)?$/.exec(path);
  if (m) {
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(m[1]);
    } catch {
      return json(res, { error: 'not a wallet address' }, 400);
    }
    if (!m[2]) return json(res, await claims.status(wallet));
    try {
      return json(res, await claims.tx(wallet, Number(url.searchParams.get('n') ?? 1)));
    } catch (e) {
      return json(res, { error: (e as Error).message }, 400);
    }
  }

  return json(res, { error: 'not found' }, 404);
}

type ChainBlock = Block & { chain: number };

/** Newest blocks across every chain. */
function recentBlocks(n: number, keep: (b: Block) => boolean = () => true): ChainBlock[] {
  const all: ChainBlock[] = [];
  for (const [id, h] of follower.history) {
    let k = 0;
    for (let i = h.blocks.length - 1; i >= 0 && k < n; i--) if (keep(h.blocks[i])) { all.push({ ...h.blocks[i], chain: id }); k++; }
  }
  return all.sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || b.height - a.height).slice(0, n);
}

async function namedApps() {
  const apps = await follower.allApps().catch(() => []);
  return apps.map((a) => ({ ...a, name: KNOWN.get(a.codeHash) ?? null }));
}

const word = (n: bigint | number) => {
  const b = Buffer.alloc(32);
  let v = BigInt(n);
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const wordText = (w: Uint8Array) => {
  const b = Buffer.from(w);
  const end = b.indexOf(0) < 0 ? 32 : b.indexOf(0);
  const t = b.subarray(0, end);
  return t.length && [...t].every((c) => c >= 32 && c < 127) && b.subarray(end).every((c) => c === 0) ? t.toString('latin1') : '';
};
const isZero = (w: Uint8Array) => w.every((x) => x === 0);

/** What a known app holds right now, read straight from its storage. */
async function appState(chain: number, address: string, name: string | null) {
  if (name !== 'Swap' && name !== 'Collection') return null;
  const s = await follower.state(chain);
  if (!s) return null;
  const guest = new PublicKey(address).toBytes();
  const at = (slot: Uint8Array) => storageAt(s, guest, slot);
  const calls = (follower.history.get(chain)?.blocks ?? []).filter((b) => b.op === 'transact' && b.args.target === address);

  if (name === 'Swap') {
    const seeder = at(word(0));
    const tokenReserve = wordToBig(at(word(1)));
    const solReserve = wordToBig(at(word(2)));
    const people = new Set<string>();
    let trades = 0;
    for (const b of calls) {
      people.add(b.signer);
      const d = b.args.data ?? '';
      if (d.length >= 128 && BigInt('0x' + d.slice(0, 64)) === 5n) people.add(new PublicKey(Buffer.from(d.slice(64, 128), 'hex')).toBase58());
      trades += b.logs.filter((l) => ['buy', 'sell'].includes(wordText(Buffer.from(l.topics[0] ?? '', 'hex')))).length;
    }
    let holders = 0;
    for (const p of people) if (wordToBig(at(keccak(word(1), new PublicKey(p).toBytes()))) > 0n) holders++;
    return {
      kind: 'pool',
      seeded: !isZero(seeder),
      seeder: isZero(seeder) ? null : new PublicKey(seeder).toBase58(),
      token: wordText(at(word(3))) || 'Token',
      ticker: wordText(at(word(4))) || '?',
      tokenReserve: tokenReserve.toString(),
      solReserve: solReserve.toString(),
      supply: '1000000',
      tokensPerSol: solReserve > 0n ? ((tokenReserve * 1_000_000_000n) / solReserve).toString() : '0',
      holders,
      trades,
    };
  }

  const creator = at(word(0));
  const cap = wordToBig(at(word(2)));
  const minted = Number(wordToBig(at(word(4))));
  const owners = new Map<string, number>();
  const items: { id: number; owner: string }[] = [];
  for (let id = 1; id <= Math.min(minted, 300); id++) {
    const o = at(keccak(word(2), word(id)));
    if (isZero(o)) continue;
    const k = new PublicKey(o).toBase58();
    owners.set(k, (owners.get(k) ?? 0) + 1);
    if (items.length < 24) items.push({ id, owner: k });
  }
  return {
    kind: 'collection',
    created: !isZero(creator),
    creator: isZero(creator) ? null : new PublicKey(creator).toBase58(),
    metaHash: Buffer.from(at(word(1))).toString('hex'),
    cap: cap.toString(),
    price: wordToBig(at(word(3))).toString(),
    minted,
    owners: owners.size,
    items,
  };
}

/** Launch progress for the snapshot page: the announcement (deploy/announcement.<cluster>.json),
 * the snapshot summary and the registry, with the current slot to turn slots into times. */
async function launchInfo() {
  const read = (name: string) => {
    try {
      return JSON.parse(readFileSync(fileURLToPath(new URL(`../deploy/${name}.${CLUSTER}.json`, import.meta.url)), 'utf8'));
    } catch {
      return null;
    }
  };
  const ann = read('announcement');
  const summary = read('snapshot');
  const r = follower.registry;
  const slot = await conn.getSlot('confirmed').catch(() => null);
  let file: { sha256: string; wallets: number; claims: number } | null = null;
  try {
    const text = readFileSync(snapshotFile(), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    file = { sha256: createHash('sha256').update(text).digest('hex'), wallets: lines.length, claims: lines.reduce((a, l) => a + Number(l.split(',')[1] ?? 0), 0) };
  } catch { /* not published */ }
  return {
    cluster: CLUSTER,
    slot,
    now: Math.floor(Date.now() / 1000),
    mint: r && !r.chainsMint.equals(PublicKey.default) ? r.chainsMint.toBase58() : ann?.mint ?? null,
    announcement: ann,
    summary,
    file,
    onChain: r && {
      snapshotSlot: Number(r.snapshotSlot),
      root: Buffer.from(r.snapshotRoot).toString('hex'),
      claimsOpenAt: Number(r.claimsOpenAt),
      claimed: r.claimed,
    },
    claims: claims.problem,
  };
}

/** Home-page explorer data: busiest chains, apps with usage, latest blocks and events. */
async function activity() {
  const apps = await namedApps();
  const usage = new Map<string, { calls: number; callers: Set<string>; volume: bigint; last: number }>();
  const lastTime = new Map<number, number>();
  for (const [id, h] of follower.history) {
    lastTime.set(id, h.blocks[h.blocks.length - 1]?.time ?? 0);
    for (const b of h.blocks) {
      if (b.op !== 'transact') continue;
      const k = `${id}:${b.args.target}`;
      const u = usage.get(k) ?? { calls: 0, callers: new Set(), volume: 0n, last: 0 };
      u.calls++;
      u.callers.add(b.signer);
      u.volume += BigInt(b.args.value ?? '0');
      u.last = Math.max(u.last, b.time ?? 0);
      usage.set(k, u);
    }
  }
  const appsOut = apps
    .map((a) => {
      const u = usage.get(`${a.chain}:${a.address}`);
      return { ...a, calls: u?.calls ?? 0, callers: u?.callers.size ?? 0, volume: (u?.volume ?? 0n).toString(), last: u?.last ?? 0 };
    })
    .sort((x, y) => y.calls - x.calls || y.last - x.last);

  const top = [...follower.chains.values()]
    .filter((r) => r.header)
    .sort((a, b) => Number(b.header!.height - a.header!.height))
    .slice(0, 8)
    .map((r) => ({ ...chainSummary(r.id), apps: apps.filter((a) => a.chain === r.id).length, last: lastTime.get(r.id) ?? 0 }));

  const blocks = recentBlocks(12);
  const events: { chain: number; height: number; sig: string; time: number | null; kind: string; who: string; to?: string; lamports?: string; text?: string }[] = [];
  for (const b of recentBlocks(30)) {
    const base = { chain: b.chain, height: b.height, sig: b.sig, time: b.time };
    const a = b.args;
    switch (b.op) {
      case 'transact':
        events.push({ ...base, kind: 'call', who: b.signer, to: a.target });
        if (a.value && a.value !== '0') events.push({ ...base, kind: 'transfer', who: b.signer, to: a.target, lamports: a.value });
        for (const l of b.logs) events.push({ ...base, kind: 'log', who: l.address, text: l.topics[0] ?? '' });
        break;
      case 'deposit': events.push({ ...base, kind: 'deposit', who: b.signer, to: a.beneficiary, lamports: a.lamports }); break;
      case 'withdraw': events.push({ ...base, kind: 'withdraw', who: b.signer, to: a.recipient, lamports: a.lamports }); break;
      case 'deploy_seal': events.push({ ...base, kind: 'deploy', who: b.signer, to: a.address }); break;
      default: events.push({ ...base, kind: b.op, who: b.signer });
    }
    if (events.length >= 16) break;
  }
  const withState = await Promise.all(appsOut.slice(0, 40).map(async (p) => ({ ...p, state: await appState(p.chain, p.address, p.name).catch(() => null) })));
  const tokens = withState.filter((p) => p.state && (p.state.kind === 'pool' ? p.state.seeded : p.state.created));
  let featured = null;
  if (top[0]) {
    const f = top[0];
    const accounts = await follower.accounts(f.id).catch(() => []);
    const row = follower.chains.get(f.id)!;
    featured = { ...f, accounts: accounts.length, asset: pda.asset(f.id).toBase58(), address: pda.chain(f.id).toBase58(), launchedAt: Number(row.header!.launchedAt) };
  }
  return { featured, tokens: tokens.map(({ state, ...p }) => ({ ...p, state })), top, apps: withState.slice(0, 6), appCount: apps.length, allApps: apps.map((a) => ({ chain: a.chain, address: a.address, name: a.name })), blocks, events: events.slice(0, 16) };
}

/** Where a search box query should go. */
function search(raw: string) {
  const q = raw.trim().replace(/^#/, '');
  if (/^\d+$/.test(q)) {
    const id = Number(q);
    return id >= 1 && id <= MAX_CHAINS ? { go: `#/chain/${id}` } : { error: `Chain ids run from 1 to ${MAX_CHAINS}.` };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(q)) {
    for (const [id, h] of follower.history) {
      const b = h.blocks.find((x) => x.sig === q);
      if (b) return { go: `#/chain/${id}/block/${b.height}` };
    }
    return { error: "That transaction isn't a Chains block (or the indexer hasn't seen it yet)." };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
    for (let id = 1; id <= MAX_CHAINS; id++) {
      const p = [pda.chain(id), pda.asset(id), pda.state(id)].map((k) => k.toBase58());
      if (p.includes(q)) return { go: `#/chain/${id}` };
      if (!follower.chains.has(id)) break;
    }
    for (const [id, h] of follower.history) {
      if (h.blocks.some((b) => b.op === 'deploy_seal' && b.args.address === q)) return { go: `#/chain/${id}/app/${q}` };
    }
    return { go: `#/account/${q}` };
  }
  return { error: 'Search by chain number, address or transaction signature.' };
}

/** One address across every chain: chains it holds, balances inside chains, recent blocks. */
async function account(address: string) {
  const holds = [...follower.chains.values()].filter((r) => r.holder === address).map((r) => chainSummary(r.id));
  const inChains: number[] = [];
  for (const [id, h] of follower.history) if (h.blocks.some((b) => b.signer === address || b.addresses.includes(address))) inChains.push(id);
  const key = new PublicKey(address);
  const balances = [];
  for (const id of inChains) {
    const s = await follower.state(id);
    if (s) balances.push({ chain: id, name: follower.chains.get(id)?.header?.name ?? '', balance: balanceOf(s, key).toString(), nonce: nonceOf(s, key).toString() });
  }
  const blocks = recentBlocks(50, (b) => b.signer === address || b.addresses.includes(address));
  const apps = await namedApps();
  return { address, holds, balances, blocks, apps, ...(await holdings(key, apps)) };
}

/** Tokens in Swap pools and items in Collections that an address holds, across every chain. */
async function holdings(key: PublicKey, apps: Awaited<ReturnType<typeof namedApps>>) {
  const me = Buffer.from(key.toBytes());
  const tokens: { chain: number; app: string; token: string; ticker: string; balance: string }[] = [];
  const items: { chain: number; app: string; ids: number[] }[] = [];
  for (const a of apps.slice(0, 80)) {
    if (a.name !== 'Swap' && a.name !== 'Collection') continue;
    const st = await follower.state(a.chain);
    if (!st) continue;
    const g = new PublicKey(a.address).toBytes();
    if (a.name === 'Swap') {
      const bal = wordToBig(storageAt(st, g, keccak(word(1), me)));
      if (bal > 0n) tokens.push({ chain: a.chain, app: a.address, token: wordText(storageAt(st, g, word(3))), ticker: wordText(storageAt(st, g, word(4))), balance: bal.toString() });
    } else {
      const minted = Number(wordToBig(storageAt(st, g, word(4))));
      const ids: number[] = [];
      for (let i = 1; i <= Math.min(minted, 500); i++) if (me.equals(Buffer.from(storageAt(st, g, keccak(word(2), word(i)))))) ids.push(i);
      if (ids.length) items.push({ chain: a.chain, app: a.address, ids });
    }
  }
  return { tokens, items };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

async function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = decodeURIComponent(url.pathname);
  try {
    if (path.startsWith('/api/')) return await api(path, url, req, res);

    const art = /^\/chain\/(\d+)\.(svg|json)$/.exec(path);
    if (art) {
      const id = Number(art[1]);
      if (id < 1 || id > MAX_CHAINS) return send(res, 404, 'not found', 'text/plain');
      const a = artInput(id);
      return art[2] === 'svg'
        ? send(res, 200, svg(a), 'image/svg+xml', 'public, max-age=30')
        : send(res, 200, JSON.stringify(metadata(a, origin(req)), null, 2), 'application/json', 'public, max-age=30');
    }

    // The collection asset's metadata (the program points it at <uri_base>collection.json).
    if (path === '/collection.json') {
      const o = origin(req);
      return send(res, 200, JSON.stringify({
        name: 'Chains',
        symbol: 'CHAIN',
        description: '500 chains inside one Solana program. Each chain is an NFT: its holder earns half of the fees the chain takes.',
        image: `${o}/chain/1.svg`,
        external_url: `${o}/`,
        properties: { files: [{ uri: `${o}/chain/1.svg`, type: 'image/svg+xml' }], category: 'image' },
      }, null, 2), 'application/json', 'public, max-age=300');
    }

    // The published snapshot file, for anyone to download and check against the root on chain.
    if (path === '/snapshot.csv') {
      const f = snapshotFile();
      const body = await readFile(f).catch(() => null);
      return body ? send(res, 200, body, 'text/csv; charset=utf-8', 'public, max-age=60') : send(res, 404, 'not published yet', 'text/plain');
    }

    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
    const file = join(SITE, rel);
    if (!file.startsWith(SITE)) return send(res, 403, 'forbidden', 'text/plain');
    const s = await stat(file).catch(() => null);
    if (s?.isFile()) return send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream', 'public, max-age=60');
    return send(res, 200, await readFile(join(SITE, 'index.html')), TYPES['.html']);
  } catch (e) {
    console.error(path, e);
    if (!res.headersSent) json(res, { error: 'internal error' }, 500);
  }
}

createServer(serve).listen(PORT, () => console.log(`chains: http://localhost:${PORT} (${CLUSTER}, program ${PROGRAM_ID.toBase58()})`));
follower.run();
