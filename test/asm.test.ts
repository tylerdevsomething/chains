import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assemble, disassemble, OPS } from '../tools/asm.ts';

const app = (n: string) => readFileSync(new URL(`../tools/apps/${n}.asm`, import.meta.url), 'utf8');

test('opcode table matches the program (vm.rs)', () => {
  const rs = readFileSync(new URL('../programs/chains/src/vm.rs', import.meta.url), 'utf8');
  for (const [name, { op }] of Object.entries(OPS)) {
    const m = new RegExp(`pub const ${name.toUpperCase()}: u8 = 0x([0-9a-f]{2});`).exec(rs);
    assert.ok(m, `vm.rs defines ${name}`);
    assert.equal(parseInt(m[1], 16), op, name);
  }
});

test('encodings', () => {
  assert.deepEqual([...assemble('add r1, r2, r3')], [0x03, 1, 2, 3]);
  assert.deepEqual([...assemble('caller r4')], [0x10, 4, 0, 0]);
  assert.deepEqual([...assemble('call r1, r2, r3, r4')], [0x22, 1, 2, 3, 4, 0, 0, 0]);
  assert.deepEqual([...assemble('accountload r1, r2, r3')], [0x30, 1, 2, 3, 0, 0, 0, 0]);
  const c = assemble('const r1, 0x0102');
  assert.equal(c.length, 36);
  assert.deepEqual([...c.slice(32)], [0, 0, 1, 2]);
  assert.equal(Buffer.from(assemble('const r1, "hi"').slice(4, 6)).toString(), 'hi');
  // jumps use absolute byte offsets in B‖C
  assert.deepEqual([...assemble('top:\n stop\n jumpi r2, top\n jump @top')], [0, 0, 0, 0, 0x21, 2, 0, 0, 0x20, 0, 0, 0]);
  assert.deepEqual([...assemble('.equ X 7\nconst r0, X').slice(32)], [0, 0, 0, 7]);
  assert.deepEqual([...assemble('stop ; comment # also\n# whole line')], [0, 0, 0, 0]);
});

test('errors', () => {
  assert.throws(() => assemble('frob r1'), /unknown instruction/);
  assert.throws(() => assemble('add r1, r2'), /takes 3/);
  assert.throws(() => assemble('mov r1, r16'), /register/);
  assert.throws(() => assemble('jump nowhere'), /unknown label/);
  assert.throws(() => assemble('a:\na:\nstop'), /duplicate label/);
});

for (const name of ['swap', 'collection']) {
  test(`${name}.asm assembles and round-trips through the disassembler`, () => {
    const code = assemble(app(name));
    assert.ok(code.length > 100 && code.length <= 10_240);
    assert.deepEqual(assemble(disassemble(code)), code);
  });
}
