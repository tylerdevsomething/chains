; Recurse: calls itself n times (n = calldata word 0) and returns n. Used to check MAX_DEPTH on chain.
  const r0, 0
  const r3, 1
  calldataload r1, r0
  eq r2, r1, r0
  jumpi r2, done
  sub r4, r1, r3
  address r5
  call r6, r5, r0, r4
  add r7, r6, r3
  return r7
done:
  return r0
