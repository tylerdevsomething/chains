// Wallet panels: "use this chain" on chain pages and trade/mint on app pages. Every button goes
// through act() in wallet.js (the service builds and simulates, the wallet signs).

import { wallet, connect, onWallet, act } from './wallet.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s) => (s && s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? '');
const sol = (l, dp = 6) => {
  const v = Number(BigInt(l ?? 0)) / 1e9;
  return v === 0 ? '0' : v.toLocaleString(undefined, { maximumFractionDigits: dp });
};

async function mine() {
  if (!wallet) return null;
  return fetch(`/api/account/${wallet}`).then((r) => r.json()).catch(() => null);
}

/** Wires a panel so it re-renders when the wallet connects or changes, while it's on screen. */
function mount(el, render) {
  const off = onWallet(() => (document.body.contains(el) ? render() : off()));
  render();
}

const connectBtn = '<button class="btn primary" data-connect>Connect wallet</button>';
function wireConnect(el) {
  el.querySelectorAll('[data-connect]').forEach((b) => b.addEventListener('click', () => connect().catch(() => {})));
}

/** Tabs + forms. `forms` = [{ id, label, html, submit(form) → body }]. */
function tabbed(el, forms, ctx) {
  let current = forms[0].id;
  const draw = () => {
    const f = forms.find((x) => x.id === current);
    el.innerHTML = `
      <div class="tabs small">${forms.map((x) => `<button type="button" data-t="${x.id}" class="${x.id === current ? 'on' : ''}">${esc(x.label)}</button>`).join('')}</div>
      <form class="actform">${f.html}<button class="btn primary wide">${esc(f.cta ?? f.label)}</button></form>`;
    el.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { current = b.dataset.t; draw(); }));
    const form = el.querySelector('form');
    f.wire?.(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button.wide');
      btn.disabled = true;
      try {
        const body = f.submit(form);
        if (body && (await act(body, ctx.exTx))) setTimeout(ctx.reload, 1500);
      } finally {
        btn.disabled = false;
      }
    });
  };
  draw();
}

const field = (name, label, attrs = '', hint = '') =>
  `<label class="fld"><span>${label}</span><input name="${name}" ${attrs} autocomplete="off" spellcheck="false">${hint ? `<small>${hint}</small>` : ''}</label>`;

// ------------------------------------------------------------------ chain page

export function chainPanel(el, c, ctx) {
  mount(el, async () => {
    const isHolder = wallet && wallet === c.holder;
    const unpaid = BigInt(c.feesAccrued ?? 0) - BigInt(c.feesClaimed ?? 0);

    if (c.stage === 'unclaimed') {
      el.innerHTML = `<div class="panel pad">Nobody has claimed this chain yet. <a href="#/claim">Go to the claim page</a>.</div>`;
      return;
    }

    if (c.stage === 'claimed') {
      if (!isHolder) {
        el.innerHTML = `<div class="panel pad">Only the holder (${esc(short(c.holder))}) can launch this chain. ${wallet ? '' : connectBtn}</div>`;
        wireConnect(el);
        return;
      }
      const min = new Date(Date.now() + 31 * 86400e3).toISOString().slice(0, 10);
      el.innerHTML = `<div class="panel pad">
        <h3 style="margin-top:0">Launch your chain</h3>
        <p class="muted">You hold this chain. Launching starts its history; then anyone can deposit and deploy apps, and you earn half the fees. You pay about 0.02 SOL rent.</p>
        <form class="actform" id="launch">
          ${field('cname', 'Name (optional)', 'maxlength="24" placeholder="e.g. Ruby One"')}
          <label class="fld"><span>End date</span>
            <select name="mode"><option value="none">No end date</option><option value="date">Ends on a date</option></select></label>
          <label class="fld" hidden id="ends"><span>Ends on (at least 30 days away; fixed forever)</span><input type="date" name="ends" min="${min}" value="${min}"></label>
          <button class="btn primary wide">Launch chain #${c.id}</button>
        </form></div>`;
      const f = el.querySelector('#launch');
      f.mode.addEventListener('change', () => { el.querySelector('#ends').hidden = f.mode.value !== 'date'; });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { action: 'launch', chain: c.id, name: f.cname.value.trim() };
        if (f.mode.value === 'date') body.ends = `${f.ends.value}T12:00:00Z`;
        if (await act(body, ctx.exTx)) setTimeout(ctx.reload, 2500);
      });
      return;
    }

    // Launched.
    const ended = c.status !== 'running';
    if (ended) {
      el.innerHTML = `<div class="panel pad">
        ${c.status === 'swept' ? '<p class="muted">This chain ended and was swept. Its history stays readable forever.</p>'
          : `<p>This chain has ended. Anyone can sweep it: everything left inside goes to the holder${unpaid > 0n ? ', after paying out the fees' : ''}.</p>
             <button class="btn primary" id="sweep">Sweep chain #${c.id}</button>`}
      </div>`;
      el.querySelector('#sweep')?.addEventListener('click', async () => { if (await act({ action: 'sweep', chain: c.id }, ctx.exTx)) setTimeout(ctx.reload, 2500); });
      return;
    }

    const me = await mine();
    if (!document.body.contains(el)) return;
    const bal = me?.balances?.find((b) => b.chain === c.id);
    el.innerHTML = `<div class="use">
      <div class="panel pad you">
        <div class="muted small">You hold inside this chain</div>
        <div class="bigv">${wallet ? `${sol(bal?.balance ?? 0)} <span class="muted">SOL</span>` : '—'}</div>
        ${wallet ? `<div class="muted small">${esc(short(wallet))} · nonce ${Number(bal?.nonce ?? 0)}</div>` : connectBtn}
        <hr>
        <div class="muted small">Chain fees not paid out</div>
        <div><b>${sol(unpaid.toString())}</b> SOL ${unpaid > 0n ? '<button class="btn small" id="payout">Pay out</button>' : ''}</div>
        <div class="muted small" style="margin-top:4px">Anyone can trigger the payout: half to the holder, half to the treasury.</div>
        ${isHolder ? `<hr><div class="muted small">You're the holder</div>
          <form class="actform inline" id="rename">${field('cname', 'Name', `maxlength="24" value="${esc(c.name ?? '')}"`)}<button class="btn small">Rename</button></form>` : ''}
      </div>
      <div class="panel pad" id="tabs"></div>
    </div>`;
    wireConnect(el);
    el.querySelector('#payout')?.addEventListener('click', async () => { if (await act({ action: 'claim_fees', chain: c.id }, ctx.exTx)) setTimeout(ctx.reload, 2000); });
    el.querySelector('#rename')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await act({ action: 'set_name', chain: c.id, name: e.target.cname.value.trim() }, ctx.exTx)) setTimeout(ctx.reload, 2000);
    });
    tabbed(el.querySelector('#tabs'), [
      { id: 'deposit', label: 'Deposit', html: field('sol', 'Amount (SOL)', 'inputmode="decimal" placeholder="0.1" required') + field('to', 'Credit to (optional)', 'placeholder="your address"', 'Empty means your own wallet.'),
        submit: (f) => ({ action: 'deposit', chain: c.id, sol: f.sol.value, to: f.to.value }) },
      { id: 'withdraw', label: 'Withdraw', html: field('sol', 'Amount (SOL)', 'inputmode="decimal" required', bal ? `Up to ${sol(bal.balance)} SOL.` : '') + field('to', 'Send to (optional)', 'placeholder="your address"', 'Empty means your own wallet.'),
        submit: (f) => ({ action: 'withdraw', chain: c.id, sol: f.sol.value, to: f.to.value }) },
      { id: 'send', label: 'Send inside', html: field('to', 'To address', 'required') + field('sol', 'Amount (SOL)', 'inputmode="decimal" required', 'Moves SOL between balances inside this chain. Pays a small chain fee.'),
        submit: (f) => ({ action: 'send', chain: c.id, sol: f.sol.value, to: f.to.value }) },
    ], ctx);
  });
}

// ------------------------------------------------------------------ app page

export function appPanel(el, a, ctx) {
  mount(el, async () => {
    const st = a.state;
    const me = await mine();
    if (!document.body.contains(el)) return;
    const bal = me?.balances?.find((b) => b.chain === a.chain);
    const tok = me?.tokens?.find((t) => t.chain === a.chain && t.app === a.address);
    const mineItems = me?.items?.find((t) => t.chain === a.chain && t.app === a.address)?.ids ?? [];
    const head = `<div class="muted small">${wallet
      ? `You hold ${sol(bal?.balance ?? 0)} SOL inside chain #${a.chain}${st?.kind === 'pool' ? ` and ${Number(tok?.balance ?? 0).toLocaleString()} ${esc(st.ticker)}` : ''}${st?.kind === 'collection' ? ` and ${mineItems.length} item${mineItems.length === 1 ? '' : 's'}${mineItems.length ? ` (${mineItems.slice(0, 12).map((i) => `#${i}`).join(', ')})` : ''}` : ''}. <a href="#/chain/${a.chain}">Deposit or withdraw</a> on the chain page.`
      : 'Connect a wallet to use this app.'}</div>`;
    el.innerHTML = `<div class="panel pad">${head}${wallet ? '' : `<p>${connectBtn}</p>`}<div id="tabs" style="margin-top:12px"></div></div>`;
    wireConnect(el);
    const tabs = el.querySelector('#tabs');
    const base = { chain: a.chain, app: a.address };

    if (st?.kind === 'pool' && st.seeded) {
      tabbed(tabs, [
        { id: 'buy', label: `Buy ${st.ticker}`, html: field('sol', 'Pay (SOL, from your balance inside the chain)', 'inputmode="decimal" placeholder="0.01" required', `Now 1 SOL buys about ${Number(st.tokensPerSol).toLocaleString()} ${esc(st.ticker)}. 0.3% goes to the pool's seeder. At most 1% slippage.`),
          submit: (f) => ({ ...base, action: 'buy', sol: f.sol.value }) },
        { id: 'sell', label: `Sell ${st.ticker}`, html: field('amount', `Amount (${esc(st.ticker)})`, `inputmode="numeric" required placeholder="${tok?.balance ?? ''}"`, tok ? `You have ${Number(tok.balance).toLocaleString()}. <a href="#" data-max>Sell all</a>` : ''),
          wire: (f) => f.querySelector('[data-max]')?.addEventListener('click', (e) => { e.preventDefault(); f.amount.value = tok.balance; }),
          submit: (f) => ({ ...base, action: 'sell', amount: f.amount.value }) },
        { id: 'send', label: 'Send', html: field('to', 'To address', 'required') + field('amount', `Amount (${esc(st.ticker)})`, 'inputmode="numeric" required'),
          submit: (f) => ({ ...base, action: 'token_transfer', to: f.to.value, amount: f.amount.value }) },
      ], ctx);
    } else if (st?.kind === 'collection' && st.created) {
      const left = Number(st.cap) - st.minted;
      tabbed(tabs, [
        { id: 'mint', label: 'Mint', cta: left > 0 ? `Mint for ${sol(st.price)} SOL` : 'Sold out',
          html: `<p class="muted">${left > 0 ? `${left.toLocaleString()} of ${Number(st.cap).toLocaleString()} left. The price goes to the creator, paid from your balance inside the chain.` : 'Every item has been minted.'}</p>`,
          submit: () => (left > 0 ? { ...base, action: 'mint', price: st.price } : null) },
        { id: 'send', label: 'Send an item', html: field('item', 'Item number', `inputmode="numeric" required placeholder="${mineItems[0] ?? ''}"`) + field('to', 'To address', 'required'),
          submit: (f) => ({ ...base, action: 'nft_transfer', item: f.item.value, to: f.to.value }) },
      ], ctx);
    } else {
      tabbed(tabs, [
        { id: 'call', label: 'Call', html: field('data', 'Calldata (hex, 32-byte words)', 'placeholder="0x0000…0001" class="mono"') + field('sol', 'Send SOL with it (optional)', 'inputmode="decimal"'),
          submit: (f) => ({ ...base, action: 'call', data: f.data.value, sol: f.sol.value }) },
      ], ctx);
    }
  });
}
