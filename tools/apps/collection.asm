; Collection (SPEC §16): an NFT collection inside the chain. Created once with a metadata hash, a
; cap and a price. Anyone can mint by paying the price to the creator. Owners can transfer.
;
; Calldata is 32-byte words: word 0 is the selector, then the arguments.
;   1 create(meta_hash, cap, price)
;   2 mint()                 value = price; returns the new id (1, 2, 3, …)
;   3 transfer(id, to)
;   4 owner_of(id)
;   5 minted()
;
; Storage: 0 creator, 1 metadata hash, 2 cap, 3 price, 4 minted count,
;          keccak(2 ‖ id) = owner of id.
; Registers: r0 = 0, r14 = 32, r15 = 64 throughout.

  const r0, 0
  const r14, 32
  const r15, 64
  calldataload r1, r0
  const r2, 1
  eq r3, r1, r2
  jumpi r3, create
  const r2, 2
  eq r3, r1, r2
  jumpi r3, mint
  const r2, 3
  eq r3, r1, r2
  jumpi r3, xfer
  const r2, 4
  eq r3, r1, r2
  jumpi r3, owner_of
  const r2, 5
  eq r3, r1, r2
  jumpi r3, minted
  const r1, "bad selector"
  revert r1

create:
  const r2, 0
  sload r3, r2
  eq r4, r3, r0              ; once
  require r4
  caller r5
  sstore r2, r5
  calldataload r6, r14
  const r2, 1
  sstore r2, r6              ; metadata hash
  calldataload r6, r15
  lt r4, r0, r6              ; cap > 0
  require r4
  const r2, 2
  sstore r2, r6
  const r7, 96
  calldataload r6, r7
  const r2, 3
  sstore r2, r6              ; price
  const r8, 1
  const r9, "create"
  log3 r9, r5, r0, r6
  return r8

mint:
  const r2, 0
  sload r5, r2               ; creator
  lt r4, r0, r5
  require r4                 ; created
  const r2, 4
  sload r6, r2               ; minted
  const r2, 2
  sload r7, r2               ; cap
  lt r4, r6, r7
  require r4                 ; not sold out
  callvalue r8
  const r2, 3
  sload r9, r2               ; price
  eq r4, r8, r9
  require r4                 ; exact price
  transfer r5, r8            ; to the creator
  const r10, 1
  add r6, r6, r10            ; new id
  const r2, 4
  sstore r2, r6
  caller r11
  const r2, 2
  hash r3, r2, r6
  sstore r3, r11
  const r2, "mint"
  log3 r2, r11, r6, r8
  return r6

xfer:
  calldataload r6, r14       ; id
  calldataload r7, r15       ; to
  const r2, 2
  hash r3, r2, r6
  sload r5, r3
  caller r11
  eq r4, r5, r11
  require r4                 ; caller owns it
  sstore r3, r7
  const r2, "transfer"
  log3 r2, r11, r7, r6
  return r6

owner_of:
  calldataload r6, r14
  const r2, 2
  hash r3, r2, r6
  sload r1, r3
  return r1

minted:
  const r2, 4
  sload r1, r2
  return r1
