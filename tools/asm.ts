// MiniVM assembler and disassembler (SPEC §9).
//
//   node tools/asm.ts build <file.asm> [out.bin]     assemble (prints hex without out)
//   node tools/asm.ts dis <file.bin|hex>             disassemble
//
// Syntax, one instruction per line:
//   ; comment            # comment
//   name:                a label (a jump target)
//   .equ NAME value      a named constant for CONST
//   const r1, 42         decimal, 0x hex, "text" (left-aligned bytes), a .equ name, or @label (its offset)
//   add r3, r1, r2
//   jump done            jumpi r1, loop
//   call r0, r1, r2, r3  log3 r1, r2, r3, r4    accountload r1, r2, r3

export type Shape = 'none' | 'const' | 'jump' | 'jumpi' | { regs: number; len: 4 | 8 };

export const OPS: Record<string, { op: number; shape: Shape }> = {
  stop: { op: 0x00, shape: 'none' },
  const: { op: 0x01, shape: 'const' },
  mov: { op: 0x02, shape: { regs: 2, len: 4 } },
  add: { op: 0x03, shape: { regs: 3, len: 4 } },
  sub: { op: 0x04, shape: { regs: 3, len: 4 } },
  mul: { op: 0x05, shape: { regs: 3, len: 4 } },
  div: { op: 0x06, shape: { regs: 3, len: 4 } },
  eq: { op: 0x07, shape: { regs: 3, len: 4 } },
  lt: { op: 0x08, shape: { regs: 3, len: 4 } },
  and: { op: 0x09, shape: { regs: 3, len: 4 } },
  or: { op: 0x0a, shape: { regs: 3, len: 4 } },
  xor: { op: 0x0b, shape: { regs: 3, len: 4 } },
  not: { op: 0x0c, shape: { regs: 2, len: 4 } },
  shl: { op: 0x0d, shape: { regs: 3, len: 4 } },
  shr: { op: 0x0e, shape: { regs: 3, len: 4 } },
  caller: { op: 0x10, shape: { regs: 1, len: 4 } },
  address: { op: 0x11, shape: { regs: 1, len: 4 } },
  callvalue: { op: 0x12, shape: { regs: 1, len: 4 } },
  calldataload: { op: 0x13, shape: { regs: 2, len: 4 } },
  calldatasize: { op: 0x14, shape: { regs: 1, len: 4 } },
  balance: { op: 0x15, shape: { regs: 2, len: 4 } },
  sload: { op: 0x16, shape: { regs: 2, len: 4 } },
  sstore: { op: 0x17, shape: { regs: 2, len: 4 } },
  transfer: { op: 0x18, shape: { regs: 2, len: 4 } },
  require: { op: 0x19, shape: { regs: 1, len: 4 } },
  return: { op: 0x1a, shape: { regs: 1, len: 4 } },
  revert: { op: 0x1b, shape: { regs: 1, len: 4 } },
  jump: { op: 0x20, shape: 'jump' },
  jumpi: { op: 0x21, shape: 'jumpi' },
  call: { op: 0x22, shape: { regs: 4, len: 8 } },
  hash: { op: 0x23, shape: { regs: 3, len: 4 } },
  log3: { op: 0x24, shape: { regs: 4, len: 8 } },
  log4: { op: 0x25, shape: { regs: 4, len: 8 } },
  accountload: { op: 0x30, shape: { regs: 3, len: 8 } },
};
const BY_OP = new Map(Object.entries(OPS).map(([name, v]) => [v.op, { name, ...v }]));

const lenOf = (s: Shape) => (s === 'const' ? 36 : typeof s === 'object' ? s.len : 4);

export class AsmError extends Error {
  constructor(line: number, msg: string) {
    super(`line ${line}: ${msg}`);
  }
}

function reg(tok: string, line: number): number {
  const m = /^r(\d+)$/i.exec(tok);
  if (!m || +m[1] > 15) throw new AsmError(line, `expected a register r0..r15, got "${tok}"`);
  return +m[1];
}

/** A 32-byte big-endian word from a literal. */
export function word(v: bigint | string): Uint8Array {
  const out = new Uint8Array(32);
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    if (b.length > 32) throw new Error(`text longer than 32 bytes: ${v}`);
    out.set(b);
    return out;
  }
  let x = BigInt.asUintN(256, v);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function assemble(src: string): Uint8Array {
  type Item = { line: number; name: string; args: string[]; at: number };
  const items: Item[] = [];
  const labels = new Map<string, number>();
  const equ = new Map<string, string>();
  let at = 0;
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    // Strip comments outside of quotes.
    let text = '';
    let q = false;
    for (const ch of raw) {
      if (ch === '"') q = !q;
      if (!q && (ch === ';' || ch === '#')) break;
      text += ch;
    }
    text = text.trim();
    while (true) {
      const m = /^([A-Za-z_][\w.]*):\s*/.exec(text);
      if (!m) break;
      if (labels.has(m[1])) throw new AsmError(line, `duplicate label ${m[1]}`);
      labels.set(m[1], at);
      text = text.slice(m[0].length);
    }
    if (!text) return;
    if (text.startsWith('.equ')) {
      const m = /^\.equ\s+([A-Za-z_]\w*)\s+(.+)$/.exec(text);
      if (!m) throw new AsmError(line, 'expected .equ NAME value');
      equ.set(m[1], m[2].trim());
      return;
    }
    const sp = text.search(/\s/);
    const name = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : text.slice(sp).trim();
    const args = rest ? rest.split(',').map((s) => s.trim()) : [];
    const def = OPS[name];
    if (!def) throw new AsmError(line, `unknown instruction "${name}"`);
    items.push({ line, name, args, at });
    at += lenOf(def.shape);
  });
  if (at > 10_240) throw new Error(`code is ${at} bytes, over MAX_CODE (10,240)`);

  const literal = (tok: string, line: number, depth = 0): Uint8Array => {
    if (depth > 8) throw new AsmError(line, `.equ loop at ${tok}`);
    if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) return word(tok.slice(1, -1));
    if (tok.startsWith('@')) {
      const l = labels.get(tok.slice(1));
      if (l === undefined) throw new AsmError(line, `unknown label ${tok}`);
      return word(BigInt(l));
    }
    if (/^-?(0x[0-9a-f]+|\d+)$/i.test(tok)) {
      const neg = tok.startsWith('-');
      const v = BigInt(neg ? tok.slice(1) : tok);
      return word(neg ? -v : v);
    }
    const e = equ.get(tok);
    if (e !== undefined) return literal(e, line, depth + 1);
    throw new AsmError(line, `bad value "${tok}"`);
  };
  const target = (tok: string, line: number): number => {
    const l = labels.get(tok.replace(/^@/, ''));
    if (l === undefined) throw new AsmError(line, `unknown label ${tok}`);
    return l;
  };

  const out = new Uint8Array(at);
  for (const it of items) {
    const { op, shape } = OPS[it.name];
    const n = (k: number) => {
      if (it.args.length !== k) throw new AsmError(it.line, `${it.name} takes ${k} operand(s)`);
    };
    out[it.at] = op;
    if (shape === 'none') n(0);
    else if (shape === 'const') {
      n(2);
      out[it.at + 1] = reg(it.args[0], it.line);
      out.set(literal(it.args[1], it.line), it.at + 4);
    } else if (shape === 'jump' || shape === 'jumpi') {
      n(shape === 'jump' ? 1 : 2);
      if (shape === 'jumpi') out[it.at + 1] = reg(it.args[0], it.line);
      const t = target(it.args[it.args.length - 1], it.line);
      out[it.at + 2] = t >> 8;
      out[it.at + 3] = t & 0xff;
    } else {
      n(shape.regs);
      it.args.forEach((a, k) => (out[it.at + 1 + k] = reg(a, it.line)));
    }
  }
  return out;
}

export function disassemble(code: Uint8Array): string {
  const lines: [number, string][] = [];
  const targets = new Set<number>();
  let pc = 0;
  while (pc < code.length) {
    const d = BY_OP.get(code[pc]);
    if (!d) throw new Error(`invalid opcode 0x${code[pc].toString(16)} at ${pc}`);
    const len = lenOf(d.shape);
    if (pc + len > code.length) throw new Error(`truncated instruction at ${pc}`);
    const r = (k: number) => `r${code[pc + 1 + k]}`;
    let text = d.name;
    if (d.shape === 'const') {
      const v = code.slice(pc + 4, pc + 36);
      let x = 0n;
      for (const b of v) x = (x << 8n) | BigInt(b);
      text += ` ${r(0)}, ${x < 1n << 64n ? x.toString() : '0x' + x.toString(16)}`;
    } else if (d.shape === 'jump' || d.shape === 'jumpi') {
      const t = (code[pc + 2] << 8) | code[pc + 3];
      targets.add(t);
      text += d.shape === 'jumpi' ? ` ${r(0)}, L${t}` : ` L${t}`;
    } else if (typeof d.shape === 'object') {
      text += ' ' + Array.from({ length: d.shape.regs }, (_, k) => r(k)).join(', ');
    }
    lines.push([pc, text]);
    pc += len;
  }
  return lines.map(([at, t]) => (targets.has(at) ? `L${at}:\n` : '') + `  ${t}`).join('\n') + '\n';
}

if (import.meta.main) {
  const [cmd, file, out] = process.argv.slice(2);
  const { readFileSync, writeFileSync } = await import('node:fs');
  if (cmd === 'build' && file) {
    const code = assemble(readFileSync(file, 'utf8'));
    if (out) writeFileSync(out, code);
    else console.log(Buffer.from(code).toString('hex'));
    console.error(`${code.length} bytes`);
  } else if (cmd === 'dis' && file) {
    const code = /^[0-9a-f]+$/i.test(file) ? Buffer.from(file, 'hex') : readFileSync(file);
    process.stdout.write(disassemble(new Uint8Array(code)));
  } else if (cmd) {
    console.error('usage: node tools/asm.ts build <file.asm> [out.bin] | dis <file.bin|hex>');
    process.exit(1);
  }
}
