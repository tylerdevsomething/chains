// Wallet actions for the site: the service builds a transaction, simulates it (so errors show up
// before the wallet opens, the chain fee is known exactly, and a full state account gets a `grow`
// in front), and hands back the message for the wallet to sign and send.

import bs58 from 'bs58';
import {
  ComputeBudgetProgram, Connection, PublicKey, Transaction, VersionedTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import { IDL, ix, pda, chainAccounts, decodeHeader, decodeRegistry, errorName } from '../tools/chains.ts';

const MIN_EXPIRY = 30 * 24 * 60 * 60;
const MAX_STEPS = 10_000;
const LAMPORTS = 1_000_000_000;

const word = (n: bigint | number | PublicKey) => {
  if (n instanceof PublicKey) return Buffer.from(n.toBytes());
  const b = Buffer.alloc(32);
  let v = BigInt(n);
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const calldata = (...words: (bigint | number | PublicKey)[]) => Buffer.concat(words.map(word));

const ERR_MSG: Record<string, string> = Object.fromEntries(IDL.errors.map((e: { name: string; msg?: string }) => [e.name, e.msg ?? e.name]));
const FRIENDLY: Record<string, string> = {
  InsufficientBalance: "Your balance inside this chain is too low (it also pays the chain fee). Deposit SOL first.",
  ChainEnded: 'This chain has ended. Nothing can be deposited, called or withdrawn.',
  NotHolder: "This wallet doesn't hold this chain's NFT.",
  RequireFailed: 'The app refused this call (a check inside it failed: sold out, wrong price, slippage, or not enough tokens).',
  Reverted: 'The app reverted this call.',
  FeeTooHigh: 'The chain fee went up since the estimate. Try again.',
  BadExpiry: 'The end date must be at least 30 days away, or none.',
  BadName: 'Names are up to 24 letters, digits, hyphens or inner spaces.',
};

export class ActionError extends Error {}

type Body = Record<string, unknown>;

const str = (b: Body, k: string) => String(b[k] ?? '').trim();
const key = (b: Body, k: string, fallback?: PublicKey) => {
  const v = str(b, k);
  if (!v && fallback) return fallback;
  try {
    return new PublicKey(v);
  } catch {
    throw new ActionError(`${k} is not a valid address`);
  }
};
const sol = (b: Body, k: string) => {
  const v = Number(b[k]);
  if (!Number.isFinite(v) || v <= 0) throw new ActionError('Enter an amount above zero.');
  return BigInt(Math.round(v * LAMPORTS));
};
const int = (b: Body, k: string) => {
  const s = str(b, k);
  if (!/^\d+$/.test(s) || BigInt(s) === 0n) throw new ActionError(`${k} must be a whole number above zero.`);
  return BigInt(s);
};

export class Actions {
  readonly conn: Connection;
  constructor(conn: Connection) {
    this.conn = conn;
  }

  /** Builds, simulates and returns an unsigned transaction for `wallet`. */
  async build(wallet: PublicKey, b: Body) {
    const action = str(b, 'action');
    const id = Number(b.chain);
    if (!Number.isInteger(id) || id < 1 || id > 500) throw new ActionError('Bad chain id.');
    const acc = chainAccounts(id);
    let summary = '';

    const transact = (target: PublicKey, value: bigint, data: Buffer, maxFee: bigint, guest = true) =>
      ix('transact', { sender: wallet, ...acc }, { id, target, value, data, max_steps: MAX_STEPS, max_fee: maxFee },
        guest ? [{ pubkey: pda.code(id, target.toBytes()), isSigner: false, isWritable: false }] : []);

    // Calls into the chain's VM: first simulate with a generous max_fee to learn the real fee and
    // the app's result, then rebuild with a tight max_fee (and slippage limits from the result).
    const call = async (target: PublicKey, value: bigint, data: (minOut: bigint) => Buffer, slippage = false, guest = true) => {
      const first = await this.simulate(wallet, id, [transact(target, value, data(0n), 10n ** 15n, guest)]);
      const out = first.ret ? BigInt('0x' + (Buffer.from(first.ret).toString('hex') || '0')) : 0n;
      const minOut = slippage ? (out * 99n) / 100n : 0n;
      const maxFee = first.chainFee + first.chainFee / 5n + 5_000n;
      return { ixs: [transact(target, value, data(minOut), maxFee, guest)], out, fee: first.chainFee };
    };

    let ixs: TransactionInstruction[];
    switch (action) {
      case 'deposit': {
        const lamports = sol(b, 'sol');
        const to = key(b, 'to', wallet);
        ixs = [ix('deposit', { payer: wallet, ...acc }, { id, beneficiary: to, lamports })];
        summary = `Deposit ${fmt(lamports)} SOL into chain #${id}${to.equals(wallet) ? '' : ` for ${short(to)}`}.`;
        break;
      }
      case 'withdraw': {
        const lamports = sol(b, 'sol');
        const to = key(b, 'to', wallet);
        ixs = [ix('withdraw', { account: wallet, ...acc, recipient: to }, { id, lamports })];
        summary = `Withdraw ${fmt(lamports)} SOL from chain #${id}${to.equals(wallet) ? '' : ` to ${short(to)}`}.`;
        break;
      }
      case 'send': {
        const lamports = sol(b, 'sol');
        const to = key(b, 'to');
        const c = await call(to, lamports, () => Buffer.alloc(0), false, false);
        ixs = c.ixs;
        summary = `Send ${fmt(lamports)} SOL to ${short(to)} inside chain #${id}. Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'buy': {
        const app = key(b, 'app');
        const lamports = sol(b, 'sol');
        const c = await call(app, lamports, (min) => calldata(2, min), true);
        ixs = c.ixs;
        summary = `Buy about ${c.out.toLocaleString()} tokens for ${fmt(lamports)} SOL (at most 1% less). Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'sell': {
        const app = key(b, 'app');
        const amount = int(b, 'amount');
        const c = await call(app, 0n, (min) => calldata(3, amount, min), true);
        ixs = c.ixs;
        summary = `Sell ${amount.toLocaleString()} tokens for about ${fmt(c.out)} SOL (at most 1% less). Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'token_transfer': {
        const app = key(b, 'app');
        const to = key(b, 'to');
        const amount = int(b, 'amount');
        const c = await call(app, 0n, () => calldata(5, to, amount));
        ixs = c.ixs;
        summary = `Send ${amount.toLocaleString()} tokens to ${short(to)}. Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'mint': {
        const app = key(b, 'app');
        const price = BigInt(str(b, 'price') || '0');
        const c = await call(app, price, () => calldata(2));
        ixs = c.ixs;
        summary = `Mint item #${c.out} for ${fmt(price)} SOL. Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'nft_transfer': {
        const app = key(b, 'app');
        const to = key(b, 'to');
        const item = int(b, 'item');
        const c = await call(app, 0n, () => calldata(3, item, to));
        ixs = c.ixs;
        summary = `Send item #${item} to ${short(to)}. Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'call': {
        const app = key(b, 'app');
        const hex = str(b, 'data').replace(/^0x/, '');
        if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new ActionError('Calldata must be hex.');
        const value = str(b, 'sol') ? sol(b, 'sol') : 0n;
        const c = await call(app, value, () => Buffer.from(hex, 'hex'));
        ixs = c.ixs;
        summary = `Call ${short(app)}${value ? ` with ${fmt(value)} SOL` : ''}; it returns ${c.out}. Chain fee about ${fmt(c.fee)} SOL.`;
        break;
      }
      case 'launch': {
        const ends = str(b, 'ends');
        let expiry = 0;
        if (ends) {
          expiry = Math.floor(new Date(ends).getTime() / 1000);
          if (!Number.isFinite(expiry)) throw new ActionError('Bad end date.');
          if (expiry < Date.now() / 1000 + MIN_EXPIRY + 600) throw new ActionError('The end date must be more than 30 days away, or none.');
        }
        ixs = [ix('launch', { holder: wallet, ...acc }, { id, expiry })];
        const name = str(b, 'name');
        if (name) ixs.push(ix('set_name', { holder: wallet, asset: acc.asset, header: acc.header }, { id, name }));
        summary = `Launch chain #${id}${name ? ` as "${name}"` : ''}, ${expiry ? `ending ${new Date(expiry * 1000).toUTCString()}` : 'with no end date'}. You pay its rent (about 0.02 SOL).`;
        break;
      }
      case 'set_name': {
        const name = str(b, 'name');
        ixs = [ix('set_name', { holder: wallet, asset: acc.asset, header: acc.header }, { id, name })];
        summary = `Rename chain #${id} to "${name}".`;
        break;
      }
      case 'claim_fees':
      case 'sweep': {
        const reg = decodeRegistry((await this.conn.getAccountInfo(pda.registry()))!.data);
        const asset = await this.conn.getAccountInfo(acc.asset);
        const holder = asset && asset.data[0] === 1 ? new PublicKey(asset.data.subarray(1, 33)) : reg.treasury;
        ixs = [ix(action, { ...acc, holder, treasury: reg.treasury }, { id })];
        summary = action === 'claim_fees'
          ? `Pay out chain #${id}'s fees: half to the holder (${short(holder)}), half to the treasury.`
          : `Sweep chain #${id}: everything left inside goes to its holder (${short(holder)}).`;
        break;
      }
      default:
        throw new ActionError('Unknown action.');
    }

    // Final simulation; grow the state account first if it's full.
    let sim = await this.simulate(wallet, id, ixs, false);
    if (sim.error === 'NoSpace') {
      ixs = [ix('grow', { payer: wallet, ...acc }, { id, bytes: 10_240 }), ...ixs];
      summary += ' The chain also needs more storage, so this adds about 0.07 SOL of rent to it first.';
      sim = await this.simulate(wallet, id, ixs, false);
    }
    if (sim.error) throw new ActionError(FRIENDLY[sim.error] ?? ERR_MSG[sim.error] ?? sim.error);

    const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, Math.ceil(sim.cu * 1.3) + 20_000) }), ...ixs);
    t.feePayer = wallet;
    t.recentBlockhash = (await this.conn.getLatestBlockhash('confirmed')).blockhash;
    return { message: bs58.encode(t.serializeMessage()), summary };
  }

  /** Simulates; returns the guest result, the chain fee charged and the program error name, if any. */
  async simulate(wallet: PublicKey, id: number, ixs: TransactionInstruction[], throwOnError = true) {
    const t = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
    t.feePayer = wallet;
    t.recentBlockhash = (await this.conn.getLatestBlockhash('confirmed')).blockhash;
    const header = pda.chain(id);
    const before = await this.conn.getAccountInfo(header);
    const sim = await this.conn.simulateTransaction(new VersionedTransaction(t.compileMessage()), {
      sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [header.toBase58()] },
    });
    let error: string | null = null;
    const err = sim.value.err as { InstructionError?: [number, unknown] } | string | null;
    if (err) {
      const inner = typeof err === 'object' ? err.InstructionError?.[1] : null;
      const custom = inner && typeof inner === 'object' && 'Custom' in (inner as object) ? (inner as { Custom: number }).Custom : null;
      error = custom != null ? errorName(custom) : JSON.stringify(err);
      if (/insufficient lamports|InsufficientFundsForRent|AccountNotFound/i.test(JSON.stringify(err) + (sim.value.logs ?? []).join(' '))) {
        error = 'Your wallet does not have enough SOL for this.';
      }
      const e = error as string;
      if (throwOnError) throw new ActionError(FRIENDLY[e] ?? ERR_MSG[e] ?? e);
    }
    let chainFee = 0n;
    const after = sim.value.accounts?.[0];
    if (!err && before && after) {
      const h0 = decodeHeader(before.data);
      const h1 = decodeHeader(Buffer.from(after.data[0], 'base64'));
      chainFee = h1.feesAccrued - h0.feesAccrued + (h0.totalDeposits - h1.totalDeposits); // fee + storage rent
    }
    const rd = sim.value.returnData;
    return { error, chainFee: chainFee > 0n ? chainFee : 0n, ret: rd ? Buffer.from(rd.data[0], 'base64') : null, cu: sim.value.unitsConsumed ?? 200_000 };
  }
}

const short = (k: PublicKey) => {
  const s = k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
const fmt = (l: bigint) => {
  const v = Number(l) / LAMPORTS;
  return v === 0 ? '0' : v < 0.000001 ? '<0.000001' : v.toLocaleString('en-US', { maximumFractionDigits: 6 });
};
