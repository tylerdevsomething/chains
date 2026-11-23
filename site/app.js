// The Chains site: overview, all chains, a chain explorer and app pages. Plain JS, no build step.
// Data comes from the service's /api (indexer/server.ts); art from /chain/<id>.svg.

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

    <div class="stats">
      <div class="stat"><div class="v">${num(claimed)}<span class="dim"> / ${o.maxChains}</span></div><div class="k">chains claimed</div></div>
      <div class="stat"><div class="v">${num(o.running)}</div><div class="k">chains running</div></div>
      <div class="stat"><div class="v">${num(o.operations)}</div><div class="k">operations</div></div>
      <div class="stat"><div class="v">${sol(o.totalDeposits, 2)}</div><div class="k">SOL held in chains</div></div>
      <div class="stat"><div class="v">${sol(o.feesAccrued, 4)}</div><div class="k">SOL earned in fees</div></div>
    </div>

    <h2>How it works</h2>
    <div class="cards">
      <div class="card"><div class="n">01 · Claim</div><h3>Hold $CHAINS</h3><p>Every 1,000,000 $CHAINS held at the snapshot is one claim. Claims are first come, first served, and claiming doesn't burn your tokens.</p></div>
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
      <li>When a chain's end date passes, everyone can still withdraw. Leftovers go to the holder.</li>
    </ul>`;
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

function describe(b, apps) {
  const a = b.args;
  const appName = (addr) => {
    const app = apps.find((x) => x.address === addr);
    return app ? (app.name ?? 'app') : null;
  };
  switch (b.op) {
    case 'launch': return `Launched by ${addrLink(b.signer)}${a.expiry !== '0' ? `, ends ${date(Number(a.expiry))}` : ', no end date'}`;
    case 'deposit': return `${sol(a.lamports)} SOL from ${addrLink(b.signer)} to ${addrLink(a.beneficiary)}`;
    case 'withdraw': return `${sol(a.lamports)} SOL from ${addrLink(b.signer)} to ${addrLink(a.recipient)}`;
    case 'deploy_seal': return `Deployed app ${addrLink(a.address)} by ${addrLink(b.signer)}`;
    case 'claim_fees': return `Fees paid out to the holder and treasury`;
    case 'transact': {
      const name = appName(a.target);
      const sel = a.data && a.data.length >= 64 ? Number(BigInt('0x' + a.data.slice(0, 64))) : null;
      const what = name ? `${name}${sel != null ? ` · call ${sel}` : ''}` : (a.data ? 'call' : 'transfer');
      return `${addrLink(b.signer)} → ${name ? `<b>${esc(name)}</b> ` : ''}${addrLink(a.target)}${a.value !== '0' ? ` with ${sol(a.value)} SOL` : ''} <span class="dim">${esc(what)}</span>`;
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
    ['Holder', addrLink(c.holder, 6)],
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
    ${c.stage === 'launched' ? `
    <h2>Apps <span class="dim">${c.apps.length}</span></h2>
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
        return `<tr><td>${addrLink(a.address, 6)}</td><td class="muted">${esc(label)}</td><td class="num">${sol(a.balance, 6)}</td><td class="num">${num(a.nonce)}</td></tr>`;
      }).join('')}
    </table>` : '<div class="empty">No balances yet.</div>'}</div>

    <h2>History <span class="dim">${num(c.height)} blocks</span></h2>
    ${c.historyComplete ? '' : '<p class="muted">Catching up with the chain… refresh in a moment.</p>'}
    <div class="panel">${c.history.length ? `<table id="hist">
      <tr><th class="num">Block</th><th>Op</th><th>What</th><th>When</th></tr>
      ${c.history.map((b, i) => `<tr class="blk" data-i="${i}"><td class="num mono">${b.height}</td><td><span class="op ${esc(b.op)}">${esc(OPS[b.op] ?? b.op)}</span></td><td>${describe(b, c.apps)}</td><td class="muted" title="${esc(date(b.time))}">${esc(ago(b.time))}</td></tr>`).join('')}
    </table>` : '<div class="empty">No blocks yet.</div>'}</div>` : `
    <h2>Not running yet</h2>
    <p class="note">${c.stage === 'claimed' ? 'This chain has been claimed. It starts keeping history when its holder launches it.' : 'Nobody has claimed this chain yet. Claims open to $CHAINS holders after the snapshot.'}</p>`}`;

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
      <h2>Code</h2>
      <p class="muted">MiniVM code, disassembled. It was checked when it was deployed and can never change.</p>
      <pre class="code">${esc(a.disassembly)}</pre>
    </div>`;
}

// ------------------------------------------------------------------ own a chain

async function own() {
  const o = overview;
  app.innerHTML = `
    <div style="max-width:760px;padding-top:28px">
      <h1 style="font-size:40px">Own a chain</h1>
      <p class="lead muted" style="font-size:17px">There are 500 chains. They go to $CHAINS holders, and after that they trade as NFTs.</p>
      <h2>1. Hold $CHAINS at the snapshot</h2>
      <p>Each 1,000,000 $CHAINS in your wallet at the snapshot is one claim. The snapshot list, its hash and its Merkle root are published, so anyone can check it against the token's public history.</p>
      <h2>2. Claim</h2>
      <p>Claims are first come, first served, in order of chain number. Claiming doesn't burn or lock your tokens. Each claim mints a chain NFT to your wallet.</p>
      <div class="note">${o.registry?.snapshotSlot && o.cluster !== 'mainnet-beta' ? 'This is the devnet preview. The snapshot here is a test list, and claiming is done by the test scripts.' : 'Claiming opens after the snapshot. The claim page will be here.'}</div>
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
    (a.dataset.nav === 'home' && parts.length === 0) || (a.dataset.nav === 'chains' && (parts[0] === 'chains' || parts[0] === 'chain')) || (a.dataset.nav === 'own' && parts[0] === 'own')));
  try {
    if (!overview) await loadOverview();
    if (parts.length === 0) await home();
    else if (parts[0] === 'chains') await chains();
    else if (parts[0] === 'own') await own();
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
