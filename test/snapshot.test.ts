import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { Snapshot, leaf, verify, claimsFor } from '../tools/snapshot.ts';

test('claims are whole millions held', () => {
  assert.equal(claimsFor(999_999_999_999n), 0);
  assert.equal(claimsFor(1_000_000_000_000n), 1);
  assert.equal(claimsFor(2_500_000_000_000n), 2);
});

for (const n of [1, 2, 3, 7, 64, 101]) {
  test(`every proof verifies with ${n} wallets; tampering fails`, () => {
    const entries = Array.from({ length: n }, (_, i) => ({ wallet: Keypair.generate().publicKey, claims: (i % 5) + 1 }));
    const s = new Snapshot(entries);
    for (const e of entries) {
      const { claims, proof } = s.proof(e.wallet);
      assert.equal(claims, e.claims);
      assert.ok(verify(proof, leaf(e), s.root));
      assert.ok(!verify(proof, leaf({ wallet: e.wallet, claims: e.claims + 1 }), s.root));
    }
  });
}

test('file is sorted and deterministic', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ wallet: Keypair.generate().publicKey, claims: i + 1 }));
  const a = new Snapshot(entries), b = new Snapshot([...entries].reverse());
  assert.equal(a.file(), b.file());
  assert.deepEqual(a.root, b.root);
  assert.throws(() => new Snapshot([entries[0], entries[0]]), /duplicate/);
});
