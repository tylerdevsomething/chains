use anchor_lang::prelude::*;

use crate::table::TableError;
use crate::vm::{CodeError, VmError};

#[error_code]
pub enum ChainsError {
    // Registry and claiming (§4)
    #[msg("Only the launch authority can do this")]
    Unauthorized,
    #[msg("Already set; it can only be set once")]
    AlreadySet,
    #[msg("The snapshot or mint hasn't been set yet")]
    SnapshotNotSet,
    #[msg("Proof doesn't match the snapshot root")]
    NotListed,
    #[msg("More claims than the snapshot gives this wallet")]
    TooManyClaims,
    #[msg("All chains are claimed")]
    SoldOut,
    #[msg("Wrong asset accounts for the chain ids being minted")]
    BadAsset,
    #[msg("URI base too long")]
    BadUri,
    #[msg("Bad argument")]
    BadArgument,

    // Chains (§5, §13, §15)
    #[msg("Chain not claimed yet")]
    NotClaimed,
    #[msg("Signer doesn't own this chain's asset")]
    NotHolder,
    #[msg("End date must be 0 or at least MIN_EXPIRY from now")]
    BadExpiry,
    #[msg("Name must be ≤ 24 letters, digits, hyphens or inner spaces")]
    BadName,
    #[msg("This chain has ended")]
    ChainEnded,
    #[msg("This chain hasn't ended")]
    NotEnded,
    #[msg("Already swept")]
    AlreadySwept,
    #[msg("Nothing to pay")]
    ZeroAmount,
    #[msg("Wrong treasury or holder account")]
    BadPayee,
    #[msg("Grow by at most 10,240 bytes, up to 10 MB")]
    GrowTooLarge,
    #[msg("The state account needs more space: precede this with grow")]
    NoSpace,
    #[msg("State account is corrupt")]
    Corrupt,

    // Ledger and calls (§7, §10, §11)
    #[msg("Internal balance too low")]
    InsufficientBalance,
    #[msg("Chain fee is above max_fee")]
    FeeTooHigh,
    #[msg("max_steps must be 1..=10,000")]
    InvalidStepBudget,
    #[msg("Ran out of steps")]
    StepLimit,
    #[msg("Calls nested too deep")]
    DepthLimit,
    #[msg("Input longer than 800 bytes")]
    CalldataTooLong,
    #[msg("A guest's code account isn't listed in the transaction")]
    MissingCode,
    #[msg("A Solana account ACCOUNTLOAD needs isn't listed in the transaction")]
    MissingAccount,
    #[msg("read can't write, log or move lamports")]
    StaticViolation,
    #[msg("REQUIRE failed")]
    RequireFailed,
    #[msg("Guest reverted")]
    Reverted,
    #[msg("Too many logs in one call")]
    TooManyLogs,
    #[msg("Guest addresses can't sign")]
    GuestSigner,

    // Guests (§8, §9)
    #[msg("Code longer than 10,240 bytes")]
    CodeTooLong,
    #[msg("Invalid code")]
    InvalidCode,
    #[msg("Invalid opcode")]
    InvalidOpcode,
    #[msg("Address doesn't match creator, nonce and salt")]
    BadAddress,
    #[msg("Address already holds code")]
    AddressOccupied,
    #[msg("Code is sealed")]
    AlreadySealed,
    #[msg("Only the creator can write this code")]
    NotCreator,
    #[msg("Write past the end of the code")]
    WriteOutOfRange,
}

pub fn vm_err(e: VmError) -> Error {
    match e {
        VmError::InvalidStepBudget => ChainsError::InvalidStepBudget.into(),
        VmError::StepLimit => ChainsError::StepLimit.into(),
        VmError::DepthLimit => ChainsError::DepthLimit.into(),
        VmError::StaticViolation => ChainsError::StaticViolation.into(),
        VmError::InsufficientBalance => ChainsError::InsufficientBalance.into(),
        VmError::MissingCode(a) => {
            msg!("MissingCode({})", Pubkey::from(a));
            ChainsError::MissingCode.into()
        }
        VmError::MissingAccount(a) => {
            msg!("MissingAccount({})", Pubkey::from(a));
            ChainsError::MissingAccount.into()
        }
        VmError::RequireFailed(pc) => {
            msg!("RequireFailed(pc={})", pc);
            ChainsError::RequireFailed.into()
        }
        VmError::Reverted(w) => {
            msg!("Reverted({})", hex(&w));
            ChainsError::Reverted.into()
        }
        VmError::InvalidCode(pc) => {
            msg!("InvalidCode(pc={})", pc);
            ChainsError::InvalidCode.into()
        }
        VmError::TooManyLogs => ChainsError::TooManyLogs.into(),
        VmError::NoSpace => ChainsError::NoSpace.into(),
    }
}

pub fn code_err(e: CodeError) -> Error {
    match e {
        CodeError::InvalidCode(pc) => {
            msg!("InvalidCode(pc={})", pc);
            ChainsError::InvalidCode.into()
        }
        CodeError::InvalidOpcode(pc, op) => {
            msg!("InvalidOpcode(pc={}, op=0x{:02x})", pc, op);
            ChainsError::InvalidOpcode.into()
        }
        CodeError::TooLong => ChainsError::CodeTooLong.into(),
    }
}

pub fn table_err(e: TableError) -> Error {
    match e {
        TableError::NoSpace => ChainsError::NoSpace.into(),
        TableError::Corrupt => ChainsError::Corrupt.into(),
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
