// The Chains site: overview, all chains, a chain explorer and app pages. Plain JS, no build step.
// Data comes from the service's /api (indexer/server.ts); art from /chain/<id>.svg.

import { claimPage } from './claim.js';
import { chainPanel, appPanel } from './panels.js';
import { snapshotPage } from './snapshot.js';

const ctx = () => ({ exTx, reload: async () => { const y = window.scrollY; await route(); window.scrollTo(0, y); } });

const app = document.getElementById('app');
let overview = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s, n = 4) => (s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s ?? '');
const sol = (lamports, dp = 4) => {
  const v = Number(BigInt(lamports ?? 0)) / 1e9;
  return v === 0 ? '0' : v < 10 ** -dp ? `<${10 ** -dp}` : v.toLocaleString(undefined, { maximumFractionDigits: dp });
};
const num = (n) => Number(n ?? 0).toLocaleString();
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const date = (t) => (t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const cluster = () => overview?.cluster ?? 'devnet';
const qs = () => (cluster() === 'mainnet-beta' ? '' : `?cluster=${cluster()}`);
const exTx = (sig) => `https://explorer.solana.com/tx/${sig}${qs()}`;
const exAddr = (a) => `https://explorer.solana.com/address/${a}${qs()}`;
const addrLink = (a, n = 4) => `<a class="mono" href="${exAddr(a)}" target="_blank" rel="noopener" title="${esc(a)}">${esc(short(a, n))}</a>`;

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ overview

async function home() {
  const o = overview;
  const claimed = o.registry?.claimed ?? 0;
  const ids = [1, 2, 3, 4, 5, 6];
  app.innerHTML = `
    <section class="hero">
      <div>
        <h1>Own a chain<br>on Solana.</h1>
        <p class="lead">Chains is 500 small chains inside one Solana program. Each chain is an NFT. Holders of $CHAINS claim them, anyone can use them, and the holder earns half of every fee the chain takes.</p>
        <div class="btns">
          <a class="btn primary" href="#/chains">See all chains</a>
          <a class="btn" href="#/own">How to own one</a>
        </div>
      </div>
      <div class="gems">
        ${ids.map((i) => `<a href="#/chain/${i}"><img src="/chain/${i}.svg" alt="Chain #${i}" width="400" height="400"></a>`).join('')}
      </div>
    </section>

    <form class="bigsearch" id="search">
      <input name="q" placeholder="Search a chain number, address or transaction" autocomplete="off" spellcheck="false">
      <button class="btn primary">Search</button>
      <div class="err bad" id="search-err"></div>
      <div class="live"><span class="pulse"></span><span id="live">live</span></div>
    </form>

    <div class="stats">
      <div class="stat"><div class="v">${num(claimed)}<span class="dim"> / ${o.maxChains}</span></div><div class="k">chains claimed</div></div>
      <div class="stat"><div class="v">${num(o.running)}</div><div class="k">chains running</div></div>
      <div class="stat"><div class="v">${num(o.operations)}</div><div class="k">blocks</div></div>
      <div class="stat"><div class="v">${sol(o.totalDeposits, 2)}</div><div class="k">SOL held in chains</div></div>
      <div class="stat"><div class="v">${sol(o.feesAccrued, 4)}</div><div class="k">SOL earned in fees</div></div>
    </div>

    <div id="explorer"><p class="muted pad">Loading activity…</p></div>

    <h2>How it works</h2>
    <div class="cards">
      <div class="card"><div class="n">01 · Claim</div><h3>Hold $CHAINS</h3><p>Every 1,000,000 $CHAINS held at the snapshot is one claim. One chain per wallet first, then first come, first served. Claiming doesn't burn your tokens.</p></div>
      <div class="card"><div class="n">02 · Launch</div><h3>Start your chain</h3><p>The holder launches the chain and picks an end date, or none. From then on anyone can deposit SOL and deploy apps to it.</p></div>
      <div class="card"><div class="n">03 · Use</div><h3>Every op is a transaction</h3><p>Apps run in a small VM inside the program. Every deposit, call and deploy is a Solana transaction, recorded in the chain's own hash-linked history.</p></div>
      <div class="card"><div class="n">04 · Earn</div><h3>Half the fees</h3><p>Each call pays a small fee in SOL. Half goes to whoever holds the chain's NFT, half to the treasury. Sell the NFT and the income goes with it.</p></div>
    </div>

    <h2>The rules</h2>
    <ul class="rules">
      <li>Owners own, they don't control: nobody can pause a chain, change its rules or touch balances.</li>
      <li>Fully backed: balances inside a chain always add up to the SOL the chain holds.</li>
      <li>No sequencer, no bridge, no validators. Solana orders and finalizes everything.</li>
      <li>Anyone can check: the snapshot, every claim and every block can be rebuilt from public data.</li>
      <li>The fee rate is fixed at deploy. It can never be raised.</li>
      <li>Chains can have an end date. Withdraw before it: after it, anything left inside goes to the chain's holder.</li>
    </ul>`;

  const form = document.getElementById('search');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return;
    const r = await get(`/api/search?q=${encodeURIComponent(q)}`).catch((err) => ({ error: err.message }));
    if (r.go) location.hash = r.go;
    else document.getElementById('search-err').textContent = r.error ?? '';
  });

  await renderActivity();
}

// ------------------------------------------------------------------ home explorer

const EV = { call: 'call', transfer: 'transfer', log: 'log', deposit: 'deposit', withdraw: 'withdraw', deploy: 'deploy', launch: 'launch', claim_fees: 'claim fees' };
const acct = (a, n = 4) => `<a class="mono" href="#/account/${esc(a)}" title="${esc(a)}">${esc(short(a, n))}</a>`;

function appLabel(apps, chainId, addr) {
  const a = apps.find((x) => x.chain === chainId && x.address === addr);
  return a ? `<a href="#/chain/${chainId}/app/${esc(addr)}"><b>${esc(a.name ?? 'app')}</b></a> <span class="dim mono">${esc(short(addr))}</span>` : acct(addr);
}

function eventText(e, apps) {
  switch (e.kind) {
    case 'call': return `${acct(e.who)} called ${appLabel(apps, e.chain, e.to)}`;
    case 'transfer': return `${acct(e.who)} sent ${sol(e.lamports)} SOL to ${appLabel(apps, e.chain, e.to)}`;
    case 'log': return `${appLabel(apps, e.chain, e.who)} logged <span class="mono">${esc(topicText(e.text || '00'))}</span>`;
    case 'deposit': return `${acct(e.who)} deposited ${sol(e.lamports)} SOL${e.to !== e.who ? ` for ${acct(e.to)}` : ''}`;
    case 'withdraw': return `${acct(e.who)} withdrew ${sol(e.lamports)} SOL${e.to !== e.who ? ` to ${acct(e.to)}` : ''}`;
    case 'deploy': return `${acct(e.who)} deployed ${appLabel(apps, e.chain, e.to)}`;
    case 'launch': return `${acct(e.who)} launched the chain`;
    case 'claim_fees': return `Fees paid out to the holder and treasury`;
    default: return esc(e.kind);
  }
}

function blockRows(blocks, apps, withChain = true) {
  return blocks.map((b) => `<tr class="link" data-href="#/chain/${b.chain}/block/${b.height}">
    ${withChain ? `<td><a href="#/chain/${b.chain}">#${b.chain}</a></td>` : ''}
    <td class="num mono"><a href="#/chain/${b.chain}/block/${b.height}">${b.height}</a></td>
    <td><span class="op ${esc(b.op)}">${esc(OPS[b.op] ?? b.op)}</span></td>
    <td>${describe(b, apps.filter((a) => a.chain === b.chain))}</td>
    <td class="muted nowrap" title="${esc(date(b.time))}">${esc(ago(b.time))}</td></tr>`).join('');
}

function wireRowLinks(root) {
  root.querySelectorAll('tr.link').forEach((tr) => tr.addEventListener('click', (e) => {
    if (!e.target.closest('a')) location.hash = tr.dataset.href;
  }));
}

const tokenAmt = (v) => {
  const n = Number(v ?? 0);
  return n >= 1e6 ? (n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'M' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

/** A stable colour per address, for the little dots next to addresses and items. */
function dot(addr) {
  let h = 0;
  for (const c of String(addr ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 60%)`;
}

/** One app as a card, with its live state when the app is a known kind. */
function appCard(p, { chainTag = true } = {}) {
  const st = p.state;
  const href = `#/chain/${p.chain}/app/${esc(p.address)}`;
  const head = `<div class="row"><a href="${href}"><h3>${esc(p.name ?? 'Unknown app')}</h3></a>${chainTag ? `<a class="dim" href="#/chain/${p.chain}">on #${p.chain}</a>` : ''}</div>`;
  let body;
  if (st?.kind === 'pool' && st.seeded) {
    const tok = Number(st.tokenReserve);
    const sup = Number(st.supply) || 1;
    const out = Math.max(0, Math.min(100, (1 - tok / sup) * 100));
    body = `
      <div class="mono dim">Pool: SOL against ${esc(st.token)} (${esc(st.ticker)})</div>
      <div class="big">1 SOL buys ${tokenAmt(st.tokensPerSol)} <span class="muted">${esc(st.ticker)}</span></div>
      <div class="bar" title="${out.toFixed(1)}% of the supply has left the pool"><span style="width:${out.toFixed(1)}%"></span></div>
      <div class="barlbl mono"><span>${sol(st.solReserve)} SOL in the pool</span><span>${tokenAmt(st.tokenReserve)} ${esc(st.ticker)}</span></div>
      <div class="facts small">
        <div><span class="k">Holders</span><span class="v">${num(st.holders)}</span></div>
        <div><span class="k">Trades</span><span class="v">${num(st.trades)}</span></div>
        <div><span class="k">Fee</span><span class="v">0.3% to ${acct(st.seeder)}</span></div>
      </div>`;
  } else if (st?.kind === 'collection' && st.created) {
    const cap = Number(st.cap);
    body = `
      <div class="mono dim">Collection: anyone can mint for ${sol(st.price)} SOL</div>
      <div class="big">${num(st.minted)} <span class="muted">of ${num(cap)} minted, ${num(st.owners)} owner${st.owners === 1 ? '' : 's'}</span></div>
      ${st.items.length ? `<div class="chips">${st.items.slice(0, 15).map((it) => `<span class="chip" title="#${it.id}, held by ${esc(it.owner)}"><i style="background:${dot(it.owner)}"></i>${it.id}</span>`).join('')}</div>
        ${st.minted > 15 ? `<div class="dim small">and ${num(st.minted - 15)} more</div>` : ''}` : ''}
      <div class="facts small">
        <div><span class="k">Price</span><span class="v">${sol(st.price)} SOL to ${acct(st.creator)}</span></div>
        <div><span class="k">Supply</span><span class="v">${num(cap)} at most, ${num(Math.max(0, cap - st.minted))} left</span></div>
        <div><span class="k">Metadata</span><span class="v mono" title="${esc(st.metaHash)}">${esc(short(st.metaHash, 6))}</span></div>
      </div>`;
  } else {
    body = `
      <div class="mono dim">${esc(short(p.address, 6))}</div>
      <div class="big">${num(p.calls ?? 0)} <span class="muted">call${p.calls === 1 ? '' : 's'}</span></div>
      <div class="facts small"><div><span class="k">Code</span><span class="v">${num(p.len)} bytes</span></div></div>`;
  }
  const foot = p.calls != null ? `<div class="dim small">${num(p.calls)} calls · ${num(p.callers)} callers · last used ${p.last ? esc(ago(p.last)) : 'never'}</div>` : '';
  const label = st?.kind === 'pool' ? 'Open the pool' : st?.kind === 'collection' ? 'Open the collection' : 'Open the app';
  return `<div class="card app">${head}${body}${foot}<a class="btn small" href="${href}">${label}</a></div>`;
}

function featuredCard(f) {
  if (!f) return '';
  const unpaid = BigInt(f.feesAccrued ?? 0) - BigInt(f.feesClaimed ?? 0);
  return `<section class="featured">
    <a class="art" href="#/chain/${f.id}"><img src="/chain/${f.id}.svg?t=${f.height}" alt="Chain #${f.id}" width="400" height="400"></a>
    <div class="body">
      <div class="eyebrow">Busiest chain</div>
      <h2>Chain #${f.id}${f.name ? ` · ${esc(f.name)}` : ''} <span class="pill ${esc(f.status)}">${esc(f.status)}</span></h2>
      <p class="muted">${esc(f.stone)}, ${esc(String(f.cut).toLowerCase())} cut. ${f.expiry ? `Ends ${esc(date(f.expiry))}.` : 'It has no end date.'}</p>
      <div class="fstats">
        <div><b>${num(f.height)}</b><span>blocks</span></div>
        <div><b>${sol(f.totalDeposits, 3)}</b><span>SOL held</span></div>
        <div><b>${num(f.accounts)}</b><span>accounts</span></div>
        <div><b>${num(f.apps)}</b><span>apps</span></div>
        <div><b>${sol(f.feesAccrued, 5)}</b><span>SOL in fees</span></div>
      </div>
      <div class="kv2">
        <div><span>Holder</span>${acct(f.holder, 6)}</div>
        <div><span>Chain account</span>${addrLink(f.address, 6)}</div>
        <div><span>NFT</span>${addrLink(f.asset, 6)}</div>
        <div><span>Fees not paid out</span>${sol(unpaid.toString(), 6)} SOL</div>
      </div>
      <a class="btn primary small" href="#/chain/${f.id}">Explore chain #${f.id}</a>
    </div>
  </section>`;
}

function tokensTable(tokens) {
  if (!tokens.length) return '<div class="empty">No tokens or collections yet.</div>';
  return `<table>
    <tr><th>Name</th><th>Kind</th><th>Chain</th><th>App</th><th class="num">Holders</th><th class="num">Supply</th></tr>
    ${tokens.map((t) => {
      const st = t.state;
      const pool = st.kind === 'pool';
      return `<tr class="link" data-href="#/chain/${t.chain}/app/${esc(t.address)}">
        <td><i class="dot" style="background:${dot(t.address)}"></i>${pool ? `${esc(st.token)} <span class="dim">${esc(st.ticker)}</span>` : `Collection <span class="dim mono">${esc(short(t.address))}</span>`}</td>
        <td>${pool ? 'Token' : 'Collection'}</td>
        <td><a href="#/chain/${t.chain}">#${t.chain}</a></td>
        <td>${esc(t.name)} <span class="dim mono">${esc(short(t.address))}</span></td>
        <td class="num">${num(pool ? st.holders : st.owners)}</td>
        <td class="num">${pool ? tokenAmt(st.supply) : `${num(st.minted)} / ${num(st.cap)}`}</td></tr>`;
    }).join('')}
  </table>`;
}

function feedBlocks(blocks, apps) {
  if (!blocks.length) return '<div class="empty">No blocks yet.</div>';
  return `<table class="feed">${blocks.map((b) => `<tr class="link" data-href="#/chain/${b.chain}/block/${b.height}">
    <td class="nowrap"><span class="op ${esc(b.op)}">${esc(OPS[b.op] ?? b.op)}</span></td>
    <td><div class="small"><a href="#/chain/${b.chain}">#${b.chain}</a> · block <a class="mono" href="#/chain/${b.chain}/block/${b.height}">${b.height}</a></div>
      <div>${describe(b, apps.filter((x) => x.chain === b.chain))}</div></td>
    <td class="muted nowrap num">${esc(ago(b.time))}</td></tr>`).join('')}</table>`;
}

function feedEvents(events, apps) {
  if (!events.length) return '<div class="empty">No events yet.</div>';
  return `<table class="feed">${events.map((e) => `<tr class="link" data-href="#/chain/${e.chain}/block/${e.height}">
    <td class="nowrap"><span class="ev ${esc(e.kind)}">${esc(EV[e.kind] ?? e.kind)}</span></td>
    <td><div class="small"><a href="#/chain/${e.chain}">#${e.chain}</a> · block ${e.height}</div><div>${eventText(e, apps)}</div></td>
    <td class="muted nowrap num">${esc(ago(e.time))}</td></tr>`).join('')}</table>`;
}

let liveTimer = null;

async function renderActivity() {
  const el = document.getElementById('explorer');
  if (!el) return;
  let a;
  try {
    a = await get('/api/activity');
  } catch (e) {
    el.innerHTML = `<p class="muted">Activity unavailable: ${esc(e.message)}</p>`;
    return;
  }
  if (!document.body.contains(el)) return;
  const live = document.getElementById('live');
  if (live) live.textContent = `live · updated ${new Date().toLocaleTimeString()}`;

  el.innerHTML = `
    ${featuredCard(a.featured)}

    <h2>Apps <span class="dim">${num(a.appCount)} deployed</span></h2>
    <p class="muted sub">Programs that live inside the chains. Solana itself only sees the Chains program.</p>
    ${a.apps.length ? `<div class="cards apps">${a.apps.map((p) => appCard(p)).join('')}</div>` : '<div class="panel"><div class="empty">No apps deployed yet.</div></div>'}

    <h2>Tokens and collections</h2>
    <div class="panel">${tokensTable(a.tokens)}</div>

    <h2>Most active chains</h2>
    <div class="panel">${a.top.length ? `<table>
      <tr><th>Chain</th><th>Holder</th><th class="num">Blocks</th><th class="num">Apps</th><th class="num">SOL held</th><th class="num">Fees earned</th><th>Last block</th></tr>
      ${a.top.map((c) => `<tr class="link" data-href="#/chain/${c.id}">
        <td><a class="chainref" href="#/chain/${c.id}"><img src="/chain/${c.id}.svg" alt="" width="28" height="28">#${c.id}${c.name ? ` · ${esc(c.name)}` : ''}</a> <span class="pill ${esc(c.status)}">${esc(c.status)}</span></td>
        <td>${acct(c.holder)}</td><td class="num">${num(c.height)}</td><td class="num">${num(c.apps)}</td>
        <td class="num">${sol(c.totalDeposits)}</td><td class="num">${sol(c.feesAccrued, 6)}</td>
        <td class="muted nowrap">${esc(ago(c.last))}</td></tr>`).join('')}
    </table>` : '<div class="empty">No chain has launched yet.</div>'}</div>

    <div class="two">
      <div>
        <h2>Latest blocks</h2>
        <p class="muted sub">Each operation commits one block, linked by hash to the one before.</p>
        <div class="panel">${feedBlocks(a.blocks, a.allApps)}</div>
      </div>
      <div>
        <h2>Latest events</h2>
        <p class="muted sub">Calls, transfers, deposits and app logs inside the chains.</p>
        <div class="panel">${feedEvents(a.events, a.allApps)}</div>
      </div>
    </div>`;
  wireRowLinks(el);

  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    if (document.getElementById('explorer')) renderActivity();
  }, 15000);
}

// ------------------------------------------------------------------ account

async function accountPage(address) {
  const a = await get(`/api/account/${address}`);
  app.innerHTML = `
    <div style="padding-top:28px">
      <div class="crumbs"><a href="#/">Overview</a> / account</div>
      <h1 style="font-size:30px;word-break:break-all" class="mono">${esc(a.address)}</h1>
      <p><a href="${exAddr(a.address)}" target="_blank" rel="noopener">View on Solana Explorer</a></p>

      <h2>Chains held <span class="dim">${a.holds.length}</span></h2>
      ${a.holds.length ? `<div class="grid">${a.holds.map(tile).join('')}</div>` : '<div class="panel"><div class="empty">This address holds no chain NFTs.</div></div>'}

      ${a.tokens.length || a.items.length ? `<h2>Tokens and items</h2>
      <div class="panel"><table>
        <tr><th>Chain</th><th>App</th><th>Holding</th></tr>
        ${a.tokens.map((t) => `<tr class="link" data-href="#/chain/${t.chain}/app/${esc(t.app)}"><td><a href="#/chain/${t.chain}">#${t.chain}</a></td><td>${esc(t.token || 'Token')} <span class="dim mono">${esc(short(t.app))}</span></td><td class="num">${Number(t.balance).toLocaleString()} ${esc(t.ticker)}</td></tr>`).join('')}
        ${a.items.map((t) => `<tr class="link" data-href="#/chain/${t.chain}/app/${esc(t.app)}"><td><a href="#/chain/${t.chain}">#${t.chain}</a></td><td>Collection <span class="dim mono">${esc(short(t.app))}</span></td><td class="num">${t.ids.length} item${t.ids.length === 1 ? '' : 's'}: ${t.ids.slice(0, 20).map((i) => '#' + i).join(', ')}</td></tr>`).join('')}
      </table></div>` : ''}

      <h2>Balances inside chains</h2>
      <div class="panel">${a.balances.length ? `<table>
        <tr><th>Chain</th><th class="num">Balance (SOL)</th><th class="num">Nonce</th></tr>
        ${a.balances.map((b) => `<tr><td><a href="#/chain/${b.chain}">#${b.chain}${b.name ? ` · ${esc(b.name)}` : ''}</a></td><td class="num">${sol(b.balance, 6)}</td><td class="num">${num(b.nonce)}</td></tr>`).join('')}
      </table>` : '<div class="empty">No activity inside any chain.</div>'}</div>

      <h2>Blocks <span class="dim">latest ${a.blocks.length}</span></h2>
      <div class="panel">${a.blocks.length ? `<table>
        <tr><th>Chain</th><th class="num">Block</th><th>Op</th><th>What</th><th>When</th></tr>
        ${blockRows(a.blocks, a.apps)}
      </table>` : '<div class="empty">No blocks involve this address.</div>'}</div>
    </div>`;
  wireRowLinks(app);
}

// ------------------------------------------------------------------ one block

async function blockPage(id, height) {
  const r = await get(`/api/chain/${id}/block/${height}`);
  const b = r.block;
  app.innerHTML = `
    <div style="padding-top:28px">
      <div class="crumbs"><a href="#/chains">All chains</a> / <a href="#/chain/${id}">#${id}</a> / block ${b.height}</div>
      <h1 style="font-size:34px">Block ${b.height} <span class="op ${esc(b.op)}">${esc(OPS[b.op] ?? b.op)}</span></h1>
      <p>${describe(b, r.apps)}</p>
      <div class="btns" style="margin:12px 0 20px">
        ${b.height > 1 ? `<a class="btn small" href="#/chain/${id}/block/${b.height - 1}">← Block ${b.height - 1}</a>` : ''}
        <a class="btn small" href="#/chain/${id}/block/${b.height + 1}">Block ${b.height + 1} →</a>
      </div>
      <div class="panel" style="padding:8px 18px">${blockDetail(b)}</div>
    </div>`;
}

// ------------------------------------------------------------------ all chains

let gridFilter = 'all';
let gridSearch = '';

async function chains() {
  const list = await get('/api/chains');
  const counts = { all: list.length, launched: 0, claimed: 0, unclaimed: 0 };
  for (const c of list) counts[c.stage]++;
  const render = () => {
    const q = gridSearch.trim().toLowerCase();
    const shown = list.filter((c) => (gridFilter === 'all' || c.stage === gridFilter) &&
      (!q || String(c.id) === q.replace('#', '') || (c.name ?? '').toLowerCase().includes(q) || (c.holder ?? '').toLowerCase().startsWith(q) || c.stone.toLowerCase().includes(q)));
    document.getElementById('grid').innerHTML = shown.length ? shown.map(tile).join('') : `<p class="muted">No chains match.</p>`;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.f === gridFilter));
  };
  app.innerHTML = `
    <div class="toolbar">
      <div class="tabs">
        ${['all', 'launched', 'claimed', 'unclaimed'].map((f) => `<button data-f="${f}">${f[0].toUpperCase() + f.slice(1)} <span class="dim">${counts[f]}</span></button>`).join('')}
      </div>
      <input class="search" placeholder="Search id, name, stone, holder" value="${esc(gridSearch)}">
    </div>
    <div class="grid" id="grid"></div>`;
  app.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { gridFilter = b.dataset.f; render(); }));
  app.querySelector('input.search').addEventListener('input', (e) => { gridSearch = e.target.value; render(); });
  render();
}

function tile(c) {
  const sub = c.stage === 'launched'
    ? `${num(c.height)} ops · ${sol(c.totalDeposits, 2)} SOL`
    : c.stage === 'claimed' ? 'Not launched' : 'Unclaimed';
  return `<a class="tile ${c.stage}" href="#/chain/${c.id}">
    <img loading="lazy" src="/chain/${c.id}.svg" alt="" width="400" height="400">
    <div class="meta"><div class="t">#${c.id}${c.name ? ` · ${esc(c.name)}` : ''}</div><div class="s">${esc(c.stone)} · ${sub}</div></div>
  </a>`;
}

// ------------------------------------------------------------------ one chain

const OPS = { launch: 'launch', deposit: 'deposit', withdraw: 'withdraw', transact: 'transaction', deploy_seal: 'deploy', claim_fees: 'claim fees' };

const SELECTORS = {
  Swap: { 1: 'seed', 2: 'buy', 3: 'sell', 4: 'balance_of', 5: 'transfer', 6: 'token_reserve', 7: 'sol_reserve' },
  Collection: { 1: 'create', 2: 'mint', 3: 'transfer', 4: 'owner_of', 5: 'minted' },
};

function describe(b, apps) {
  const a = b.args;
  const appName = (addr) => {
    const app = apps.find((x) => x.address === addr);
    return app ? (app.name ?? 'app') : null;
  };
  switch (b.op) {
    case 'launch': return `Launched by ${acct(b.signer)}${a.expiry !== '0' ? `, ends ${date(Number(a.expiry))}` : ', no end date'}`;
    case 'deposit': return `${sol(a.lamports)} SOL from ${acct(b.signer)} to ${acct(a.beneficiary)}`;
    case 'withdraw': return `${sol(a.lamports)} SOL from ${acct(b.signer)} to ${acct(a.recipient)}`;
    case 'deploy_seal': return `Deployed app ${acct(a.address)} by ${acct(b.signer)}`;
    case 'claim_fees': return `Fees paid out to the holder and treasury`;
    case 'transact': {
      const name = appName(a.target);
      const sel = a.data && a.data.length >= 64 ? Number(BigInt('0x' + a.data.slice(0, 64))) : null;
      const what = name ? (SELECTORS[name]?.[sel] ?? (sel != null ? `call ${sel}` : '')) : (a.data ? 'call' : 'transfer');
      return `${acct(b.signer)} → ${name ? `<b>${esc(name)}</b> ` : ''}${acct(a.target)}${a.value !== '0' ? ` with ${sol(a.value)} SOL` : ''} <span class="dim">${esc(what)}</span>`;
    }
    default: return esc(b.op);
  }
}

function blockDetail(b) {
  const rows = [
    ['Block', `${b.height}`],
    ['Transaction', `<a href="${exTx(b.sig)}" target="_blank" rel="noopener">${esc(b.sig)}</a>`],
    ['Time', esc(date(b.time))],
    ['Head', esc(b.head)],
    ['Op hash', esc(b.opHash)],
    ...Object.entries(b.args).map(([k, v]) => [k, esc(v)]),
    ...(b.result != null ? [['Result', esc(b.result)]] : []),
    ...b.logs.map((l, i) => [`Log ${i + 1}`, `${esc(short(l.address, 6))}: ${l.topics.map((t) => esc(topicText(t))).join(', ')}${l.data ? ` · ${esc(l.data)}` : ''}`]),
  ];
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('')}</div>`;
}

function topicText(hex) {
  const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
  const end = bytes.findIndex((x) => x === 0);
  const txt = bytes.slice(0, end < 0 ? 32 : end);
  return txt.length && txt.every((x) => x >= 32 && x < 127) && bytes.slice(txt.length).every((x) => x === 0) ? `"${String.fromCharCode(...txt)}"` : short(hex, 6);
}

async function chain(id) {
  const c = await get(`/api/chain/${id}`);
  const status = c.stage === 'launched' ? c.status : c.stage;
  const title = `Chain #${c.id}${c.name ? ` · ${esc(c.name)}` : ''}`;
  const facts = c.stage === 'launched' ? [
    ['Holder', acct(c.holder, 6)],
    ['Status', esc(status)],
    ['Operations', num(c.height)],
    ['SOL held', `${sol(c.totalDeposits)} SOL`],
    ['Fees earned', `${sol(c.feesAccrued)} SOL`],
    ['Fees paid out', `${sol(c.feesClaimed)} SOL`],
    ['Launched', esc(date(c.launchedAt))],
    ['Ends', c.expiry ? esc(date(c.expiry)) : 'Never'],
    ['Stone', `${esc(c.stone)}, ${esc(c.cut).toLowerCase()}`],
    ['NFT', addrLink(c.asset, 6)],
    ['Head', `<span class="mono" title="${esc(c.head)}">${esc(short(c.head, 8))}</span>`],
    ['History', c.verified ? '<span class="ok">hash chain checks out</span>' : '<span class="bad">hash chain mismatch</span>'],
  ] : c.stage === 'claimed' ? [
    ['Holder', addrLink(c.holder, 6)], ['Status', 'Claimed, not launched yet'], ['Stone', `${esc(c.stone)}, ${esc(c.cut).toLowerCase()}`], ['NFT', addrLink(c.asset, 6)],
  ] : [['Status', 'Unclaimed'], ['Stone', `${esc(c.stone)}, ${esc(c.cut).toLowerCase()}`]];

  app.innerHTML = `
    <section class="chain-top">
      <div class="art"><img src="/chain/${c.id}.svg?t=${c.height ?? 0}" alt="${title}" width="400" height="400"></div>
      <div>
        <div class="crumbs"><a href="#/chains">All chains</a> / #${c.id}</div>
        <h1 style="font-size:40px">${title} <span class="pill ${esc(status)}">${esc(status)}</span></h1>
        <div class="facts">${facts.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>
      </div>
    </section>
    <h2>${c.stage === 'launched' ? 'Use this chain' : c.stage === 'claimed' ? 'Not launched yet' : 'Unclaimed'}</h2>
    <div id="use"></div>
    ${c.stage === 'launched' ? `
    <h2>Apps <span class="dim">${c.apps.length}</span></h2>
    ${c.apps.some((a) => a.state) ? `<div class="cards apps" style="margin-bottom:12px">${c.apps.filter((a) => a.state).map((a) => appCard({ ...a, chain: c.id }, { chainTag: false })).join('')}</div>` : ''}
    <div class="panel">${c.apps.length ? `<table>
      <tr><th>App</th><th>Address</th><th>Creator</th><th class="num">Code</th></tr>
      ${c.apps.map((a) => `<tr><td><a href="#/chain/${c.id}/app/${a.address}">${esc(a.name ?? 'Unknown app')}</a></td><td>${addrLink(a.address, 6)}</td><td>${addrLink(a.creator)}</td><td class="num">${num(a.len)} bytes</td></tr>`).join('')}
    </table>` : '<div class="empty">No apps deployed yet.</div>'}</div>

    <h2>Accounts <span class="dim">${c.accounts.length}</span></h2>
    <div class="panel">${c.accounts.length ? `<table>
      <tr><th>Address</th><th></th><th class="num">Balance (SOL)</th><th class="num">Nonce</th></tr>
      ${c.accounts.map((a) => {
        const app = c.apps.find((x) => x.address === a.address);
        const label = a.chain ? 'the chain (unclaimed fees)' : app ? (app.name ?? 'app') : '';
        return `<tr><td>${acct(a.address, 6)}</td><td class="muted">${esc(label)}</td><td class="num">${sol(a.balance, 6)}</td><td class="num">${num(a.nonce)}</td></tr>`;
      }).join('')}
    </table>` : '<div class="empty">No balances yet.</div>'}</div>

    <h2>History <span class="dim">${num(c.height)} blocks</span></h2>
    ${c.historyComplete ? '' : '<p class="muted">Catching up with the chain… refresh in a moment.</p>'}
    <div class="panel">${c.history.length ? `<table id="hist">
      <tr><th class="num">Block</th><th>Op</th><th>What</th><th>When</th></tr>
      ${c.history.map((b, i) => `<tr class="blk" data-i="${i}"><td class="num mono">${b.height}</td><td><span class="op ${esc(b.op)}">${esc(OPS[b.op] ?? b.op)}</span></td><td>${describe(b, c.apps)}</td><td class="muted" title="${esc(date(b.time))}">${esc(ago(b.time))}</td></tr>`).join('')}
    </table>` : '<div class="empty">No blocks yet.</div>'}</div>` : ''}`;
  chainPanel(document.getElementById('use'), c, ctx());

  app.querySelectorAll('tr.blk').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const next = tr.nextElementSibling;
    if (next?.classList.contains('detail')) return next.remove();
    const d = document.createElement('tr');
    d.className = 'detail';
    d.innerHTML = `<td></td><td colspan="3">${blockDetail(c.history[Number(tr.dataset.i)])}</td>`;
    tr.after(d);
  }));
}

async function appPage(id, address) {
  const a = await get(`/api/chain/${id}/app/${address}`);
  app.innerHTML = `
    <div style="padding-top:28px">
      <div class="crumbs"><a href="#/chains">All chains</a> / <a href="#/chain/${id}">#${id}</a> / app</div>
      <h1 style="font-size:36px">${esc(a.name ?? 'Unknown app')}</h1>
      <div class="facts">
        <div><span class="k">Address</span><span class="v">${addrLink(a.address, 8)}</span></div>
        <div><span class="k">Creator</span><span class="v">${addrLink(a.creator, 6)}</span></div>
        <div><span class="k">Code</span><span class="v">${num(a.len)} bytes</span></div>
        <div><span class="k">Code hash</span><span class="v mono" title="${esc(a.codeHash)}">${esc(short(a.codeHash, 8))}</span></div>
      </div>
      <h2>Use this app</h2>
      <div id="use-app"></div>
      ${a.state ? `<h2>Right now</h2><div class="cards apps">${appCard({ ...a, chain: id, calls: null }, { chainTag: false })}</div>` : ''}
      <h2>Calls <span class="dim">latest ${a.calls.length}</span></h2>
      <div class="panel">${a.calls.length ? `<table>
        <tr><th class="num">Block</th><th>What</th><th>When</th></tr>
        ${a.calls.map((b) => `<tr class="link" data-href="#/chain/${id}/block/${b.height}"><td class="num mono"><a href="#/chain/${id}/block/${b.height}">${b.height}</a></td><td>${describe(b, [{ address: a.address, name: a.name }])}${b.logs.length ? ` <span class="dim">· ${b.logs.map((l) => esc(topicText(l.topics[0] ?? '00'))).join(', ')}</span>` : ''}</td><td class="muted nowrap">${esc(ago(b.time))}</td></tr>`).join('')}
      </table>` : '<div class="empty">Nobody has called this app yet.</div>'}</div>
      <h2>Code</h2>
      <p class="muted">MiniVM code, disassembled. It was checked when it was deployed and can never change.</p>
      <pre class="code">${esc(a.disassembly)}</pre>
    </div>`;
  wireRowLinks(app);
  appPanel(document.getElementById("use-app"), { ...a, chain: id }, ctx());
}

// ------------------------------------------------------------------ own a chain

async function own() {
  app.innerHTML = `
    <div style="max-width:760px;padding-top:28px">
      <h1 style="font-size:40px">Own a chain</h1>
      <p class="lead muted" style="font-size:17px">There are 500 chains. They go to $CHAINS holders, and after that they trade as NFTs.</p>
      <h2>1. Hold $CHAINS at the snapshot</h2>
      <p>Each 1,000,000 $CHAINS in your wallet at the snapshot is one claim. Nobody knows the exact snapshot slot in advance, us included: we announce a window, and the slot inside it is picked from a later Solana blockhash that anyone can check. The list, its hash and its Merkle root are published, so anyone can rebuild it from the token's public history.</p>
      <h2>2. Claim</h2>
      <p>For the first 24 hours after claiming opens, each wallet can claim one chain. After that, wallets with claims left use them, first come, first served, until all 500 are gone. Claiming doesn't burn or lock your tokens. Each claim mints a chain NFT to your wallet.</p>
      <p><a class="btn primary" href="#/claim">Go to the claim page</a> <a class="btn" href="#/snapshot">See the snapshot</a></p>
      <h2>3. Launch, or sell</h2>
      <p>Launch your chain to start earning: you pick the end date (at least 30 days away, or never). Or sell the NFT on any marketplace that lists Metaplex Core assets. Whoever holds it gets the holder's half of the fees.</p>
      <h2>What the holder can and can't do</h2>
      <ul class="rules">
        <li>Can name the chain and collect half its fees.</li>
        <li>Can sell or transfer the chain NFT.</li>
        <li>Can't pause the chain or change its fee rate.</li>
        <li>Can't move the end date or touch anyone's balance.</li>
      </ul>
    </div>`;
}

// ------------------------------------------------------------------ router

async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on',
    (a.dataset.nav === 'home' && parts.length === 0) || (a.dataset.nav === 'chains' && (parts[0] === 'chains' || parts[0] === 'chain')) || (a.dataset.nav === 'own' && (parts[0] === 'own' || parts[0] === 'claim')) || (a.dataset.nav === 'snapshot' && parts[0] === 'snapshot')));
  try {
    if (!overview) await loadOverview();
    if (parts.length === 0) await home();
    else if (parts[0] === 'chains') await chains();
    else if (parts[0] === 'own') await own();
    else if (parts[0] === 'claim') await claimPage(app, overview, exTx);
    else if (parts[0] === 'snapshot') await snapshotPage(app, exAddr);
    else if (parts[0] === 'account') await accountPage(parts[1]);
    else if (parts[0] === 'chain' && parts[2] === 'block') await blockPage(Number(parts[1]), Number(parts[3]));
    else if (parts[0] === 'chain' && parts[2] === 'app') await appPage(Number(parts[1]), parts[3]);
    else if (parts[0] === 'chain') await chain(Number(parts[1]));
    else await home();
    window.scrollTo(0, 0);
  } catch (e) {
    app.innerHTML = `<p class="pad bad">Couldn't load this page: ${esc(e.message)}</p>`;
  }
}

async function loadOverview() {
  overview = await get('/api/overview');
  document.getElementById('foot-program').innerHTML = `program ${addrLink(overview.programId, 6)}`;
  if (overview.cluster !== 'mainnet-beta') {
    const b = document.getElementById('banner');
    b.textContent = `Preview on Solana ${overview.cluster}. Test chains, test SOL.`;
    b.hidden = false;
  }
}

window.addEventListener('hashchange', route);
route();
setInterval(async () => { overview = await get('/api/overview').catch(() => overview); }, 30000);
