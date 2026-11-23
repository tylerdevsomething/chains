// The claim page (SPEC §4): connect a wallet, see your claims, and claim chains. The service builds
// the transaction (/api/claim/<wallet>/tx); the wallet signs and sends it.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s) => (s && s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? '');
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const span = (s) => {
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};

const provider = () => window.phantom?.solana ?? window.solana ?? null;
let wallet = null;

export async function claimPage(app, overview, exTx) {
  const cluster = overview.cluster;
  const render = async (msg = '') => {
    const p = provider();
    let body = '';
    if (!p) {
      body = `<p>You need a Solana wallet in this browser, such as <a href="https://phantom.com" target="_blank" rel="noopener">Phantom</a>.</p>`;
    } else if (!wallet) {
      body = `<button class="btn primary" id="connect">Connect wallet</button>`;
    } else {
      const s = await fetch(`/api/claim/${wallet}`).then((r) => r.json());
      body = statusHtml(s);
    }
    app.innerHTML = `
      <div style="max-width:720px;padding-top:28px">
        <div class="crumbs"><a href="#/own">Own a chain</a> / claim</div>
        <h1 style="font-size:40px">Claim chains</h1>
        ${cluster !== 'mainnet-beta' ? `<p class="note">This is the ${esc(cluster)} preview. Switch your wallet to ${esc(cluster)} (in Phantom: Settings → Developer settings → Testnet mode) before claiming.</p>` : ''}
        <div class="panel" style="padding:22px;margin-top:18px">${body}</div>
        ${msg ? `<p style="margin-top:14px">${msg}</p>` : ''}
        <h2>How claiming works</h2>
        <ul class="rules">
          <li>Every 1,000,000 $CHAINS you held at the snapshot is one claim.</li>
          <li>For the first 24 hours, each wallet can claim one chain.</li>
          <li>After that, use the rest of your claims, first come, first served.</li>
          <li>Claiming doesn't touch your $CHAINS. You pay about 0.003 SOL rent per chain.</li>
        </ul>
      </div>`;
    app.querySelector('#connect')?.addEventListener('click', async () => {
      try {
        const r = await provider().connect();
        wallet = r.publicKey.toString();
        render();
      } catch (e) {
        render(`<span class="bad">${esc(e.message ?? 'Connection refused.')}</span>`);
      }
    });
    app.querySelector('#disconnect')?.addEventListener('click', (e) => {
      e.preventDefault();
      wallet = null;
      provider()?.disconnect?.();
      render();
    });
    app.querySelectorAll('button[data-n]').forEach((b) => b.addEventListener('click', () => claim(Number(b.dataset.n))));
  };

  const statusHtml = (s) => {
    const head = `<div class="kv" style="margin-bottom:16px"><div class="k">Wallet</div><div class="v">${esc(short(wallet))} <a href="#" id="disconnect" class="dim">change</a></div>
      <div class="k">Chains left</div><div class="v">${s.left} of 500</div></div>`;
    if (s.problem) return head + `<p class="muted">${esc(s.problem)}</p>`;
    if (!s.listed) return head + `<p>This wallet isn't in the snapshot. It needed at least 1,000,000 $CHAINS at slot ${s.snapshotSlot.toLocaleString()}.</p>`;
    const info = `<p>This wallet has <b>${s.claims}</b> claim${s.claims === 1 ? '' : 's'} and has used <b>${s.used}</b>.</p>`;
    if (s.now < s.opensAt) return head + info + `<p class="muted">Claiming opens ${esc(when(s.opensAt))} (in ${span(s.opensAt - s.now)}).</p>`;
    if (s.left === 0) return head + info + `<p class="muted">All 500 chains have been claimed.</p>`;
    const inWindow = s.now < s.windowEndsAt;
    const window = inWindow ? `<p class="muted">One chain per wallet until ${esc(when(s.windowEndsAt))} (${span(s.windowEndsAt - s.now)} left). Then the rest of your claims open.</p>` : '';
    if (!s.canClaimNow) return head + info + window + `<p class="muted">Nothing to claim right now.</p>`;
    const max = Math.min(s.canClaimNow, 4);
    return head + info + window + `<div class="btns">${Array.from({ length: max }, (_, i) => i + 1)
      .map((n) => `<button class="btn ${n === 1 ? 'primary' : ''}" data-n="${n}">Claim ${n} chain${n === 1 ? '' : 's'}</button>`).join('')}</div>`;
  };

  const claim = async (n) => {
    try {
      const t = await fetch(`/api/claim/${wallet}/tx?n=${n}`).then((r) => r.json());
      if (t.error) throw new Error(t.error);
      const { signature } = await provider().request({ method: 'signAndSendTransaction', params: { message: t.message } });
      const ids = Array.from({ length: n }, (_, i) => t.firstId + i);
      await render(`<span class="ok">Sent.</span> You're claiming ${ids.map((id) => `<a href="#/chain/${id}">#${id}</a>`).join(', ')}. <a href="${exTx(signature)}" target="_blank" rel="noopener">View the transaction</a>. If someone claimed those ids just before you, it fails and costs nothing; try again.`);
    } catch (e) {
      render(`<span class="bad">${esc(e.message ?? 'Claim failed.')}</span>`);
    }
  };

  if (!wallet && provider()?.isConnected && provider()?.publicKey) wallet = provider().publicKey.toString();
  await render();
}
