//! Chains: a whole chain inside one Solana program. See SPEC.md, the single source of truth.

pub mod errors;
pub mod history;
pub mod ledger;
pub mod merkle;
pub mod state;
pub mod table;
pub mod u256;
pub mod vm;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_lang::system_program;

use errors::*;
use ledger::{Ledger, TxEnv};
use state::*;
use table::Table;
use vm::{Host, Vm, Word};

declare_id!("9mmzy5stpZfxmtQTWFC1fDDhWn8FwYMTwWTAkv5tLb3N");

/// Metered compute units for a transaction (§11): a fixed schedule calibrated to real compute,
/// because the compute-units syscall is not active on devnet or mainnet.
pub fn tx_units(steps: u64, reads: u64, writes: u64, logs: u64, calldata: u64) -> u64 {
    steps * CU_PER_STEP + reads * CU_PER_READ + writes * CU_PER_WRITE + logs * CU_PER_LOG + calldata * CU_PER_CALLDATA_BYTE
}

/// Metered compute units for sealing `code_len` bytes of code (§11).
pub fn seal_units(code_len: u64, reads: u64, writes: u64) -> u64 {
    code_len * CU_PER_CODE_BYTE + reads * CU_PER_READ + writes * CU_PER_WRITE
}

/// On localnet only: real compute used so far, for calibrating the meter.
#[cfg(feature = "localnet")]
fn cu_left() -> u64 {
    anchor_lang::solana_program::compute_units::sol_remaining_compute_units()
}
#[cfg(not(feature = "localnet"))]
fn cu_left() -> u64 {
    0
}

/// The chain fee for `cu_used` metered compute units (§11).
pub fn chain_fee(cu_used: u64, lamports_per_mcu: u64) -> u64 {
    (((cu_used + FEE_OVERHEAD_CU) as u128 * lamports_per_mcu as u128) / 1_000_000) as u64
}

/// The guest address for a deploy (§8).
pub fn guest_address(chain: u32, creator: &Pubkey, nonce: u64, salt: &[u8; 32]) -> Word {
    vm::keccak(&[b"chains:guest", &chain.to_be_bytes(), creator.as_ref(), &nonce.to_be_bytes(), salt])
}

fn running(h: &ChainHeader, now: i64) -> Result<()> {
    require!(h.status == STATUS_RUNNING && !h.ended(now), ChainsError::ChainEnded);
    Ok(())
}

/// Owner of a live Metaplex Core asset (AssetV1: key byte 1, then the owner), or None if the
/// account isn't one (never created, or burned).
fn live_asset_owner(asset: &AccountInfo) -> Option<Pubkey> {
    if *asset.owner != mpl_core::ID {
        return None;
    }
    let d = asset.try_borrow_data().ok()?;
    (d.len() >= 33 && d[0] == 1).then(|| Pubkey::try_from(&d[1..33]).unwrap())
}

fn asset_owner(asset: &AccountInfo) -> Result<Pubkey> {
    live_asset_owner(asset).ok_or_else(|| ChainsError::BadAsset.into())
}

/// Who gets the holder's share of a payout (§12, §13): the asset's owner, or the treasury if the
/// chain's NFT was burned, so funds can never get stuck.
fn payee(asset: &AccountInfo, treasury: &Pubkey) -> Pubkey {
    live_asset_owner(asset).unwrap_or(*treasury)
}

/// Creates a program-owned PDA even if someone already sent it lamports (which would make
/// create_account fail and block it forever).
fn create_pda<'info>(payer: &AccountInfo<'info>, target: &AccountInfo<'info>, system: &AccountInfo<'info>, seeds: &[&[u8]], space: usize) -> Result<()> {
    let need = Rent::get()?.minimum_balance(space);
    let have = target.lamports();
    if have == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(system.clone(), system_program::CreateAccount { from: payer.clone(), to: target.clone() }, &[seeds]),
            need,
            space as u64,
            &crate::ID,
        );
    }
    if have < need {
        system_program::transfer(CpiContext::new(system.clone(), system_program::Transfer { from: payer.clone(), to: target.clone() }), need - have)?;
    }
    system_program::allocate(CpiContext::new_with_signer(system.clone(), system_program::Allocate { account_to_allocate: target.clone() }, &[seeds]), space as u64)?;
    system_program::assign(CpiContext::new_with_signer(system.clone(), system_program::Assign { account_to_assign: target.clone() }, &[seeds]), &crate::ID)
}

/// The header must always hold its rent plus every internal lamport (§1).
fn check_backed(header: &AccountInfo, total_deposits: u64) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(header.data_len());
    require!(header.lamports() >= rent + total_deposits, ChainsError::InsufficientBalance);
    Ok(())
}

/// Rent for one table entry (§6): a page holds 4 entries in 272 bytes.
fn entry_rent() -> Result<u64> {
    let r = Rent::get()?;
    Ok(r.minimum_balance(ENTRY_BYTES) - r.minimum_balance(0))
}

/// Rent for the entries an operation added (net), from the table's entry count before and after.
fn new_entries_rent(before: u64, after: u64) -> Result<u64> {
    Ok(after.saturating_sub(before) * entry_rent()?)
}

/// Pays storage rent in real SOL from a signer into the state account.
fn pay_rent<'info>(payer: &AccountInfo<'info>, state: &AccountInfo<'info>, system: &AccountInfo<'info>, rent: u64) -> Result<()> {
    if rent > 0 {
        system_program::transfer(CpiContext::new(system.clone(), system_program::Transfer { from: payer.clone(), to: state.clone() }), rent)?;
    }
    Ok(())
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(amount).ok_or(ChainsError::InsufficientBalance)?;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

fn valid_name(name: &str) -> bool {
    name.len() <= NAME_MAX
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b' ')
        && !name.starts_with(' ')
        && !name.ends_with(' ')
}

/// Commits an operation and emits BlockCommitted.
macro_rules! commit {
    ($ctx:ident, $op:expr) => {{
        let op: Word = $op;
        let chain = $ctx.accounts.header.id;
        let (height, prev, head) = history::commit(&mut $ctx.accounts.header, &op);
        let ctx = &$ctx;
        emit_cpi!(BlockCommitted { chain, height, prev, head, op_hash: op });
    }};
}

macro_rules! emit_logs {
    ($ctx:ident, $logs:expr) => {{
        let chain = $ctx.accounts.header.id;
        let ctx = &$ctx;
        for l in $logs {
            emit_cpi!(GuestLog { chain, address: Pubkey::from(l.address), topics: l.topics, data: l.data });
        }
    }};
}

#[program]
pub mod chains {
    use super::*;

    // ------------------------------------------------------------------ registry (§4)

    /// Creates the registry and the Core collection. Only the program's upgrade authority.
    pub fn initialize(ctx: Context<Initialize>, launch_authority: Pubkey, treasury: Pubkey, fee_lamports_per_mcu: u64, uri_base: String) -> Result<()> {
        require!(uri_base.len() <= URI_BASE_MAX && uri_base.ends_with('/'), ChainsError::BadUri);
        let r = &mut ctx.accounts.registry;
        r.launch_authority = launch_authority;
        r.treasury = treasury;
        r.collection = ctx.accounts.collection.key();
        r.fee_lamports_per_mcu = fee_lamports_per_mcu;
        r.uri_base = uri_base.clone();
        r.bump = ctx.bumps.registry;
        r.collection_bump = ctx.bumps.collection;

        let seeds: &[&[u8]] = &[SEED_COLLECTION, &[ctx.bumps.collection]];
        mpl_core::instructions::CreateCollectionV2CpiBuilder::new(&ctx.accounts.mpl_core_program)
            .collection(&ctx.accounts.collection)
            .update_authority(Some(&ctx.accounts.registry.to_account_info()))
            .payer(&ctx.accounts.deployer)
            .system_program(&ctx.accounts.system_program)
            .name("Chains".to_string())
            .uri(format!("{uri_base}collection.json"))
            .invoke_signed(&[seeds])?;
        Ok(())
    }

    pub fn set_mint(ctx: Context<Authority>, mint: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        require!(r.chains_mint == Pubkey::default(), ChainsError::AlreadySet);
        require!(mint != Pubkey::default(), ChainsError::BadArgument);
        r.chains_mint = mint;
        Ok(())
    }

    pub fn set_snapshot(ctx: Context<Authority>, slot: u64, root: [u8; 32], hash: [u8; 32], claims_open_at: i64) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        require!(r.snapshot_slot == 0, ChainsError::AlreadySet);
        require!(r.chains_mint != Pubkey::default(), ChainsError::SnapshotNotSet);
        require!(slot > 0 && root != [0; 32], ChainsError::BadArgument);
        r.snapshot_slot = slot;
        r.snapshot_root = root;
        r.snapshot_hash = hash;
        r.claims_open_at = claims_open_at;
        Ok(())
    }

    /// Mints `n` chain NFTs to the signer. Remaining accounts: the `n` asset PDAs, in id order.
    pub fn claim<'info>(ctx: Context<'_, '_, 'info, 'info, Claim<'info>>, proof: Vec<[u8; 32]>, total_claims: u32, n: u8) -> Result<()> {
        let wallet = ctx.accounts.claimer.key();
        let r = &ctx.accounts.registry;
        require!(r.snapshot_slot != 0, ChainsError::SnapshotNotSet);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= r.claims_open_at, ChainsError::ClaimsNotOpen);
        require!(n >= 1 && ctx.remaining_accounts.len() == n as usize, ChainsError::BadArgument);
        require!(merkle::verify(&proof, merkle::leaf(&wallet.to_bytes(), total_claims), &r.snapshot_root), ChainsError::NotListed);
        let rec = &mut ctx.accounts.claim_record;
        require!(rec.used as u64 + n as u64 <= total_claims as u64, ChainsError::TooManyClaims);
        if now < r.claims_open_at.saturating_add(PRIORITY_WINDOW) {
            require!(rec.used + n as u32 <= 1, ChainsError::OnePerWallet);
        }
        require!(r.claimed + n as u32 <= MAX_CHAINS, ChainsError::SoldOut);
        rec.wallet = wallet;
        rec.used += n as u32;
        rec.bump = ctx.bumps.claim_record;

        let first = r.claimed + 1;
        let uri_base = r.uri_base.clone();
        let reg_seeds: &[&[u8]] = &[SEED_REGISTRY, &[r.bump]];
        for (k, asset) in ctx.remaining_accounts.iter().enumerate() {
            let id = first + k as u32;
            let (pda, bump) = Pubkey::find_program_address(&[SEED_ASSET, &id.to_le_bytes()], &crate::ID);
            require_keys_eq!(asset.key(), pda, ChainsError::BadAsset);
            let asset_seeds: &[&[u8]] = &[SEED_ASSET, &id.to_le_bytes(), &[bump]];
            mpl_core::instructions::CreateV2CpiBuilder::new(&ctx.accounts.mpl_core_program)
                .asset(asset)
                .collection(Some(&ctx.accounts.collection))
                .authority(Some(&ctx.accounts.registry.to_account_info()))
                .payer(&ctx.accounts.claimer)
                .owner(Some(&ctx.accounts.claimer))
                .system_program(&ctx.accounts.system_program)
                .name(format!("Chain #{id}"))
                .uri(format!("{uri_base}chain/{id}.json"))
                .invoke_signed(&[asset_seeds, reg_seeds])?;
        }
        ctx.accounts.registry.claimed += n as u32;
        emit!(Claimed { wallet, first_id: first, count: n });
        Ok(())
    }

    // ------------------------------------------------------------------ chains (§5, §6, §15)

    pub fn launch(ctx: Context<Launch>, id: u32, expiry: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(id >= 1 && id <= ctx.accounts.registry.claimed, ChainsError::NotClaimed);
        require_keys_eq!(asset_owner(&ctx.accounts.asset)?, ctx.accounts.holder.key(), ChainsError::NotHolder);
        require!(expiry == 0 || expiry >= now + MIN_EXPIRY, ChainsError::BadExpiry);

        // The state account: one table (§6), created here because it's raw bytes.
        let space = table::size_for(STATE_INITIAL_PAGES);
        let seeds: &[&[u8]] = &[SEED_STATE, &id.to_le_bytes(), &[ctx.bumps.state]];
        create_pda(
            &ctx.accounts.holder.to_account_info(),
            &ctx.accounts.state.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            seeds,
            space,
        )?;
        Table::init(&mut ctx.accounts.state.try_borrow_mut_data()?).map_err(table_err)?;

        let h = &mut ctx.accounts.header;
        h.id = id;
        h.status = STATUS_RUNNING;
        h.bump = ctx.bumps.header;
        h.state_bump = ctx.bumps.state;
        h.expiry = expiry;
        h.launched_at = now;
        let holder = ctx.accounts.holder.key();
        commit!(ctx, history::op_hash(b"launch", &[holder.as_ref(), &expiry.to_be_bytes()]));
        Ok(())
    }

    pub fn set_name(ctx: Context<SetName>, _id: u32, name: String) -> Result<()> {
        require_keys_eq!(asset_owner(&ctx.accounts.asset)?, ctx.accounts.holder.key(), ChainsError::NotHolder);
        require!(valid_name(&name), ChainsError::BadName);
        let h = &mut ctx.accounts.header;
        h.name = [0; 24];
        h.name[..name.len()].copy_from_slice(name.as_bytes());
        h.name_len = name.len() as u8;
        Ok(())
    }

    /// Adds `bytes` to the state account, paid by the fee payer (§6).
    pub fn grow(ctx: Context<Grow>, _id: u32, bytes: u32) -> Result<()> {
        running(&ctx.accounts.header, Clock::get()?.unix_timestamp)?;
        let state = &ctx.accounts.state;
        let new_len = state.data_len() + bytes as usize;
        require!(bytes >= 1 && bytes <= 10_240 && new_len <= STATE_MAX, ChainsError::GrowTooLarge);
        let need = Rent::get()?.minimum_balance(new_len).saturating_sub(state.lamports());
        if need > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: state.to_account_info() },
                ),
                need,
            )?;
        }
        state.resize(new_len)?;
        Ok(())
    }

    // ------------------------------------------------------------------ ledger (§7)

    pub fn deposit(ctx: Context<Deposit>, _id: u32, beneficiary: Pubkey, lamports: u64) -> Result<()> {
        running(&ctx.accounts.header, Clock::get()?.unix_timestamp)?;
        require!(lamports > 0, ChainsError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.header.to_account_info() },
            ),
            lamports,
        )?;
        let rent = {
            let mut data = ctx.accounts.state.try_borrow_mut_data()?;
            let mut l = Ledger::new(Table::open(&mut data).map_err(table_err)?);
            let before = l.t.count();
            l.credit(&beneficiary.to_bytes(), lamports).map_err(vm_err)?;
            new_entries_rent(before, l.t.count())?
        };
        pay_rent(&ctx.accounts.payer.to_account_info(), &ctx.accounts.state.to_account_info(), &ctx.accounts.system_program.to_account_info(), rent)?;
        let h = &mut ctx.accounts.header;
        h.total_deposits = h.total_deposits.checked_add(lamports).ok_or(ChainsError::BadArgument)?;
        check_backed(&ctx.accounts.header.to_account_info(), ctx.accounts.header.total_deposits)?;
        let payer = ctx.accounts.payer.key();
        commit!(ctx, history::op_hash(b"deposit", &[payer.as_ref(), beneficiary.as_ref(), &lamports.to_be_bytes()]));
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, _id: u32, lamports: u64) -> Result<()> {
        running(&ctx.accounts.header, Clock::get()?.unix_timestamp)?;
        require!(lamports > 0, ChainsError::ZeroAmount);
        let who = ctx.accounts.account.key().to_bytes();
        {
            let mut data = ctx.accounts.state.try_borrow_mut_data()?;
            let mut l = Ledger::new(Table::open(&mut data).map_err(table_err)?);
            require!(!l.is_guest(&who), ChainsError::GuestSigner);
            l.debit(&who, lamports).map_err(vm_err)?;
        }
        move_lamports(&ctx.accounts.header.to_account_info(), &ctx.accounts.recipient, lamports)?;
        let h = &mut ctx.accounts.header;
        h.total_deposits -= lamports;
        check_backed(&ctx.accounts.header.to_account_info(), ctx.accounts.header.total_deposits)?;
        let (account, recipient) = (ctx.accounts.account.key(), ctx.accounts.recipient.key());
        commit!(ctx, history::op_hash(b"withdraw", &[account.as_ref(), recipient.as_ref(), &lamports.to_be_bytes()]));
        Ok(())
    }

    /// Calls a guest (§9). Remaining accounts: code accounts and anything ACCOUNTLOAD reads.
    pub fn transact<'info>(
        ctx: Context<'_, '_, 'info, 'info, Transact<'info>>,
        id: u32,
        target: Pubkey,
        value: u64,
        data: Vec<u8>,
        max_steps: u32,
        max_fee: u64,
    ) -> Result<()> {
        let cu_start = cu_left();
        running(&ctx.accounts.header, Clock::get()?.unix_timestamp)?;
        require!(data.len() <= vm::MAX_CALLDATA, ChainsError::CalldataTooLong);
        let sender = ctx.accounts.sender.key().to_bytes();
        let chain_addr = ctx.accounts.header.key().to_bytes();
        let rate = ctx.accounts.registry.fee_lamports_per_mcu;

        let env = TxEnv::new(ctx.remaining_accounts, id);
        let (nonce, result, fee, rent, logs) = {
            let mut sd = ctx.accounts.state.try_borrow_mut_data()?;
            let mut l = Ledger::new(Table::open(&mut sd).map_err(table_err)?);
            let before = l.t.count();
            require!(!l.is_guest(&sender), ChainsError::GuestSigner);
            let nonce = l.use_nonce(&sender).map_err(vm_err)?;
            let (result, steps) = {
                let mut m = Vm::new(&mut l, &env, max_steps as u64, false).map_err(vm_err)?;
                let r = m.call(&sender, &target.to_bytes(), value, &data, 0).map_err(vm_err)?;
                (r, max_steps as u64 - m.steps_left)
            };
            let real = cu_start.saturating_sub(cu_left());
            // The fee transfer below is one debit and one credit: 2 writes, counted in advance.
            let units = tx_units(steps, l.reads.get(), l.writes + 2, l.logs.len() as u64, data.len() as u64);
            let fee = chain_fee(units, rate);
            l.transfer(&sender, &chain_addr, fee).map_err(vm_err)?;
            // Storage rent for every entry this call added, from the sender's balance (§6).
            let rent = new_entries_rent(before, l.t.count())?;
            require!(fee.checked_add(rent).ok_or(ChainsError::FeeTooHigh)? <= max_fee, ChainsError::FeeTooHigh);
            l.debit(&sender, rent).map_err(vm_err)?;
            if cfg!(feature = "localnet") {
                msg!("meter real={} units={} steps={} reads={} writes={} logs={}", real, units, steps, l.reads.get(), l.writes, l.logs.len());
            }
            (nonce, result, fee, rent, std::mem::take(&mut l.logs))
        };
        drop(env);
        ctx.accounts.header.fees_accrued += fee;
        ctx.accounts.header.total_deposits -= rent;
        move_lamports(&ctx.accounts.header.to_account_info(), &ctx.accounts.state.to_account_info(), rent)?;
        emit_logs!(ctx, logs);
        let res_hash = vm::keccak(&[result.as_ref().map(|w| &w[..]).unwrap_or(&[])]);
        commit!(
            ctx,
            history::op_hash(
                b"transaction",
                &[&sender, target.as_ref(), &value.to_be_bytes(), &nonce.to_be_bytes(), &(max_steps as u64).to_be_bytes(), &vm::keccak(&[&data]), &res_hash],
            )
        );
        // Last: the event self-CPIs above would clear it.
        if let Some(w) = &result {
            set_return_data(w);
        }
        Ok(())
    }

    /// Runs a guest without saving anything; the result is the return data. Use it through
    /// simulateTransaction.
    pub fn read<'info>(ctx: Context<'_, '_, 'info, 'info, Read<'info>>, id: u32, target: Pubkey, data: Vec<u8>, max_steps: u32) -> Result<()> {
        require!(data.len() <= vm::MAX_CALLDATA, ChainsError::CalldataTooLong);
        let env = TxEnv::new(ctx.remaining_accounts, id);
        let mut sd = ctx.accounts.state.try_borrow_mut_data()?;
        let mut l = Ledger::new(Table::open(&mut sd).map_err(table_err)?);
        let result = {
            let mut m = Vm::new(&mut l, &env, max_steps as u64, true).map_err(vm_err)?;
            m.call(&ctx.accounts.caller.key().to_bytes(), &target.to_bytes(), 0, &data, 0).map_err(vm_err)?
        };
        if let Some(w) = result {
            set_return_data(&w);
        }
        Ok(())
    }

    // ------------------------------------------------------------------ guests (§8)

    pub fn deploy_begin(ctx: Context<DeployBegin>, id: u32, salt: [u8; 32], len: u32, address: [u8; 32]) -> Result<()> {
        running(&ctx.accounts.header, Clock::get()?.unix_timestamp)?;
        require!(len >= 1 && len as usize <= vm::MAX_CODE, ChainsError::CodeTooLong);
        let creator = ctx.accounts.creator.key();
        let (nonce, rent_due) = {
            let mut sd = ctx.accounts.state.try_borrow_mut_data()?;
            let mut l = Ledger::new(Table::open(&mut sd).map_err(table_err)?);
            let before = l.t.count();
            require!(!l.is_guest(&creator.to_bytes()), ChainsError::GuestSigner);
            let nonce = l.use_nonce(&creator.to_bytes()).map_err(vm_err)?;
            require!(guest_address(id, &creator, nonce, &salt) == address, ChainsError::BadAddress);
            require!(!l.is_guest(&address), ChainsError::AddressOccupied);
            (nonce, new_entries_rent(before, l.t.count())?)
        };
        pay_rent(&ctx.accounts.creator.to_account_info(), &ctx.accounts.state.to_account_info(), &ctx.accounts.system_program.to_account_info(), rent_due)?;
        // Prepay rent for the full code; deploy_write grows the account to it.
        let rent = Rent::get()?;
        let extra = rent.minimum_balance(CODE_HDR + len as usize) - rent.minimum_balance(CODE_HDR);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer { from: ctx.accounts.creator.to_account_info(), to: ctx.accounts.code.to_account_info() },
            ),
            extra,
        )?;
        let c = &mut ctx.accounts.code;
        c.chain_id = id;
        c.address = address;
        c.creator = creator;
        c.nonce = nonce;
        c.kind = KIND_MINIVM;
        c.len = len;
        c.bump = ctx.bumps.code;
        Ok(())
    }

    pub fn deploy_write(ctx: Context<DeployWrite>, _id: u32, _address: [u8; 32], offset: u32, bytes: Vec<u8>) -> Result<()> {
        let c = &ctx.accounts.code;
        require_keys_eq!(c.creator, ctx.accounts.creator.key(), ChainsError::NotCreator);
        require!(!c.sealed, ChainsError::AlreadySealed);
        let end = offset as usize + bytes.len();
        require!(end <= c.len as usize, ChainsError::WriteOutOfRange);
        let info = c.to_account_info();
        let full = CODE_HDR + c.len as usize;
        if info.data_len() < full {
            info.resize(full)?;
        }
        info.try_borrow_mut_data()?[CODE_HDR + offset as usize..CODE_HDR + end].copy_from_slice(&bytes);
        Ok(())
    }

    pub fn deploy_seal(ctx: Context<DeploySeal>, id: u32, address: [u8; 32], max_fee: u64) -> Result<()> {
        let cu_start = cu_left();
        running(&ctx.accounts.header, Clock::get()?.unix_timestamp)?;
        let creator = ctx.accounts.creator.key();
        require_keys_eq!(ctx.accounts.code.creator, creator, ChainsError::NotCreator);
        require!(!ctx.accounts.code.sealed, ChainsError::AlreadySealed);
        let len = ctx.accounts.code.len as usize;
        let code_hash = {
            let info = ctx.accounts.code.to_account_info();
            let d = info.try_borrow_data()?;
            let code = d.get(CODE_HDR..CODE_HDR + len).ok_or(ChainsError::InvalidCode)?;
            vm::validate(code).map_err(code_err)?;
            vm::keccak(&[code])
        };
        let chain_addr = ctx.accounts.header.key().to_bytes();
        let (fee, rent) = {
            let mut sd = ctx.accounts.state.try_borrow_mut_data()?;
            let mut l = Ledger::new(Table::open(&mut sd).map_err(table_err)?);
            let before = l.t.count();
            require!(!l.is_guest(&address), ChainsError::AddressOccupied);
            l.mark_guest(&address).map_err(vm_err)?;
            let real = cu_start.saturating_sub(cu_left());
            let units = seal_units(len as u64, l.reads.get(), l.writes + 2);
            let fee = chain_fee(units, ctx.accounts.registry.fee_lamports_per_mcu);
            if cfg!(feature = "localnet") {
                msg!("meter real={} units={} seal len={}", real, units, len);
            }
            l.transfer(&creator.to_bytes(), &chain_addr, fee).map_err(vm_err)?;
            let rent = new_entries_rent(before, l.t.count())?;
            require!(fee.checked_add(rent).ok_or(ChainsError::FeeTooHigh)? <= max_fee, ChainsError::FeeTooHigh);
            l.debit(&creator.to_bytes(), rent).map_err(vm_err)?;
            (fee, rent)
        };
        ctx.accounts.header.total_deposits -= rent;
        move_lamports(&ctx.accounts.header.to_account_info(), &ctx.accounts.state.to_account_info(), rent)?;
        let c = &mut ctx.accounts.code;
        c.sealed = true;
        c.code_hash = code_hash;
        let (nonce, kind) = (c.nonce, c.kind);
        let _ = id;
        ctx.accounts.header.fees_accrued += fee;
        commit!(ctx, history::op_hash(b"deploy", &[creator.as_ref(), &nonce.to_be_bytes(), &address, &[kind], &code_hash]));
        Ok(())
    }

    // ------------------------------------------------------------------ fees and the end (§12, §13)

    /// Pays unclaimed fees half to the chain's current holder, half to the treasury.
    pub fn claim_fees(ctx: Context<Payout>, _id: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.header.status == STATUS_RUNNING, ChainsError::AlreadySwept);
        require!(!ctx.accounts.header.ended(now), ChainsError::ChainEnded);
        require_keys_eq!(payee(&ctx.accounts.asset, &ctx.accounts.registry.treasury), ctx.accounts.holder.key(), ChainsError::BadPayee);
        let chain_addr = ctx.accounts.header.key().to_bytes();
        let amount = {
            let mut sd = ctx.accounts.state.try_borrow_mut_data()?;
            let mut l = Ledger::new(Table::open(&mut sd).map_err(table_err)?);
            let amount = l.balance(&chain_addr);
            require!(amount > 0, ChainsError::ZeroAmount);
            l.set_balance(&chain_addr, 0).map_err(vm_err)?;
            amount
        };
        let to_treasury = amount / 2;
        let to_holder = amount - to_treasury;
        let header = ctx.accounts.header.to_account_info();
        move_lamports(&header, &ctx.accounts.holder, to_holder)?;
        move_lamports(&header, &ctx.accounts.treasury, to_treasury)?;
        let h = &mut ctx.accounts.header;
        h.total_deposits -= amount;
        h.fees_claimed += amount;
        check_backed(&ctx.accounts.header.to_account_info(), ctx.accounts.header.total_deposits)?;
        let (holder, treasury) = (ctx.accounts.holder.key(), ctx.accounts.treasury.key());
        commit!(ctx, history::op_hash(b"claim", &[holder.as_ref(), treasury.as_ref(), &amount.to_be_bytes()]));
        Ok(())
    }

    /// After the end date: the treasury's half of unclaimed fees to the treasury, everything else
    /// (other users' balances included) and the state account's rent to the holder.
    pub fn sweep(ctx: Context<Payout>, _id: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.header.status == STATUS_RUNNING, ChainsError::AlreadySwept);
        require!(ctx.accounts.header.ended(now), ChainsError::NotEnded);
        let holder_key = payee(&ctx.accounts.asset, &ctx.accounts.registry.treasury);
        require_keys_eq!(holder_key, ctx.accounts.holder.key(), ChainsError::BadPayee);
        let chain_addr = ctx.accounts.header.key().to_bytes();
        let fees = {
            let mut sd = ctx.accounts.state.try_borrow_mut_data()?;
            let l = Ledger::new(Table::open(&mut sd).map_err(table_err)?);
            l.balance(&chain_addr)
        };
        let to_treasury = fees / 2;
        let header = ctx.accounts.header.to_account_info();
        move_lamports(&header, &ctx.accounts.treasury, to_treasury)?;
        let rent = Rent::get()?.minimum_balance(header.data_len());
        let rest = header.lamports().saturating_sub(rent);
        move_lamports(&header, &ctx.accounts.holder, rest)?;

        // Close the state account: rent to the holder, data gone.
        let state = ctx.accounts.state.to_account_info();
        let state_lamports = state.lamports();
        move_lamports(&state, &ctx.accounts.holder, state_lamports)?;
        state.resize(0)?;
        state.assign(&system_program::ID);

        let h = &mut ctx.accounts.header;
        h.status = STATUS_SWEPT;
        h.total_deposits = 0;
        let id = h.id;
        emit_cpi!(Swept { chain: id, holder: holder_key, holder_lamports: rest + state_lamports, treasury_lamports: to_treasury });
        Ok(())
    }
}

// ====================================================================== accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub deployer: Signer<'info>,
    #[account(init, payer = deployer, space = 8 + Registry::INIT_SPACE, seeds = [SEED_REGISTRY], bump)]
    pub registry: Account<'info, Registry>,
    /// CHECK: created by Metaplex Core at this PDA.
    #[account(mut, seeds = [SEED_COLLECTION], bump)]
    pub collection: UncheckedAccount<'info>,
    #[account(constraint = this_program.programdata_address()? == Some(program_data.key()) @ ChainsError::Unauthorized)]
    pub this_program: Program<'info, program::Chains>,
    #[account(constraint = program_data.upgrade_authority_address == Some(deployer.key()) @ ChainsError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    /// CHECK: address checked.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Authority<'info> {
    pub launch_authority: Signer<'info>,
    #[account(mut, seeds = [SEED_REGISTRY], bump = registry.bump, has_one = launch_authority @ ChainsError::Unauthorized)]
    pub registry: Account<'info, Registry>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(init_if_needed, payer = claimer, space = 8 + ClaimRecord::INIT_SPACE, seeds = [SEED_CLAIMED, claimer.key().as_ref()], bump)]
    pub claim_record: Account<'info, ClaimRecord>,
    /// CHECK: the registry's collection.
    #[account(mut, address = registry.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: address checked.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Launch<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    /// CHECK: PDA checked; owner read from its data.
    #[account(seeds = [SEED_ASSET, &id.to_le_bytes()], bump)]
    pub asset: UncheckedAccount<'info>,
    #[account(init, payer = holder, space = 8 + ChainHeader::INIT_SPACE, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: created here as a raw table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump)]
    pub state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct SetName<'info> {
    pub holder: Signer<'info>,
    /// CHECK: PDA checked; owner read from its data.
    #[account(seeds = [SEED_ASSET, &id.to_le_bytes()], bump)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Grow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Withdraw<'info> {
    pub account: Signer<'info>,
    #[account(mut, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: any account; receives real lamports.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Transact<'info> {
    pub sender: Signer<'info>,
    #[account(seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Read<'info> {
    /// CHECK: any address; it's CALLER for the top-level call.
    pub caller: UncheckedAccount<'info>,
    #[account(seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table (read only; static frames never write).
    #[account(seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(id: u32, salt: [u8; 32], len: u32, address: [u8; 32])]
pub struct DeployBegin<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = CODE_HDR, seeds = [SEED_CODE, &id.to_le_bytes(), &address], bump)]
    pub code: Account<'info, CodeAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u32, address: [u8; 32])]
pub struct DeployWrite<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [SEED_CODE, &id.to_le_bytes(), &address], bump = code.bump)]
    pub code: Account<'info, CodeAccount>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u32, address: [u8; 32])]
pub struct DeploySeal<'info> {
    pub creator: Signer<'info>,
    #[account(seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_CODE, &id.to_le_bytes(), &address], bump = code.bump)]
    pub code: Account<'info, CodeAccount>,
}

/// claim_fees and sweep.
#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u32)]
pub struct Payout<'info> {
    #[account(seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut, seeds = [SEED_CHAIN, &id.to_le_bytes()], bump = header.bump)]
    pub header: Account<'info, ChainHeader>,
    /// CHECK: the chain's table.
    #[account(mut, seeds = [SEED_STATE, &id.to_le_bytes()], bump = header.state_bump)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: PDA checked; owner read from its data (or burned).
    #[account(seeds = [SEED_ASSET, &id.to_le_bytes()], bump)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the asset's current owner, or the treasury if it was burned (checked in the handler).
    #[account(mut)]
    pub holder: UncheckedAccount<'info>,
    /// CHECK: the registry's treasury.
    #[account(mut, address = registry.treasury @ ChainsError::BadPayee)]
    pub treasury: UncheckedAccount<'info>,
}
