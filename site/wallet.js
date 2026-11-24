// The connected wallet, shared by every page. The service builds each transaction
// (POST /api/tx/<wallet>, indexer/actions.ts); the wallet signs and sends it.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s) => (s && s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? '');

export const provider = () => window.phantom?.solana ?? window.solana ?? null;

const listeners = new Set();
export let wallet = null;

export function onWallet(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(w) {
  wallet = w;
  renderButton();
  listeners.forEach((fn) => fn(w));
}

export async function connect() {
  const p = provider();
  if (!p) {
    window.open('https://phantom.com', '_blank', 'noopener');
    throw new Error('Install a Solana wallet such as Phantom, then reload this page.');
  }
  const r = await p.connect();
  set(r.publicKey.toString());
  return wallet;
}

export function disconnect() {
  provider()?.disconnect?.();
  set(null);
}

function renderButton() {
  const el = document.getElementById('wallet');
  if (!el) return;
  el.innerHTML = wallet
    ? `<a class="btn small" href="#/account/${esc(wallet)}" title="${esc(wallet)}"><span class="pulse"></span> ${esc(short(wallet))}</a><button class="btn small ghost" id="wallet-out" title="Disconnect">×</button>`
    : `<button class="btn small primary" id="wallet-in">Connect wallet</button>`;
  el.querySelector('#wallet-in')?.addEventListener('click', () => connect().catch((e) => toast(esc(e.message), 'bad')));
  el.querySelector('#wallet-out')?.addEventListener('click', disconnect);
}

// ------------------------------------------------------------------ toasts

export function toast(html, kind = '', ms = 9000) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `<div>${html}</div><button aria-label="Close">×</button>`;
  t.querySelector('button').addEventListener('click', () => t.remove());
  box.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

// ------------------------------------------------------------------ actions

/**
 * Builds `body` on the service, has the wallet sign and send it, and waits for confirmation.
 * Returns true when it landed. `exTx` turns a signature into an explorer link.
 */
export async function act(body, exTx) {
  try {
    const w = wallet ?? (await connect());
    const r = await fetch(`/api/tx/${w}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    const pending = toast(`<b>Confirm in your wallet</b><br>${esc(r.summary)}`, '', 0);
    let signature;
    try {
      ({ signature } = await provider().request({ method: 'signAndSendTransaction', params: { message: r.message } }));
    } finally {
      pending.remove();
    }
    const sending = toast(`Sending… <a href="${exTx(signature)}" target="_blank" rel="noopener">view</a>`, '', 0);
    for (let i = 0; i < 60; i++) {
      const s = await fetch(`/api/sig/${signature}`).then((x) => x.json()).catch(() => ({}));
      if (s.err) {
        sending.remove();
        toast(`The transaction failed on chain. <a href="${exTx(signature)}" target="_blank" rel="noopener">Details</a>`, 'bad');
        return false;
      }
      if (s.status === 'confirmed' || s.status === 'finalized') break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    sending.remove();
    toast(`<b>Done.</b> ${esc(r.summary)} <a href="${exTx(signature)}" target="_blank" rel="noopener">View the transaction</a>`, 'ok');
    return true;
  } catch (e) {
    const m = e?.message ?? String(e);
    toast(/reject|cancel|denied/i.test(m) ? 'Cancelled in the wallet.' : esc(m), 'bad');
    return false;
  }
}

// Pick up an already-trusted wallet without a popup.
const p = provider();
p?.on?.('accountChanged', (k) => set(k ? k.toString() : null));
p?.connect?.({ onlyIfTrusted: true }).then((r) => set(r.publicKey.toString())).catch(() => renderButton());
renderButton();
