// The snapshot page (SPEC §3): the announced window, the reveal, the chosen slot and how to check it,
// the published claims list, and when claims open. Data: /api/launch.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => Number(n ?? 0).toLocaleString();
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const span = (s) => {
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const SLOT_SECONDS = 0.4;

let timer = null;

export async function snapshotPage(app, exAddr) {
  const d = await fetch('/api/launch').then((r) => r.json());
  const a = d.announcement;
  const oc = d.onChain;
  // Slot → approximate time, from the current slot.
  const slotTime = (s) => d.now + (s - d.slot) * SLOT_SECONDS;
  const slotWhen = (s) => (d.slot == null ? '' : `${s <= d.slot ? '' : 'about '}${when(slotTime(s))}`);

  const steps = [];
  const step = (state, title, body) => steps.push({ state, title, body });

  step(d.mint ? 'done' : 'todo', 'The token', d.mint
    ? `$CHAINS mint <a class="mono" href="${exAddr(d.mint)}" target="_blank" rel="noopener">${esc(d.mint)}</a>. Every 1,000,000 held at the snapshot is one claim.`
    : 'The $CHAINS token is not launched yet.');

  if (a) {
    const open = d.slot >= a.w0, closed = d.slot > a.w1;
    step(closed ? 'done' : open ? 'now' : 'todo', 'The snapshot window',
      `Slots <b>${num(a.w0)}</b> to <b>${num(a.w1)}</b> (${slotWhen(a.w0)} to ${slotWhen(a.w1)}). The snapshot is taken at one slot inside it, and nobody knows which one in advance, us included.
       ${!closed && d.slot != null ? `<br><span class="muted">${open ? `Open now. Closes in about ${span((a.w1 - d.slot) * SLOT_SECONDS)}.` : `Opens in about ${span((a.w0 - d.slot) * SLOT_SECONDS)}.`}</span>` : ''}`);
    step(a.blockhash ? 'done' : closed ? 'now' : 'todo', 'The reveal',
      a.blockhash
        ? `The first block at or after slot ${num(a.reveal)} is block ${num(a.revealBlock)}, with blockhash <span class="mono">${esc(a.blockhash)}</span>.`
        : `The snapshot slot comes from the blockhash of the first block at or after slot <b>${num(a.reveal)}</b> (${slotWhen(a.reveal)}), after the window closes, so it can't be known or steered in advance.`);
    step(a.snapshotSlot ? 'done' : 'todo', 'The snapshot slot',
      a.snapshotSlot
        ? `<div class="bigv">${num(a.snapshotSlot)}</div>
           <p class="muted">slot = ${num(a.w0)} + (first 8 bytes of keccak256("chains:snapshot" ‖ blockhash) mod ${num(a.w1 - a.w0 + 1)}). Check it yourself:</p>
           <pre class="code small">node tools/snapshot-slot.ts ${a.w0} ${a.w1} ${a.reveal}</pre>`
        : 'Computed from the reveal blockhash once it is final.');
  } else if (oc?.snapshotSlot) {
    step('done', 'The snapshot slot', `<div class="bigv">${num(oc.snapshotSlot)}</div>`);
  } else {
    step('todo', 'The snapshot window', 'Not announced yet. We announce a window of slots and a later reveal slot before the window opens. Follow the announcements.');
  }

  const rootOk = d.summary && oc?.root && d.summary.root === oc.root;
  const listReady = !!d.file;
  step(listReady ? 'done' : 'todo', 'The claims list',
    listReady
      ? `<div class="kv">
           <div class="k">Wallets</div><div class="v">${num(d.file.wallets)}</div>
           <div class="k">Claims</div><div class="v">${num(d.file.claims)} for 500 chains</div>
           <div class="k">File SHA-256</div><div class="v">${esc(d.file.sha256)}</div>
           ${oc?.root && !/^0+$/.test(oc.root) ? `<div class="k">Merkle root on chain</div><div class="v">${esc(oc.root)} ${d.claims ? `<span class="bad">· ${esc(d.claims)}</span>` : '<span class="ok">· matches the file</span>'}</div>` : ''}
         </div>
         <p><a class="btn small" href="/snapshot.csv" download>Download snapshot.csv</a></p>
         <p class="muted small">Rebuild it from the token's public history: <span class="mono">node indexer/build-snapshot.ts --mint ${esc(d.mint ?? '<MINT>')} --slot ${oc?.snapshotSlot || a?.snapshotSlot || '<SLOT>'}</span>. Only wallets count: pools, the bonding curve and other program-owned accounts are left out.</p>`
      : 'Built from the token\'s history at the snapshot slot and published here with its hash, before claims open.');
  void rootOk;

  if (oc?.snapshotSlot && oc.claimsOpenAt) {
    const opens = oc.claimsOpenAt, ends = opens + 86400;
    const state = d.now >= opens ? 'done' : 'now';
    step(state, 'Claims open',
      `${d.now < opens ? `<div class="bigv" id="countdown">${span(opens - d.now)}</div>` : ''}
       <p>Claims open <b>${esc(when(opens))}</b>. Until ${esc(when(ends))}, each wallet can claim one chain; after that, first come, first served. <b>${num(oc.claimed)}</b> of 500 claimed so far.</p>
       <p><a class="btn primary small" href="#/claim">Go to the claim page</a></p>`);
  } else {
    step('todo', 'Claims open', 'Set on chain together with the snapshot root, and announced here.');
  }

  app.innerHTML = `
    <div style="max-width:820px;padding-top:28px">
      <div class="crumbs"><a href="#/own">Own a chain</a> / snapshot</div>
      <h1 style="font-size:40px">The snapshot</h1>
      <p class="lead muted" style="font-size:17px">Who can claim a chain is decided by $CHAINS balances at one Solana slot. Here is how that slot is picked, the list it produced, and how to check both yourself.</p>
      <ol class="timeline">
        ${steps.map((s) => `<li class="${s.state}"><div class="dot"></div><div><h3>${esc(s.title)} ${s.state === 'now' ? '<span class="pill running">now</span>' : ''}</h3><div>${s.body}</div></div></li>`).join('')}
      </ol>
    </div>`;

  clearInterval(timer);
  const cd = app.querySelector('#countdown');
  if (cd) {
    const t0 = Date.now();
    timer = setInterval(() => {
      if (!document.body.contains(cd)) return clearInterval(timer);
      const left = oc.claimsOpenAt - (d.now + (Date.now() - t0) / 1000);
      cd.textContent = left > 0 ? span(left) : 'Open now';
    }, 1000);
  }
}
