; Swap (SPEC §16): a constant-product pool of SOL against one token that lives only in this guest's
; storage. The first call seeds it. Buys and sells pay 0.3% to the seeder.
;
; Calldata is 32-byte words: word 0 is the selector, then the arguments.
;   1 seed(name, ticker)    value = starting SOL; mints 1,000,000 tokens into the pool
;   2 buy(min_out)          value = SOL in; returns tokens out
;   3 sell(amount, min_out) returns lamports out
;   4 balance_of(address)
;   5 transfer(to, amount)
;   6 token_reserve()       7 sol_reserve()
;
; Storage: 0 seeder, 1 token reserve, 2 SOL reserve, 3 name, 4 ticker,
;          keccak(1 ‖ holder) = that holder's token balance.
; Registers: r0 = 0, r14 = 32, r15 = 64 throughout.

.equ SUPPLY 1000000
.equ FEE_NUM 3
.equ FEE_DEN 1000

  const r0, 0
  const r14, 32
  const r15, 64
  calldataload r1, r0
  const r2, 1
  eq r3, r1, r2
  jumpi r3, seed
  const r2, 2
  eq r3, r1, r2
  jumpi r3, buy
  const r2, 3
  eq r3, r1, r2
  jumpi r3, sell
  const r2, 4
  eq r3, r1, r2
  jumpi r3, balance_of
  const r2, 5
  eq r3, r1, r2
  jumpi r3, xfer
  const r2, 6
  eq r3, r1, r2
  jumpi r3, token_reserve
  const r2, 7
  eq r3, r1, r2
  jumpi r3, sol_reserve
  const r1, "bad selector"
  revert r1

seed:
  const r2, 0
  sload r3, r2
  eq r4, r3, r0              ; not seeded yet
  require r4
  callvalue r5
  lt r4, r0, r5              ; some SOL
  require r4
  caller r6
  sstore r2, r6              ; seeder
  const r2, 1
  const r7, SUPPLY
  sstore r2, r7              ; token reserve
  const r2, 2
  sstore r2, r5              ; SOL reserve
  calldataload r8, r14
  const r2, 3
  sstore r2, r8              ; name
  calldataload r8, r15
  const r2, 4
  sstore r2, r8              ; ticker
  const r9, "seed"
  log3 r9, r6, r8, r5
  return r7

buy:
  callvalue r5
  lt r4, r0, r5
  require r4
  const r2, 0
  sload r6, r2               ; seeder
  lt r4, r0, r6              ; seeded
  require r4
  const r7, FEE_NUM
  mul r8, r5, r7
  const r7, FEE_DEN
  div r8, r8, r7             ; fee
  sub r9, r5, r8             ; SOL into the pool
  const r2, 1
  sload r10, r2              ; token reserve
  const r2, 2
  sload r11, r2              ; SOL reserve
  add r12, r11, r9
  mul r13, r10, r9
  div r13, r13, r12          ; tokens out
  calldataload r7, r14       ; min_out
  lt r4, r13, r7
  eq r4, r4, r0
  require r4
  lt r4, r0, r13
  require r4
  sub r10, r10, r13
  const r2, 1
  sstore r2, r10
  const r2, 2
  sstore r2, r12
  transfer r6, r8            ; fee to the seeder
  caller r7
  const r2, 1
  hash r3, r2, r7
  sload r1, r3
  add r1, r1, r13
  sstore r3, r1
  const r2, "buy"
  log3 r2, r7, r5, r13
  return r13

sell:
  calldataload r5, r14       ; amount
  lt r4, r0, r5
  require r4
  caller r7
  const r2, 1
  hash r3, r2, r7
  sload r1, r3
  lt r4, r1, r5
  eq r4, r4, r0              ; balance ≥ amount
  require r4
  sub r1, r1, r5
  sstore r3, r1
  const r2, 1
  sload r10, r2              ; token reserve
  const r2, 2
  sload r11, r2              ; SOL reserve
  add r12, r10, r5
  mul r13, r11, r5
  div r13, r13, r12          ; SOL out of the pool
  const r2, 1
  sstore r2, r12
  sub r11, r11, r13
  const r2, 2
  sstore r2, r11
  const r6, FEE_NUM
  mul r8, r13, r6
  const r6, FEE_DEN
  div r8, r8, r6             ; fee
  sub r9, r13, r8            ; to the seller
  calldataload r6, r15       ; min_out
  lt r4, r9, r6
  eq r4, r4, r0
  require r4
  transfer r7, r9
  const r2, 0
  sload r6, r2
  transfer r6, r8            ; fee to the seeder
  const r2, "sell"
  log3 r2, r7, r5, r9
  return r9

balance_of:
  calldataload r7, r14
  const r2, 1
  hash r3, r2, r7
  sload r1, r3
  return r1

xfer:
  calldataload r7, r14       ; to
  calldataload r5, r15       ; amount
  caller r6
  const r2, 1
  hash r3, r2, r6
  sload r1, r3
  lt r4, r1, r5
  eq r4, r4, r0
  require r4
  sub r1, r1, r5
  sstore r3, r1
  hash r3, r2, r7
  sload r1, r3
  add r1, r1, r5
  sstore r3, r1
  const r2, "transfer"
  log3 r2, r6, r7, r5
  return r5

token_reserve:
  const r2, 1
  sload r1, r2
  return r1

sol_reserve:
  const r2, 2
  sload r1, r2
  return r1
