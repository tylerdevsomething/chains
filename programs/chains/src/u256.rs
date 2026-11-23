//! A 256-bit unsigned word for MiniVM (§9). Arithmetic wraps mod 2^256. Little-endian limbs inside,
//! big-endian bytes outside (a Solana public key is one word, byte for byte).

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);
    pub const ONE: U256 = U256([1, 0, 0, 0]);

    pub fn from_u64(v: u64) -> U256 {
        U256([v, 0, 0, 0])
    }

    pub fn from_be(b: &[u8; 32]) -> U256 {
        let mut l = [0u64; 4];
        for (i, limb) in l.iter_mut().enumerate() {
            let s = 32 - 8 * (i + 1);
            *limb = u64::from_be_bytes(b[s..s + 8].try_into().unwrap());
        }
        U256(l)
    }

    pub fn to_be(&self) -> [u8; 32] {
        let mut b = [0u8; 32];
        for i in 0..4 {
            let s = 32 - 8 * (i + 1);
            b[s..s + 8].copy_from_slice(&self.0[i].to_be_bytes());
        }
        b
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0; 4]
    }

    /// The value as a u64, if it fits.
    pub fn as_u64(&self) -> Option<u64> {
        if self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0 {
            Some(self.0[0])
        } else {
            None
        }
    }

    fn as_u128(&self) -> Option<u128> {
        if self.0[2] == 0 && self.0[3] == 0 {
            Some(self.0[0] as u128 | (self.0[1] as u128) << 64)
        } else {
            None
        }
    }

    fn from_u128(v: u128) -> U256 {
        U256([v as u64, (v >> 64) as u64, 0, 0])
    }

    pub fn add(&self, o: &U256) -> U256 {
        let mut r = [0u64; 4];
        let mut carry = false;
        for i in 0..4 {
            let (s1, c1) = self.0[i].overflowing_add(o.0[i]);
            let (s2, c2) = s1.overflowing_add(carry as u64);
            r[i] = s2;
            carry = c1 || c2;
        }
        U256(r)
    }

    pub fn sub(&self, o: &U256) -> U256 {
        let mut r = [0u64; 4];
        let mut borrow = false;
        for i in 0..4 {
            let (d1, b1) = self.0[i].overflowing_sub(o.0[i]);
            let (d2, b2) = d1.overflowing_sub(borrow as u64);
            r[i] = d2;
            borrow = b1 || b2;
        }
        U256(r)
    }

    pub fn mul(&self, o: &U256) -> U256 {
        let mut r = [0u64; 4];
        for i in 0..4 {
            let mut carry: u128 = 0;
            for j in 0..(4 - i) {
                let cur = r[i + j] as u128 + (self.0[i] as u128) * (o.0[j] as u128) + carry;
                r[i + j] = cur as u64;
                carry = cur >> 64;
            }
        }
        U256(r)
    }

    /// Integer division; 0 when dividing by 0.
    pub fn div(&self, o: &U256) -> U256 {
        if o.is_zero() {
            return U256::ZERO;
        }
        if let (Some(a), Some(b)) = (self.as_u128(), o.as_u128()) {
            return U256::from_u128(a / b);
        }
        if self.lt(o) {
            return U256::ZERO;
        }
        // Shift-subtract long division, from the dividend's top set bit down.
        let mut q = U256::ZERO;
        let mut r = U256::ZERO;
        for bit in (0..self.bits()).rev() {
            r = r.shl_n(1);
            if self.bit(bit) {
                r.0[0] |= 1;
            }
            if !r.lt(o) {
                r = r.sub(o);
                q.0[bit / 64] |= 1 << (bit % 64);
            }
        }
        q
    }

    fn bit(&self, i: usize) -> bool {
        self.0[i / 64] >> (i % 64) & 1 == 1
    }

    fn bits(&self) -> usize {
        for i in (0..4).rev() {
            if self.0[i] != 0 {
                return 64 * i + 64 - self.0[i].leading_zeros() as usize;
            }
        }
        0
    }

    pub fn lt(&self, o: &U256) -> bool {
        for i in (0..4).rev() {
            if self.0[i] != o.0[i] {
                return self.0[i] < o.0[i];
            }
        }
        false
    }

    pub fn and(&self, o: &U256) -> U256 {
        U256([self.0[0] & o.0[0], self.0[1] & o.0[1], self.0[2] & o.0[2], self.0[3] & o.0[3]])
    }

    pub fn or(&self, o: &U256) -> U256 {
        U256([self.0[0] | o.0[0], self.0[1] | o.0[1], self.0[2] | o.0[2], self.0[3] | o.0[3]])
    }

    pub fn xor(&self, o: &U256) -> U256 {
        U256([self.0[0] ^ o.0[0], self.0[1] ^ o.0[1], self.0[2] ^ o.0[2], self.0[3] ^ o.0[3]])
    }

    pub fn not(&self) -> U256 {
        U256([!self.0[0], !self.0[1], !self.0[2], !self.0[3]])
    }

    fn shl_n(&self, n: usize) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let (w, b) = (n / 64, n % 64);
        let mut r = [0u64; 4];
        for i in (w..4).rev() {
            r[i] = self.0[i - w] << b;
            if b > 0 && i > w {
                r[i] |= self.0[i - w - 1] >> (64 - b);
            }
        }
        U256(r)
    }

    fn shr_n(&self, n: usize) -> U256 {
        if n >= 256 {
            return U256::ZERO;
        }
        let (w, b) = (n / 64, n % 64);
        let mut r = [0u64; 4];
        for i in 0..(4 - w) {
            r[i] = self.0[i + w] >> b;
            if b > 0 && i + w + 1 < 4 {
                r[i] |= self.0[i + w + 1] << (64 - b);
            }
        }
        U256(r)
    }

    /// self << n; 0 for n ≥ 256.
    pub fn shl(&self, n: &U256) -> U256 {
        match n.as_u64() {
            Some(k) if k < 256 => self.shl_n(k as usize),
            _ => U256::ZERO,
        }
    }

    /// self >> n; 0 for n ≥ 256.
    pub fn shr(&self, n: &U256) -> U256 {
        match n.as_u64() {
            Some(k) if k < 256 => self.shr_n(k as usize),
            _ => U256::ZERO,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MAX: U256 = U256([u64::MAX; 4]);
    fn u(v: u64) -> U256 {
        U256::from_u64(v)
    }

    #[test]
    fn bytes_round_trip() {
        let mut b = [0u8; 32];
        for (i, x) in b.iter_mut().enumerate() {
            *x = i as u8;
        }
        assert_eq!(U256::from_be(&b).to_be(), b);
        assert_eq!(u(0x0102).to_be()[30..], [1, 2]);
    }

    #[test]
    fn wrapping() {
        assert_eq!(MAX.add(&u(1)), U256::ZERO);
        assert_eq!(U256::ZERO.sub(&u(1)), MAX);
        assert_eq!(MAX.mul(&MAX), u(1)); // (2^256-1)^2 ≡ 1
        assert_eq!(u(1).shl(&u(255)).mul(&u(2)), U256::ZERO);
        assert_eq!(u(u64::MAX).add(&u(1)), U256([0, 1, 0, 0]));
    }

    #[test]
    fn division() {
        assert_eq!(u(7).div(&U256::ZERO), U256::ZERO);
        assert_eq!(u(7).div(&u(2)), u(3));
        assert_eq!(MAX.div(&MAX), u(1));
        assert_eq!(MAX.div(&u(1)), MAX);
        let big = u(1).shl(&u(200));
        assert_eq!(big.div(&u(1).shl(&u(130))), u(1).shl(&u(70)));
        let x = big.add(&u(12345));
        let d = u(1).shl(&u(140)).add(&u(99));
        let q = x.div(&d);
        let rem = x.sub(&q.mul(&d));
        assert!(rem.lt(&d));
    }

    #[test]
    fn shifts_and_compare() {
        assert_eq!(u(1).shl(&u(256)), U256::ZERO);
        assert_eq!(MAX.shr(&u(256)), U256::ZERO);
        assert_eq!(MAX.shr(&MAX), U256::ZERO);
        assert_eq!(u(1).shl(&u(64)), U256([0, 1, 0, 0]));
        assert_eq!(U256([0, 1, 0, 0]).shr(&u(1)), u(1 << 63));
        assert_eq!(MAX.shr(&u(255)), u(1));
        assert!(u(1).lt(&u(2)) && !u(2).lt(&u(2)) && u(5).lt(&U256([0, 0, 0, 1])));
        assert_eq!(U256::ZERO.not(), MAX);
    }
}
