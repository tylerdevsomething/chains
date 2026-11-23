use anchor_lang::prelude::*;

#[cfg(not(feature = "localnet"))]
pub const MAX_CHAINS: u32 = 500;
#[cfg(feature = "localnet")]
pub const MAX_CHAINS: u32 = 6;

#[cfg(not(feature = "localnet"))]
pub const MIN_EXPIRY: i64 = 30 * 24 * 60 * 60;
/// After claims open, each wallet can claim one chain until this much time has passed (§4).
#[cfg(not(feature = "localnet"))]
pub const PRIORITY_WINDOW: i64 = 24 * 60 * 60;
#[cfg(feature = "localnet")]
pub const MIN_EXPIRY: i64 = 5;
#[cfg(feature = "localnet")]
pub const PRIORITY_WINDOW: i64 = 8;

pub const NAME_MAX: usize = 24;
pub const URI_BASE_MAX: usize = 100;
pub const FEE_OVERHEAD_CU: u64 = 20_000;
/// The fee meter (§11). Calibrated on localnet against real compute.
pub const CU_PER_STEP: u64 = 250;
pub const CU_PER_READ: u64 = 150;
pub const CU_PER_WRITE: u64 = 300;
pub const CU_PER_LOG: u64 = 2_000;
pub const CU_PER_CALLDATA_BYTE: u64 = 1;
pub const CU_PER_CODE_BYTE: u64 = 7;
/// Largest state account (Solana's account size limit).
pub const STATE_MAX: usize = 10 * 1024 * 1024;
/// Pages a fresh state account starts with (§6).
pub const STATE_INITIAL_PAGES: usize = 8;

pub const STATUS_RUNNING: u8 = 0;
pub const STATUS_SWEPT: u8 = 1;

pub const SEED_REGISTRY: &[u8] = b"registry";
pub const SEED_COLLECTION: &[u8] = b"collection";
pub const SEED_ASSET: &[u8] = b"asset";
pub const SEED_CLAIMED: &[u8] = b"claimed";
pub const SEED_CHAIN: &[u8] = b"chain";
pub const SEED_STATE: &[u8] = b"state";
pub const SEED_CODE: &[u8] = b"code";

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub launch_authority: Pubkey,
    pub treasury: Pubkey,
    pub chains_mint: Pubkey,
    pub collection: Pubkey,
    pub snapshot_root: [u8; 32],
    pub snapshot_hash: [u8; 32],
    pub snapshot_slot: u64,
    pub claimed: u32,
    /// Lamports per million compute units (§11). Set once at initialize, never changed.
    pub fee_lamports_per_mcu: u64,
    /// When claiming opens (unix seconds), set with the snapshot. One chain per wallet for the
    /// first PRIORITY_WINDOW seconds.
    pub claims_open_at: i64,
    /// The renderer's base URL, ending in "/": assets point at `<uri_base>chain/<id>.json`.
    #[max_len(100)]
    pub uri_base: String,
    pub bump: u8,
    pub collection_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub wallet: Pubkey,
    pub used: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ChainHeader {
    pub id: u32,
    pub name: [u8; 24],
    pub name_len: u8,
    pub status: u8,
    pub bump: u8,
    pub state_bump: u8,
    pub height: u64,
    pub head: [u8; 32],
    /// Unix time the chain stops; 0 = never.
    pub expiry: i64,
    pub launched_at: i64,
    /// Sum of every internal balance, unclaimed fees included (§1).
    pub total_deposits: u64,
    pub fees_accrued: u64,
    pub fees_claimed: u64,
}

impl ChainHeader {
    pub fn ended(&self, now: i64) -> bool {
        self.expiry != 0 && now >= self.expiry
    }
}

/// One guest's code. The code bytes follow this header in the account, at `CODE_HDR`.
#[account]
#[derive(InitSpace)]
pub struct CodeAccount {
    pub chain_id: u32,
    pub address: [u8; 32],
    pub creator: Pubkey,
    pub nonce: u64,
    pub kind: u8,
    pub sealed: bool,
    pub len: u32,
    pub code_hash: [u8; 32],
    pub bump: u8,
}

pub const CODE_HDR: usize = 8 + CodeAccount::INIT_SPACE;
// Byte offsets inside a code account, for reading listed accounts without deserializing.
pub const CODE_OFF_CHAIN: usize = 8;
pub const CODE_OFF_ADDRESS: usize = 12;
pub const CODE_OFF_SEALED: usize = 85;
pub const CODE_OFF_LEN: usize = 86;
const _: () = assert!(CODE_HDR == 123);

pub const KIND_MINIVM: u8 = 1;

#[event]
pub struct BlockCommitted {
    pub chain: u32,
    pub height: u64,
    pub prev: [u8; 32],
    pub head: [u8; 32],
    pub op_hash: [u8; 32],
}

#[event]
pub struct GuestLog {
    pub chain: u32,
    pub address: Pubkey,
    pub topics: Vec<[u8; 32]>,
    pub data: Option<[u8; 32]>,
}

#[event]
pub struct Claimed {
    pub wallet: Pubkey,
    pub first_id: u32,
    pub count: u8,
}

#[event]
pub struct Swept {
    pub chain: u32,
    pub holder: Pubkey,
    pub holder_lamports: u64,
    pub treasury_lamports: u64,
}
