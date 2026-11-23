//! The ledger (§7) on top of the state table: balances, nonces, guest storage and guest markers,
//! plus the read-only environment a transaction brings (code accounts, other listed accounts).

use std::cell::{Cell, Ref};

use anchor_lang::prelude::*;

use crate::state::*;
use crate::table::{Table, TableError};
use crate::vm::{keccak, Env, Host, Log, VmError, Word};

pub const KIND_BALANCE: u8 = 0;
pub const KIND_NONCE: u8 = 1;
pub const KIND_STORAGE: u8 = 2;
/// Set to 1 when a guest's code is sealed at that address.
pub const KIND_GUEST: u8 = 3;

const ZERO: Word = [0; 32];

/// `keccak256(kind ‖ address ‖ slot)` (§6).
pub fn key(kind: u8, addr: &Word, slot: &Word) -> Word {
    keccak(&[&[kind], addr, slot])
}

fn word_u64(v: u64) -> Word {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

fn u64_word(w: &Word) -> u64 {
    u64::from_be_bytes(w[24..].try_into().unwrap())
}

fn no_space(e: TableError) -> VmError {
    match e {
        TableError::NoSpace => VmError::NoSpace,
        // open() already checked the magic; nothing else returns Corrupt.
        TableError::Corrupt => VmError::NoSpace,
    }
}

pub struct Ledger<'a> {
    pub t: Table<'a>,
    pub logs: Vec<Log>,
    /// Table lookups and writes so far, for the fee meter (§11).
    pub reads: Cell<u64>,
    pub writes: u64,
}

impl<'a> Ledger<'a> {
    pub fn new(t: Table<'a>) -> Self {
        Ledger { t, logs: Vec::new(), reads: Cell::new(0), writes: 0 }
    }

    fn get(&self, k: &Word) -> Word {
        self.reads.set(self.reads.get() + 1);
        self.t.get(k)
    }

    fn put(&mut self, k: &Word, v: &Word) -> std::result::Result<(), VmError> {
        self.writes += 1;
        self.t.set(k, v).map_err(no_space)
    }

    pub fn set_balance(&mut self, addr: &Word, v: u64) -> std::result::Result<(), VmError> {
        self.put(&key(KIND_BALANCE, addr, &ZERO), &word_u64(v))
    }

    pub fn credit(&mut self, addr: &Word, v: u64) -> std::result::Result<(), VmError> {
        let b = self.balance(addr).checked_add(v).ok_or(VmError::InsufficientBalance)?;
        self.set_balance(addr, b)
    }

    pub fn debit(&mut self, addr: &Word, v: u64) -> std::result::Result<(), VmError> {
        let b = self.balance(addr).checked_sub(v).ok_or(VmError::InsufficientBalance)?;
        self.set_balance(addr, b)
    }

    /// Uses the next nonce of `addr` and returns the one used.
    pub fn use_nonce(&mut self, addr: &Word) -> std::result::Result<u64, VmError> {
        let k = key(KIND_NONCE, addr, &ZERO);
        let n = u64_word(&self.get(&k));
        self.put(&k, &word_u64(n + 1))?;
        Ok(n)
    }

    pub fn mark_guest(&mut self, addr: &Word) -> std::result::Result<(), VmError> {
        self.put(&key(KIND_GUEST, addr, &ZERO), &word_u64(1))
    }
}

impl Host for Ledger<'_> {
    fn balance(&self, addr: &Word) -> u64 {
        u64_word(&self.get(&key(KIND_BALANCE, addr, &ZERO)))
    }

    fn transfer(&mut self, from: &Word, to: &Word, lamports: u64) -> std::result::Result<(), VmError> {
        if lamports == 0 {
            return Ok(());
        }
        self.debit(from, lamports)?;
        self.credit(to, lamports)
    }

    fn sload(&self, addr: &Word, slot: &Word) -> Word {
        self.get(&key(KIND_STORAGE, addr, slot))
    }

    fn sstore(&mut self, addr: &Word, slot: &Word, value: &Word) -> std::result::Result<(), VmError> {
        self.put(&key(KIND_STORAGE, addr, slot), value)
    }

    fn is_guest(&self, addr: &Word) -> bool {
        self.get(&key(KIND_GUEST, addr, &ZERO)) != ZERO
    }

    fn log(&mut self, log: Log) -> std::result::Result<(), VmError> {
        self.logs.push(log);
        Ok(())
    }
}

struct Listed<'b> {
    key: Word,
    /// For a sealed code account of this chain: the guest address and code length.
    code: Option<(Word, usize)>,
    data: Ref<'b, &'b mut [u8]>,
}

/// Accounts listed after the instruction's own accounts: code accounts and anything ACCOUNTLOAD
/// reads. Accounts that are already borrowed (the chain's own state) are skipped.
pub struct TxEnv<'b> {
    items: Vec<Listed<'b>>,
}

impl<'b> TxEnv<'b> {
    pub fn new<'info>(accounts: &'b [AccountInfo<'info>], chain: u32) -> Self {
        let mut items = Vec::with_capacity(accounts.len());
        for a in accounts {
            let Ok(data) = a.try_borrow_data() else { continue };
            let code = if a.owner == &crate::ID
                && data.len() >= CODE_HDR
                && data[..8] == *CodeAccount::DISCRIMINATOR
                && data[CODE_OFF_CHAIN..CODE_OFF_CHAIN + 4] == chain.to_le_bytes()
                && data[CODE_OFF_SEALED] == 1
            {
                let addr: Word = data[CODE_OFF_ADDRESS..CODE_OFF_ADDRESS + 32].try_into().unwrap();
                let len = u32::from_le_bytes(data[CODE_OFF_LEN..CODE_OFF_LEN + 4].try_into().unwrap()) as usize;
                Some((addr, len))
            } else {
                None
            };
            items.push(Listed { key: a.key.to_bytes(), code, data });
        }
        TxEnv { items }
    }
}

impl Env for TxEnv<'_> {
    fn code(&self, addr: &Word) -> Option<&[u8]> {
        self.items.iter().find_map(|i| match i.code {
            Some((a, len)) if &a == addr => i.data.get(CODE_HDR..CODE_HDR + len),
            _ => None,
        })
    }

    fn account(&self, key: &Word) -> Option<&[u8]> {
        self.items.iter().find(|i| &i.key == key).map(|i| &i.data[..])
    }
}
