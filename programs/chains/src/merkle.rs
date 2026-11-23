//! Snapshot proofs (§3, §4). Leaf = keccak256(0x00 ‖ wallet ‖ claims as u32 big-endian).
//! Node = keccak256(0x01 ‖ smaller child ‖ larger child), so proofs carry no left/right flags.
//! A one-leaf tree's root is the leaf.

use crate::vm::{keccak, Word};

pub fn leaf(wallet: &[u8; 32], claims: u32) -> Word {
    keccak(&[&[0u8], wallet, &claims.to_be_bytes()])
}

pub fn node(a: &Word, b: &Word) -> Word {
    if a <= b {
        keccak(&[&[1u8], a, b])
    } else {
        keccak(&[&[1u8], b, a])
    }
}

pub fn verify(proof: &[Word], leaf: Word, root: &Word) -> bool {
    proof.iter().fold(leaf, |acc, p| node(&acc, p)) == *root
}
