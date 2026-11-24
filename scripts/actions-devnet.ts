// Wallet-action rehearsal on devnet: builds each site action (indexer/actions.ts), signs it with test
// wallet E like a browser wallet would, and sends it. Run: node scripts/actions-devnet.ts
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { Connection, Keypair, Message, Transaction } from '@solana/web3.js';
import { Actions } from '../indexer/actions.ts';

const E = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('C:/Users/Admin/chains-keys/devnet/E.json', 'utf8'))));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const a = new Actions(conn);
const POOL = '6aS2swgrZf56mLNTHxTu3g7zS6gxvPTxeWaRNehECazd';
const COLL = '6YYsDEzKhJXmWa9dXffmdmU8d7pYxvSR6uhcHZmvUpbg';
console.log('E', E.publicKey.toBase58(), (await conn.getBalance(E.publicKey)) / 1e9, 'SOL');

async function run(body: Record<string, unknown>, send = true) {
  try {
    const r = await a.build(E.publicKey, body);
    console.log('OK  ', body.action, '|', r.summary);
    if (!send) return;
    const tx = Transaction.populate(Message.from(bs58.decode(r.message)));
    tx.sign(E);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('    sent', sig.slice(0, 16));
  } catch (e) {
    console.log('ERR ', body.action, '|', (e as Error).message);
  }
}

const ALL = process.argv.includes('--all');
if (ALL) {
await run({ action: 'deposit', chain: 1, sol: 0.02 });
await run({ action: 'buy', chain: 1, app: POOL, sol: 0.005 });
await run({ action: 'sell', chain: 1, app: POOL, amount: '1000' });
await run({ action: 'mint', chain: 1, app: COLL, price: '5000000' }, false); // sold out: expect an error
await run({ action: 'send', chain: 1, to: '7WKuYAnuPqeVPSfMAzcajC7YAa2WRu2H8bAmZj4xRUgi', sol: 0.001 });
await run({ action: 'withdraw', chain: 1, sol: 0.003 });
await run({ action: 'withdraw', chain: 1, sol: 999 }, false); // too much
await run({ action: 'launch', chain: 2 }, false); // E doesn't hold #2
await run({ action: 'claim_fees', chain: 1 }, false);
}

// Holder actions with wallet B (holds chain #2): launch with a name and end date, then rename.
const B = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('C:/Users/Admin/chains-keys/devnet/B.json', 'utf8'))));
async function runAs(k: Keypair, body: Record<string, unknown>, send = true) {
  try {
    const r = await a.build(k.publicKey, body);
    console.log('OK  ', body.action, '|', r.summary);
    if (!send) return;
    const tx = Transaction.populate(Message.from(bs58.decode(r.message)));
    tx.sign(k);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('    sent', sig.slice(0, 16));
  } catch (e) {
    console.log('ERR ', body.action, '|', (e as Error).message);
  }
}
const launched = !!(await conn.getAccountInfo((await import('../tools/chains.ts')).pda.chain(2)));
if (!launched) {
  await runAs(B, { action: 'launch', chain: 2, ends: new Date(Date.now() + 10 * 86400e3).toISOString() }, false); // too soon
  await runAs(B, { action: 'launch', chain: 2, name: 'Citrine Two', ends: new Date(Date.now() + 40 * 86400e3).toISOString() });
}
await runAs(B, { action: 'set_name', chain: 2, name: 'Citrine Deux' });
await runAs(B, { action: 'set_name', chain: 2, name: 'bad!name' }, false);
