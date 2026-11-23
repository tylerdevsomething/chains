//! The chain's state table (§6): one hash table in one account, 32-byte keys to 32-byte values.
//!
//! Linear hashing: buckets are added one at a time by splitting the bucket at the split pointer, so
//! no operation ever rehashes the whole table. A value of zero means "absent": storing zero deletes.
//!
//! Layout (all integers little-endian):
//!
//! ```text
//! header (40 bytes)
//!   0 magic u32   4 level u32   8 split u32   12 n_buckets u32   16 pages_used u32
//!  20 free_head u32   24 free_count u32   28 reserved u32   32 count u64
//! pages (272 bytes each), from byte 40
//!   0 next u32   4 prev u32   8 owner u32   12 count u32   16 four entries of (key 32, value 32)
//! ```
//!
//! Page `b` is bucket `b`'s first page, so `n_buckets ≤ pages_used`. Pages past `n_buckets` are
//! overflow pages (owner = their bucket) or free (owner = FREE). Chains and the free list are doubly
//! linked, so any page can be moved or unlinked in constant time. Space past `pages_used` is unused
//! capacity added by `grow`.

pub const HDR: usize = 40;
pub const PER_PAGE: usize = 4;
pub const ENTRY: usize = 64;
pub const PAGE: usize = 16 + PER_PAGE * ENTRY;
pub const MAGIC: u32 = u32::from_le_bytes(*b"CHT1");
const NONE: u32 = u32::MAX;
const FREE: u32 = u32::MAX - 1;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TableError {
    /// The account needs more space: precede the call with `grow`.
    NoSpace,
    /// The account is not a table.
    Corrupt,
}

/// Bytes needed for an empty table with room for `pages` pages.
pub const fn size_for(pages: usize) -> usize {
    HDR + pages * PAGE
}

pub struct Table<'a> {
    d: &'a mut [u8],
}

impl<'a> Table<'a> {
    /// Formats `d` as an empty table with one bucket.
    pub fn init(d: &'a mut [u8]) -> Result<Table<'a>, TableError> {
        if d.len() < size_for(1) {
            return Err(TableError::NoSpace);
        }
        d[..HDR].fill(0);
        let mut t = Table { d };
        t.w32(0, MAGIC);
        t.w32(12, 1);
        t.w32(16, 1);
        t.w32(20, NONE);
        t.reset_page(0, 0);
        Ok(t)
    }

    pub fn open(d: &'a mut [u8]) -> Result<Table<'a>, TableError> {
        if d.len() < size_for(1) || u32::from_le_bytes(d[0..4].try_into().unwrap()) != MAGIC {
            return Err(TableError::Corrupt);
        }
        Ok(Table { d })
    }

    // ---- raw access ----

    fn r32(&self, at: usize) -> u32 {
        u32::from_le_bytes(self.d[at..at + 4].try_into().unwrap())
    }
    fn w32(&mut self, at: usize, v: u32) {
        self.d[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn level(&self) -> u32 {
        self.r32(4)
    }
    fn split(&self) -> u32 {
        self.r32(8)
    }
    pub fn n_buckets(&self) -> u32 {
        self.r32(12)
    }
    fn pages_used(&self) -> u32 {
        self.r32(16)
    }
    fn free_head(&self) -> u32 {
        self.r32(20)
    }
    fn free_count(&self) -> u32 {
        self.r32(24)
    }
    pub fn count(&self) -> u64 {
        u64::from_le_bytes(self.d[32..40].try_into().unwrap())
    }
    fn set_count(&mut self, v: u64) {
        self.d[32..40].copy_from_slice(&v.to_le_bytes());
    }
    pub fn capacity_pages(&self) -> u32 {
        ((self.d.len() - HDR) / PAGE) as u32
    }

    fn pg(p: u32) -> usize {
        HDR + p as usize * PAGE
    }
    fn next(&self, p: u32) -> u32 {
        self.r32(Self::pg(p))
    }
    fn prev(&self, p: u32) -> u32 {
        self.r32(Self::pg(p) + 4)
    }
    fn owner(&self, p: u32) -> u32 {
        self.r32(Self::pg(p) + 8)
    }
    fn pcount(&self, p: u32) -> u32 {
        self.r32(Self::pg(p) + 12)
    }
    fn set_next(&mut self, p: u32, v: u32) {
        self.w32(Self::pg(p), v)
    }
    fn set_prev(&mut self, p: u32, v: u32) {
        self.w32(Self::pg(p) + 4, v)
    }
    fn set_owner(&mut self, p: u32, v: u32) {
        self.w32(Self::pg(p) + 8, v)
    }
    fn set_pcount(&mut self, p: u32, v: u32) {
        self.w32(Self::pg(p) + 12, v)
    }
    fn ent(p: u32, i: u32) -> usize {
        Self::pg(p) + 16 + i as usize * ENTRY
    }
    fn key_at(&self, p: u32, i: u32) -> [u8; 32] {
        let a = Self::ent(p, i);
        self.d[a..a + 32].try_into().unwrap()
    }
    fn reset_page(&mut self, p: u32, owner: u32) {
        let a = Self::pg(p);
        self.d[a..a + PAGE].fill(0);
        self.set_next(p, NONE);
        self.set_prev(p, NONE);
        self.set_owner(p, owner);
    }

    // ---- hashing ----

    fn hash(key: &[u8; 32]) -> u32 {
        u32::from_le_bytes(key[0..4].try_into().unwrap())
    }

    fn bucket_of(&self, key: &[u8; 32]) -> u32 {
        let h = Self::hash(key) as u64;
        let lv = self.level();
        let b = h % (1u64 << lv);
        if b < self.split() as u64 {
            (h % (1u64 << (lv + 1))) as u32
        } else {
            b as u32
        }
    }

    // ---- pages ----

    fn available(&self) -> u32 {
        self.free_count() + (self.capacity_pages() - self.pages_used())
    }

    fn unlink_free(&mut self, p: u32) {
        let (n, pr) = (self.next(p), self.prev(p));
        if pr == NONE {
            self.w32(20, n);
        } else {
            self.set_next(pr, n);
        }
        if n != NONE {
            self.set_prev(n, pr);
        }
        let fc = self.free_count();
        self.w32(24, fc - 1);
    }

    fn alloc_page(&mut self, owner: u32) -> Option<u32> {
        let p = if self.free_head() != NONE {
            let p = self.free_head();
            self.unlink_free(p);
            p
        } else if self.pages_used() < self.capacity_pages() {
            let p = self.pages_used();
            self.w32(16, p + 1);
            p
        } else {
            return None;
        };
        self.reset_page(p, owner);
        Some(p)
    }

    fn free_page(&mut self, p: u32) {
        let head = self.free_head();
        self.reset_page(p, FREE);
        self.set_next(p, head);
        if head != NONE {
            self.set_prev(head, p);
        }
        self.w32(20, p);
        let fc = self.free_count();
        self.w32(24, fc + 1);
    }

    /// Removes overflow page `p` from its chain (it must not be a bucket's first page).
    fn unlink_chain(&mut self, p: u32) {
        let (n, pr) = (self.next(p), self.prev(p));
        self.set_next(pr, n);
        if n != NONE {
            self.set_prev(n, pr);
        }
    }

    // ---- lookups ----

    fn find(&self, key: &[u8; 32]) -> Option<(u32, u32)> {
        let mut p = self.bucket_of(key);
        while p != NONE {
            for i in 0..self.pcount(p) {
                if &self.d[Self::ent(p, i)..Self::ent(p, i) + 32] == key {
                    return Some((p, i));
                }
            }
            p = self.next(p);
        }
        None
    }

    /// The value at `key`, or all zeros.
    pub fn get(&self, key: &[u8; 32]) -> [u8; 32] {
        match self.find(key) {
            Some((p, i)) => {
                let a = Self::ent(p, i) + 32;
                self.d[a..a + 32].try_into().unwrap()
            }
            None => [0; 32],
        }
    }

    /// Stores `value` at `key`. Zero deletes. Fails with `NoSpace` (and changes nothing) when a
    /// new page is needed and the account has none left.
    pub fn set(&mut self, key: &[u8; 32], value: &[u8; 32]) -> Result<(), TableError> {
        if let Some((p, i)) = self.find(key) {
            if value == &[0; 32] {
                self.remove_at(p, i);
            } else {
                let a = Self::ent(p, i) + 32;
                self.d[a..a + 32].copy_from_slice(value);
            }
            return Ok(());
        }
        if value == &[0; 32] {
            return Ok(());
        }
        let b = self.bucket_of(key);
        self.append(b, key, value)?;
        let c = self.count() + 1;
        self.set_count(c);
        // Keep the load under 3/4. At most two splits per insert, so a table that fell behind
        // (because it was out of space) catches up gradually. A split that doesn't fit is skipped.
        for _ in 0..2 {
            let cap = self.n_buckets() as u64 * PER_PAGE as u64;
            if self.count() * 4 <= cap * 3 || !self.split_one() {
                break;
            }
        }
        Ok(())
    }

    /// Appends an entry to bucket `b`'s chain.
    fn append(&mut self, b: u32, key: &[u8; 32], value: &[u8; 32]) -> Result<(), TableError> {
        let mut p = b;
        loop {
            if self.pcount(p) < PER_PAGE as u32 {
                break;
            }
            let n = self.next(p);
            if n == NONE {
                let q = self.alloc_page(b).ok_or(TableError::NoSpace)?;
                self.set_next(p, q);
                self.set_prev(q, p);
                p = q;
                break;
            }
            p = n;
        }
        let i = self.pcount(p);
        let a = Self::ent(p, i);
        self.d[a..a + 32].copy_from_slice(key);
        self.d[a + 32..a + 64].copy_from_slice(value);
        self.set_pcount(p, i + 1);
        Ok(())
    }

    /// Removes entry `i` of page `p` by moving the chain's last entry into its place.
    fn remove_at(&mut self, p: u32, i: u32) {
        self.take_at(p, i);
        let c = self.count() - 1;
        self.set_count(c);
    }

    fn take_at(&mut self, p: u32, i: u32) {
        let mut last = p;
        while self.next(last) != NONE {
            last = self.next(last);
        }
        let li = self.pcount(last) - 1;
        if (last, li) != (p, i) {
            let (from, to) = (Self::ent(last, li), Self::ent(p, i));
            self.d.copy_within(from..from + ENTRY, to);
        }
        let e = Self::ent(last, li);
        self.d[e..e + ENTRY].fill(0);
        self.set_pcount(last, li);
        if li == 0 && self.prev(last) != NONE {
            self.unlink_chain(last);
            self.free_page(last);
        }
    }

    /// Adds one bucket by splitting the bucket at the split pointer. Returns false, changing
    /// nothing, when there isn't room.
    fn split_one(&mut self) -> bool {
        let nb = self.n_buckets();
        let s = self.split();
        let lv = self.level();
        if lv >= 31 {
            return false;
        }
        let moves = |h: u32| (h as u64 % (1u64 << (lv + 1))) as u32 != s;

        // Pages needed: the new bucket's first page (unless page nb is already free space), one
        // more if page nb holds an overflow page that has to move, and overflow for moved entries.
        let mut moving = 0u32;
        let mut p = s;
        while p != NONE {
            for i in 0..self.pcount(p) {
                if moves(Self::hash(&self.key_at(p, i))) {
                    moving += 1;
                }
            }
            p = self.next(p);
        }
        // One page for the new bucket itself (page nb if it's fresh or free, or a page to move the
        // overflow page at nb into), plus overflow pages for the entries that move. Pages freed
        // while moving aren't counted, so this is conservative.
        let need = 1 + moving.saturating_sub(1) / PER_PAGE as u32;
        let fresh_ok = nb < self.pages_used() || self.pages_used() < self.capacity_pages();
        if !fresh_ok || self.available() < need {
            return false;
        }

        // Make page nb the new bucket's first page.
        if nb < self.pages_used() {
            if self.owner(nb) == FREE {
                self.unlink_free(nb);
            } else {
                // An overflow page lives there: move it to a fresh page and relink.
                let owner = self.owner(nb);
                let q = match self.alloc_page(owner) {
                    Some(q) => q,
                    None => return false,
                };
                let (src, dst) = (Self::pg(nb), Self::pg(q));
                self.d.copy_within(src..src + PAGE, dst);
                let (n, pr) = (self.next(q), self.prev(q));
                self.set_next(pr, q);
                if n != NONE {
                    self.set_prev(n, q);
                }
            }
        } else {
            self.w32(16, nb + 1);
        }
        self.reset_page(nb, nb);

        // Move entries that now belong to nb.
        let mut p = s;
        let mut i = 0;
        while p != NONE {
            if i >= self.pcount(p) {
                p = self.next(p);
                i = 0;
                continue;
            }
            let k = self.key_at(p, i);
            if moves(Self::hash(&k)) {
                let a = Self::ent(p, i);
                let v: [u8; 32] = self.d[a + 32..a + 64].try_into().unwrap();
                // Space was reserved above, so this can't fail.
                let _ = self.append(nb, &k, &v);
                self.take_at(p, i);
                // take_at may have freed the chain's last page. If that was p, p was the last
                // page and the chain is done.
                if self.owner(p) == FREE {
                    break;
                }
            } else {
                i += 1;
            }
        }

        if s + 1 == 1 << lv {
            self.w32(4, lv + 1);
            self.w32(8, 0);
        } else {
            self.w32(8, s + 1);
        }
        self.w32(12, nb + 1);
        true
    }

    /// Checks every structural invariant. For tests and debugging.
    #[cfg(test)]
    pub fn check(&self) -> u64 {
        let mut total = 0u64;
        for b in 0..self.n_buckets() {
            assert_eq!(self.owner(b), b);
            assert_eq!(self.prev(b), NONE);
            let mut p = b;
            let mut prev = NONE;
            while p != NONE {
                assert_eq!(self.prev(p), prev);
                assert_eq!(self.owner(p), b);
                if p != b {
                    assert!(self.pcount(p) > 0, "empty overflow page");
                }
                for i in 0..self.pcount(p) {
                    assert_eq!(self.bucket_of(&self.key_at(p, i)), b);
                }
                total += self.pcount(p) as u64;
                prev = p;
                p = self.next(p);
            }
        }
        let mut f = self.free_head();
        let mut n = 0;
        while f != NONE {
            assert_eq!(self.owner(f), FREE);
            n += 1;
            f = self.next(f);
        }
        assert_eq!(n, self.free_count());
        assert_eq!(total, self.count());
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn key(n: u64) -> [u8; 32] {
        // Spread like keccak output: mix the counter.
        let mut x = n.wrapping_mul(0x9E3779B97F4A7C15) ^ 0xD1B54A32D192ED03;
        let mut k = [0u8; 32];
        for c in k.chunks_mut(8) {
            x ^= x >> 31;
            x = x.wrapping_mul(0xBF58476D1CE4E5B9);
            c.copy_from_slice(&x.to_le_bytes());
        }
        k
    }
    fn val(n: u64) -> [u8; 32] {
        let mut v = [0u8; 32];
        v[24..].copy_from_slice(&(n + 1).to_be_bytes());
        v
    }

    #[test]
    fn insert_get_update_delete() {
        let mut buf = vec![0u8; size_for(64)];
        let mut t = Table::init(&mut buf).unwrap();
        for n in 0..100 {
            t.set(&key(n), &val(n)).unwrap();
        }
        assert_eq!(t.check(), 100);
        assert!(t.n_buckets() > 1);
        for n in 0..100 {
            assert_eq!(t.get(&key(n)), val(n));
        }
        assert_eq!(t.get(&key(1000)), [0; 32]);
        t.set(&key(5), &val(77)).unwrap();
        assert_eq!(t.get(&key(5)), val(77));
        for n in (0..100).step_by(2) {
            t.set(&key(n), &[0; 32]).unwrap();
        }
        assert_eq!(t.check(), 50);
        for n in 0..100 {
            assert_eq!(t.get(&key(n)), if n % 2 == 0 { [0; 32] } else if n == 5 { val(77) } else { val(n) });
        }
        t.set(&key(9999), &[0; 32]).unwrap(); // deleting an absent key is a no-op
        assert_eq!(t.count(), 50);
    }

    #[test]
    fn no_space_changes_nothing_and_grow_resumes() {
        let mut buf = vec![0u8; size_for(2)];
        let mut n = 0;
        {
            let mut t = Table::init(&mut buf).unwrap();
            loop {
                let before = t.count();
                match t.set(&key(n), &val(n)) {
                    Ok(()) => n += 1,
                    Err(TableError::NoSpace) => {
                        assert_eq!(t.count(), before);
                        break;
                    }
                    Err(e) => panic!("{e:?}"),
                }
            }
            t.check();
        }
        // Grow the account (as realloc would) and keep going; splits catch up.
        buf.resize(size_for(400), 0);
        let mut t = Table::open(&mut buf).unwrap();
        for m in n..n + 500 {
            t.set(&key(m), &val(m)).unwrap();
        }
        assert_eq!(t.check(), n + 500);
        for m in 0..n + 500 {
            assert_eq!(t.get(&key(m)), val(m));
        }
        let load = t.count() as f64 / (t.n_buckets() as f64 * PER_PAGE as f64);
        assert!(load <= 0.76, "load {load}");
    }

    #[test]
    fn randomized_against_hashmap() {
        let mut buf = vec![0u8; size_for(400)];
        let mut t = Table::init(&mut buf).unwrap();
        let mut m: HashMap<[u8; 32], [u8; 32]> = HashMap::new();
        let mut x: u64 = 7;
        for step in 0..20_000u64 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let k = key(x % 600);
            let v = if x % 3 == 0 { [0; 32] } else { val(step) };
            t.set(&k, &v).unwrap();
            if v == [0; 32] {
                m.remove(&k);
            } else {
                m.insert(k, v);
            }
            if step % 2000 == 0 {
                assert_eq!(t.check(), m.len() as u64);
            }
        }
        assert_eq!(t.check(), m.len() as u64);
        for (k, v) in &m {
            assert_eq!(&t.get(k), v);
        }
    }

    #[test]
    fn colliding_keys_overflow() {
        // Keys with the same low hash bits all land in one bucket and chain across pages.
        let mut buf = vec![0u8; size_for(50)];
        let mut t = Table::init(&mut buf).unwrap();
        for n in 0..40u64 {
            let mut k = [0u8; 32];
            k[8..16].copy_from_slice(&n.to_le_bytes());
            t.set(&k, &val(n)).unwrap();
        }
        assert_eq!(t.check(), 40);
        for n in (0..40u64).rev() {
            let mut k = [0u8; 32];
            k[8..16].copy_from_slice(&n.to_le_bytes());
            assert_eq!(t.get(&k), val(n));
            t.set(&k, &[0; 32]).unwrap();
            t.check();
        }
        assert_eq!(t.count(), 0);
    }
}
