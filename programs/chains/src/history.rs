//! History (§14). Each committed operation extends a hash chain:
//! `head_n = keccak256(head_{n-1} ‖ n ‖ op_hash)`, n as 8 bytes big-endian.
//! `op_hash = keccak256(tag ‖ fields…)`: keys and hashes as 32 bytes, integers big-endian
//! (u64 and i64 as 8 bytes, u8 as 1 byte).

use crate::state::ChainHeader;
use crate::vm::{keccak, Word};

pub fn op_hash(tag: &[u8], fields: &[&[u8]]) -> Word {
    let mut parts: Vec<&[u8]> = Vec::with_capacity(fields.len() + 1);
    parts.push(tag);
    parts.extend_from_slice(fields);
    keccak(&parts)
}

pub fn next_head(prev: &Word, height: u64, op: &Word) -> Word {
    keccak(&[prev, &height.to_be_bytes(), op])
}

/// Commits one operation; returns (height, prev head, new head).
pub fn commit(h: &mut ChainHeader, op: &Word) -> (u64, Word, Word) {
    let prev = h.head;
    h.height += 1;
    h.head = next_head(&prev, h.height, op);
    (h.height, prev, h.head)
}
