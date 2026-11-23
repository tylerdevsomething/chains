//! MiniVM (§9, §10): the decoder, the validator `deploy_seal` runs, and the interpreter.
//!
//! The interpreter knows nothing about Solana. State goes through `Host` (balances, storage,
//! logs: the chain's table) and read-only lookups through `Env` (guest code and listed Solana
//! accounts). Any error fails the whole Solana transaction, so the interpreter writes straight
//! into the host and never has to undo anything.

use crate::u256::U256;

pub const MAX_STEPS: u64 = 10_000;
pub const MAX_DEPTH: u32 = 8;
pub const MAX_CALLDATA: usize = 800;
pub const MAX_CODE: usize = 10_240;
/// Logs one top-level call may emit. Each becomes a program event.
pub const MAX_LOGS: usize = 32;

pub type Word = [u8; 32];

pub mod op {
    pub const STOP: u8 = 0x00;
    pub const CONST: u8 = 0x01;
    pub const MOV: u8 = 0x02;
    pub const ADD: u8 = 0x03;
    pub const SUB: u8 = 0x04;
    pub const MUL: u8 = 0x05;
    pub const DIV: u8 = 0x06;
    pub const EQ: u8 = 0x07;
    pub const LT: u8 = 0x08;
    pub const AND: u8 = 0x09;
    pub const OR: u8 = 0x0a;
    pub const XOR: u8 = 0x0b;
    pub const NOT: u8 = 0x0c;
    pub const SHL: u8 = 0x0d;
    pub const SHR: u8 = 0x0e;
    pub const CALLER: u8 = 0x10;
    pub const ADDRESS: u8 = 0x11;
    pub const CALLVALUE: u8 = 0x12;
    pub const CALLDATALOAD: u8 = 0x13;
    pub const CALLDATASIZE: u8 = 0x14;
    pub const BALANCE: u8 = 0x15;
    pub const SLOAD: u8 = 0x16;
    pub const SSTORE: u8 = 0x17;
    pub const TRANSFER: u8 = 0x18;
    pub const REQUIRE: u8 = 0x19;
    pub const RETURN: u8 = 0x1a;
    pub const REVERT: u8 = 0x1b;
    pub const JUMP: u8 = 0x20;
    pub const JUMPI: u8 = 0x21;
    pub const CALL: u8 = 0x22;
    pub const HASH: u8 = 0x23;
    pub const LOG3: u8 = 0x24;
    pub const LOG4: u8 = 0x25;
    pub const ACCOUNTLOAD: u8 = 0x30;
}

/// How many register operands (A, B, C, D) an opcode uses; the rest must be zero bytes.
/// JUMP/JUMPI use B‖C as a target instead. None = not an opcode.
fn shape(o: u8) -> Option<(u8, usize)> {
    use op::*;
    // (registers used among A,B,C,D; total length)
    Some(match o {
        STOP => (0, 4),
        CONST => (1, 36),
        MOV | NOT | CALLDATALOAD | BALANCE | SLOAD | SSTORE | TRANSFER => (2, 4),
        ADD | SUB | MUL | DIV | EQ | LT | AND | OR | XOR | SHL | SHR | HASH => (3, 4),
        CALLER | ADDRESS | CALLVALUE | CALLDATASIZE | REQUIRE | RETURN | REVERT => (1, 4),
        JUMP => (0, 4),
        JUMPI => (1, 4),
        CALL | LOG3 | LOG4 => (4, 8),
        ACCOUNTLOAD => (3, 8),
        _ => return None,
    })
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CodeError {
    /// Truncated instruction, bad register, non-zero reserved byte or bad jump target at pc.
    InvalidCode(u32),
    /// Unknown opcode at pc.
    InvalidOpcode(u32, u8),
    TooLong,
}

/// The checks `deploy_seal` runs (§9).
pub fn validate(code: &[u8]) -> Result<(), CodeError> {
    if code.len() > MAX_CODE {
        return Err(CodeError::TooLong);
    }
    let mut starts = vec![false; code.len()];
    let mut jumps: Vec<(u32, usize)> = Vec::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let o = code[pc];
        let (regs, len) = shape(o).ok_or(CodeError::InvalidOpcode(pc as u32, o))?;
        let bad = CodeError::InvalidCode(pc as u32);
        if pc + len > code.len() {
            return Err(bad);
        }
        starts[pc] = true;
        let ins = &code[pc..pc + len];
        if o == op::JUMP || o == op::JUMPI {
            if (o == op::JUMP && ins[1] != 0) || (o == op::JUMPI && ins[1] >= 16) {
                return Err(bad);
            }
            jumps.push((pc as u32, u16::from_be_bytes([ins[2], ins[3]]) as usize));
        } else {
            // Operand bytes: A,B,C at 1..4, and D at 4 for 8-byte forms. Used ones are registers
            // (< 16), unused ones must be zero.
            let operands: &[u8] = if len == 8 { &[ins[1], ins[2], ins[3], ins[4]] } else { &ins[1..4] };
            for (k, &r) in operands.iter().enumerate() {
                if (k as u8) < regs {
                    if r >= 16 {
                        return Err(bad);
                    }
                } else if r != 0 {
                    return Err(bad);
                }
            }
            if len == 8 && ins[5..8] != [0, 0, 0] {
                return Err(bad);
            }
        }
        pc += len;
    }
    for (at, target) in jumps {
        if target >= code.len() || !starts[target] {
            return Err(CodeError::InvalidCode(at));
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VmError {
    InvalidStepBudget,
    StepLimit,
    DepthLimit,
    StaticViolation,
    InsufficientBalance,
    MissingCode(Word),
    MissingAccount(Word),
    RequireFailed(u32),
    Reverted(Word),
    InvalidCode(u32),
    TooManyLogs,
    NoSpace,
}

pub struct Log {
    pub address: Word,
    pub topics: Vec<Word>,
    pub data: Option<Word>,
}

/// The chain's mutable state, as the VM sees it.
pub trait Host {
    fn balance(&self, addr: &Word) -> u64;
    fn transfer(&mut self, from: &Word, to: &Word, lamports: u64) -> Result<(), VmError>;
    fn sload(&self, addr: &Word, slot: &Word) -> Word;
    fn sstore(&mut self, addr: &Word, slot: &Word, value: &Word) -> Result<(), VmError>;
    fn is_guest(&self, addr: &Word) -> bool;
    fn log(&mut self, log: Log) -> Result<(), VmError>;
}

/// Read-only things the transaction brought along.
pub trait Env {
    fn code(&self, addr: &Word) -> Option<&[u8]>;
    /// Solana account data, if the account is listed in the transaction.
    fn account(&self, key: &Word) -> Option<&[u8]>;
}

pub struct Vm<'h, H: Host, E: Env> {
    pub host: &'h mut H,
    pub env: &'h E,
    pub steps_left: u64,
    pub is_static: bool,
    pub logs: usize,
}

pub fn keccak(parts: &[&[u8]]) -> Word {
    anchor_lang::solana_program::keccak::hashv(parts).to_bytes()
}

impl<'h, H: Host, E: Env> Vm<'h, H, E> {
    pub fn new(host: &'h mut H, env: &'h E, max_steps: u64, is_static: bool) -> Result<Self, VmError> {
        if max_steps == 0 || max_steps > MAX_STEPS {
            return Err(VmError::InvalidStepBudget);
        }
        Ok(Vm { host, env, steps_left: max_steps, is_static, logs: 0 })
    }

    /// Sends `value` from `caller` to `target`, then runs `target`'s code if it is a guest.
    /// Returns the guest's result word, if it returned one.
    pub fn call(&mut self, caller: &Word, target: &Word, value: u64, data: &[u8], depth: u32) -> Result<Option<Word>, VmError> {
        if depth > MAX_DEPTH {
            return Err(VmError::DepthLimit);
        }
        if value > 0 {
            if self.is_static {
                return Err(VmError::StaticViolation);
            }
            self.host.transfer(caller, target, value)?;
        }
        if !self.host.is_guest(target) {
            return Ok(None);
        }
        let env: &'h E = self.env;
        let code = env.code(target).ok_or(VmError::MissingCode(*target))?;
        self.run(code, caller, target, value, data, depth)
    }

    fn run(&mut self, code: &[u8], caller: &Word, me: &Word, value: u64, data: &[u8], depth: u32) -> Result<Option<Word>, VmError> {
        let mut r = Box::new([U256::ZERO; 16]);
        let mut pc = 0usize;
        while pc < code.len() {
            if self.steps_left == 0 {
                return Err(VmError::StepLimit);
            }
            self.steps_left -= 1;
            let o = code[pc];
            let (_, len) = shape(o).ok_or(VmError::InvalidCode(pc as u32))?;
            if pc + len > code.len() {
                return Err(VmError::InvalidCode(pc as u32));
            }
            let (a, b, c) = (code[pc + 1] as usize & 15, code[pc + 2] as usize & 15, code[pc + 3] as usize & 15);
            let d = if len == 8 { code[pc + 4] as usize & 15 } else { 0 };
            let mut next = pc + len;
            use op::*;
            match o {
                STOP => return Ok(None),
                CONST => r[a] = U256::from_be(code[pc + 4..pc + 36].try_into().unwrap()),
                MOV => r[a] = r[b],
                ADD => r[a] = r[b].add(&r[c]),
                SUB => r[a] = r[b].sub(&r[c]),
                MUL => r[a] = r[b].mul(&r[c]),
                DIV => r[a] = r[b].div(&r[c]),
                EQ => r[a] = U256::from_u64((r[b] == r[c]) as u64),
                LT => r[a] = U256::from_u64(r[b].lt(&r[c]) as u64),
                AND => r[a] = r[b].and(&r[c]),
                OR => r[a] = r[b].or(&r[c]),
                XOR => r[a] = r[b].xor(&r[c]),
                NOT => r[a] = r[b].not(),
                SHL => r[a] = r[b].shl(&r[c]),
                SHR => r[a] = r[b].shr(&r[c]),
                CALLER => r[a] = U256::from_be(caller),
                ADDRESS => r[a] = U256::from_be(me),
                CALLVALUE => r[a] = U256::from_u64(value),
                CALLDATALOAD => r[a] = U256::from_be(&word_at(data, &r[b])),
                CALLDATASIZE => r[a] = U256::from_u64(data.len() as u64),
                BALANCE => r[a] = U256::from_u64(self.host.balance(&r[b].to_be())),
                SLOAD => r[a] = U256::from_be(&self.host.sload(me, &r[b].to_be())),
                SSTORE => {
                    if self.is_static {
                        return Err(VmError::StaticViolation);
                    }
                    self.host.sstore(me, &r[a].to_be(), &r[b].to_be())?;
                }
                TRANSFER => {
                    if self.is_static {
                        return Err(VmError::StaticViolation);
                    }
                    let amount = r[b].as_u64().ok_or(VmError::InsufficientBalance)?;
                    if amount > 0 {
                        self.host.transfer(me, &r[a].to_be(), amount)?;
                    }
                }
                REQUIRE => {
                    if r[a].is_zero() {
                        return Err(VmError::RequireFailed(pc as u32));
                    }
                }
                RETURN => return Ok(Some(r[a].to_be())),
                REVERT => return Err(VmError::Reverted(r[a].to_be())),
                JUMP => next = u16::from_be_bytes([code[pc + 2], code[pc + 3]]) as usize,
                JUMPI => {
                    if !r[a].is_zero() {
                        next = u16::from_be_bytes([code[pc + 2], code[pc + 3]]) as usize;
                    }
                }
                CALL => {
                    let value = r[c].as_u64().ok_or(VmError::InsufficientBalance)?;
                    let input = r[d].to_be();
                    let target = r[b].to_be();
                    let out = self.call(me, &target, value, &input, depth + 1)?;
                    r[a] = out.map(|w| U256::from_be(&w)).unwrap_or(U256::ZERO);
                }
                HASH => r[a] = U256::from_be(&keccak(&[&r[b].to_be(), &r[c].to_be()])),
                LOG3 | LOG4 => {
                    if self.is_static {
                        return Err(VmError::StaticViolation);
                    }
                    self.logs += 1;
                    if self.logs > MAX_LOGS {
                        return Err(VmError::TooManyLogs);
                    }
                    let (topics, data) = if o == LOG3 {
                        (vec![r[a].to_be(), r[b].to_be(), r[c].to_be()], Some(r[d].to_be()))
                    } else {
                        (vec![r[a].to_be(), r[b].to_be(), r[c].to_be(), r[d].to_be()], None)
                    };
                    self.host.log(Log { address: *me, topics, data })?;
                }
                ACCOUNTLOAD => {
                    let key = r[b].to_be();
                    let acc = self.env.account(&key).ok_or(VmError::MissingAccount(key))?;
                    r[a] = U256::from_be(&word_at(acc, &r[c]));
                }
                _ => return Err(VmError::InvalidCode(pc as u32)),
            }
            pc = next;
        }
        Ok(None)
    }
}

/// 32 bytes of `data` at `offset`, zero padded past the end.
fn word_at(data: &[u8], offset: &U256) -> Word {
    let mut w = [0u8; 32];
    if let Some(off) = offset.as_u64() {
        let off = off as usize;
        if off < data.len() {
            let n = (data.len() - off).min(32);
            w[..n].copy_from_slice(&data[off..off + n]);
        }
    }
    w
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct MemHost {
        pub bal: HashMap<Word, u64>,
        pub store: HashMap<(Word, Word), Word>,
        pub guests: Vec<Word>,
        pub logs: Vec<Log>,
    }
    impl Host for MemHost {
        fn balance(&self, a: &Word) -> u64 {
            *self.bal.get(a).unwrap_or(&0)
        }
        fn transfer(&mut self, f: &Word, t: &Word, l: u64) -> Result<(), VmError> {
            let fb = self.balance(f);
            if fb < l {
                return Err(VmError::InsufficientBalance);
            }
            self.bal.insert(*f, fb - l);
            *self.bal.entry(*t).or_insert(0) += l;
            Ok(())
        }
        fn sload(&self, a: &Word, s: &Word) -> Word {
            *self.store.get(&(*a, *s)).unwrap_or(&[0; 32])
        }
        fn sstore(&mut self, a: &Word, s: &Word, v: &Word) -> Result<(), VmError> {
            self.store.insert((*a, *s), *v);
            Ok(())
        }
        fn is_guest(&self, a: &Word) -> bool {
            self.guests.contains(a)
        }
        fn log(&mut self, l: Log) -> Result<(), VmError> {
            self.logs.push(l);
            Ok(())
        }
    }
    #[derive(Default)]
    pub struct MemEnv {
        pub code: HashMap<Word, Vec<u8>>,
        pub accounts: HashMap<Word, Vec<u8>>,
    }
    impl Env for MemEnv {
        fn code(&self, a: &Word) -> Option<&[u8]> {
            self.code.get(a).map(|v| v.as_slice())
        }
        fn account(&self, k: &Word) -> Option<&[u8]> {
            self.accounts.get(k).map(|v| v.as_slice())
        }
    }

    // A tiny assembler for tests.
    fn i(o: u8, a: u8, b: u8, c: u8) -> Vec<u8> {
        vec![o, a, b, c]
    }
    fn i8(o: u8, a: u8, b: u8, c: u8, d: u8) -> Vec<u8> {
        vec![o, a, b, c, d, 0, 0, 0]
    }
    fn konst(a: u8, v: u64) -> Vec<u8> {
        let mut x = vec![op::CONST, a, 0, 0];
        x.extend_from_slice(&U256::from_u64(v).to_be());
        x
    }
    fn jmp(o: u8, a: u8, to: u16) -> Vec<u8> {
        let t = to.to_be_bytes();
        vec![o, a, t[0], t[1]]
    }
    fn prog(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }
    fn w(n: u8) -> Word {
        [n; 32]
    }

    fn run(code: Vec<u8>, data: &[u8], steps: u64) -> (Result<Option<Word>, VmError>, MemHost) {
        validate(&code).expect("valid");
        let mut host = MemHost { guests: vec![w(9)], ..Default::default() };
        host.bal.insert(w(1), 1000);
        let mut env = MemEnv::default();
        env.code.insert(w(9), code);
        let res = {
            let mut vm = Vm::new(&mut host, &env, steps, false).unwrap();
            vm.call(&w(1), &w(9), 0, data, 0)
        };
        (res, host)
    }
    fn word(v: u64) -> Option<Word> {
        Some(U256::from_u64(v).to_be())
    }

    #[test]
    fn arithmetic_and_return() {
        let code = prog(&[konst(1, 6), konst(2, 7), i(op::MUL, 3, 1, 2), i(op::RETURN, 3, 0, 0)]);
        assert_eq!(run(code, &[], 100).0, Ok(word(42)));
        let code = prog(&[konst(1, 5), i(op::DIV, 2, 1, 0), i(op::RETURN, 2, 0, 0)]);
        assert_eq!(run(code, &[], 100).0, Ok(word(0)), "div by zero is 0");
    }

    #[test]
    fn loop_and_step_limit() {
        // r1 = 10; loop: r2 += r1; r1 -= 1; jumpi r1 loop; return r2  → 55
        let code = prog(&[
            konst(1, 10),
            konst(3, 1),
            jmp(op::JUMP, 0, 76), // lands on the next instruction (two CONSTs + this JUMP = 76)
            i(op::ADD, 2, 2, 1),
            i(op::SUB, 1, 1, 3),
            jmp(op::JUMPI, 1, 76),
            i(op::RETURN, 2, 0, 0),
        ]);
        let (res, _) = run(code.clone(), &[], 100);
        assert_eq!(res, Ok(word(55)));
        assert_eq!(run(code, &[], 20).0, Err(VmError::StepLimit));
    }

    #[test]
    fn calldata_storage_and_caller() {
        // storage[calldata[0]] = caller; return sload(calldata[0])
        let code = prog(&[
            i(op::CALLDATALOAD, 1, 0, 0),
            i(op::CALLER, 2, 0, 0),
            i(op::SSTORE, 1, 2, 0),
            i(op::SLOAD, 3, 1, 0),
            i(op::RETURN, 3, 0, 0),
        ]);
        let mut data = [0u8; 40];
        data[31] = 5;
        let (res, host) = run(code, &data, 100);
        assert_eq!(res, Ok(Some(w(1))));
        assert_eq!(host.store.len(), 1);
    }

    #[test]
    fn calldata_padding() {
        let mut off = vec![op::CONST, 1, 0, 0];
        off.extend_from_slice(&U256::from_u64(30).to_be());
        let code = prog(&[off, i(op::CALLDATALOAD, 2, 1, 0), i(op::RETURN, 2, 0, 0)]);
        let data = [0xffu8; 32];
        let mut expect = [0u8; 32];
        expect[0] = 0xff;
        expect[1] = 0xff;
        assert_eq!(run(code, &data, 100).0, Ok(Some(expect)));
    }

    #[test]
    fn require_revert_and_transfer() {
        let code = prog(&[i(op::REQUIRE, 1, 0, 0)]);
        assert_eq!(run(code, &[], 10).0, Err(VmError::RequireFailed(0)));
        let code = prog(&[konst(1, 77), i(op::REVERT, 1, 0, 0)]);
        assert_eq!(run(code, &[], 10).0, Err(VmError::Reverted(U256::from_u64(77).to_be())));
        // Guest w(9) sends 5 lamports it doesn't have.
        let code = prog(&[i(op::CALLER, 1, 0, 0), konst(2, 5), i(op::TRANSFER, 1, 2, 0)]);
        assert_eq!(run(code, &[], 10).0, Err(VmError::InsufficientBalance));
    }

    #[test]
    fn nested_calls_value_and_depth() {
        // Guest A (w9) calls guest B (w8) with 3 lamports and input 21; B returns input*2.
        let b = prog(&[konst(1, 0), i(op::CALLDATALOAD, 2, 1, 0), konst(3, 2), i(op::MUL, 2, 2, 3), i(op::RETURN, 2, 0, 0)]);
        let mut target = vec![op::CONST, 1, 0, 0];
        target.extend_from_slice(&w(8));
        let a = prog(&[target, konst(2, 3), konst(3, 21), i8(op::CALL, 4, 1, 2, 3), i(op::RETURN, 4, 0, 0)]);
        validate(&a).unwrap();
        validate(&b).unwrap();
        let mut host = MemHost { guests: vec![w(9), w(8)], ..Default::default() };
        host.bal.insert(w(1), 1000);
        let mut env = MemEnv::default();
        env.code.insert(w(9), a);
        env.code.insert(w(8), b);
        let res = Vm::new(&mut host, &env, 100, false).unwrap().call(&w(1), &w(9), 10, &[], 0);
        assert_eq!(res, Ok(word(42)));
        assert_eq!(host.balance(&w(8)), 3);
        assert_eq!(host.balance(&w(9)), 7);

        // A guest that calls itself recurses until DepthLimit.
        let mut me = vec![op::ADDRESS, 1, 0, 0];
        me.extend(i8(op::CALL, 2, 1, 0, 0));
        let mut host = MemHost { guests: vec![w(9)], ..Default::default() };
        let mut env = MemEnv::default();
        env.code.insert(w(9), me);
        let res = Vm::new(&mut host, &env, 1000, false).unwrap().call(&w(1), &w(9), 0, &[], 0);
        assert_eq!(res, Err(VmError::DepthLimit));

        // Code account not listed.
        let mut host = MemHost { guests: vec![w(9)], ..Default::default() };
        let env = MemEnv::default();
        let res = Vm::new(&mut host, &env, 100, false).unwrap().call(&w(1), &w(9), 0, &[], 0);
        assert_eq!(res, Err(VmError::MissingCode(w(9))));
    }

    #[test]
    fn static_frames() {
        let code = prog(&[konst(1, 1), i(op::SSTORE, 1, 1, 0)]);
        validate(&code).unwrap();
        let mut host = MemHost { guests: vec![w(9)], ..Default::default() };
        let mut env = MemEnv::default();
        env.code.insert(w(9), code);
        let res = Vm::new(&mut host, &env, 100, true).unwrap().call(&w(1), &w(9), 0, &[], 0);
        assert_eq!(res, Err(VmError::StaticViolation));
        let res = Vm::new(&mut host, &env, 100, true).unwrap().call(&w(1), &w(9), 1, &[], 0);
        assert_eq!(res, Err(VmError::StaticViolation));
        assert!(Vm::new(&mut host, &env, 0, true).is_err());
        assert!(Vm::new(&mut host, &env, MAX_STEPS + 1, true).is_err());
    }

    #[test]
    fn logs_hash_and_accountload() {
        let mut key = vec![op::CONST, 1, 0, 0];
        key.extend_from_slice(&w(4));
        let code = prog(&[
            key,
            konst(2, 2),
            i8(op::ACCOUNTLOAD, 3, 1, 2, 0),
            i(op::HASH, 4, 3, 3),
            i8(op::LOG3, 1, 2, 3, 4),
            i(op::RETURN, 3, 0, 0),
        ]);
        validate(&code).unwrap();
        let mut host = MemHost { guests: vec![w(9)], ..Default::default() };
        let mut env = MemEnv::default();
        env.code.insert(w(9), code.clone());
        env.accounts.insert(w(4), vec![0, 0, 7, 8]);
        let res = Vm::new(&mut host, &env, 100, false).unwrap().call(&w(1), &w(9), 0, &[], 0);
        let mut expect = [0u8; 32];
        expect[0] = 7;
        expect[1] = 8;
        assert_eq!(res, Ok(Some(expect)));
        assert_eq!(host.logs.len(), 1);
        assert_eq!(host.logs[0].data, Some(keccak(&[&expect, &expect])));
        let env2 = MemEnv { code: env.code.clone(), accounts: HashMap::new() };
        let res = Vm::new(&mut host, &env2, 100, false).unwrap().call(&w(1), &w(9), 0, &[], 0);
        assert_eq!(res, Err(VmError::MissingAccount(w(4))));
    }

    #[test]
    fn validator_rejects() {
        assert_eq!(validate(&[0xff, 0, 0, 0]), Err(CodeError::InvalidOpcode(0, 0xff)));
        assert_eq!(validate(&[op::ADD, 16, 0, 0]), Err(CodeError::InvalidCode(0)));
        assert_eq!(validate(&[op::STOP, 1, 0, 0]), Err(CodeError::InvalidCode(0)), "reserved byte");
        assert_eq!(validate(&[op::CALLER, 1, 1, 0]), Err(CodeError::InvalidCode(0)), "unused operand");
        assert_eq!(validate(&[op::CONST, 1, 0, 0, 1]), Err(CodeError::InvalidCode(0)), "truncated");
        assert_eq!(validate(&[op::STOP, 0, 0, 0, op::JUMP, 0, 0, 2]), Err(CodeError::InvalidCode(4)), "mid-instruction");
        assert_eq!(validate(&[op::JUMP, 0, 0, 8]), Err(CodeError::InvalidCode(0)), "past the end");
        assert_eq!(validate(&[op::JUMP, 1, 0, 0]), Err(CodeError::InvalidCode(0)), "A must be 0");
        assert_eq!(validate(&[op::CALL, 1, 2, 3, 4, 0, 0, 1]), Err(CodeError::InvalidCode(0)));
        assert_eq!(validate(&[op::ACCOUNTLOAD, 1, 2, 3, 4, 0, 0, 0]), Err(CodeError::InvalidCode(0)), "D must be 0");
        assert_eq!(validate(&[op::JUMP, 0, 0, 0]), Ok(()));
        assert_eq!(validate(&vec![0u8; MAX_CODE + 4]), Err(CodeError::TooLong));
    }
}
