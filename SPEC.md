# Chains — Specification v0 (draft)

Status: draft, nothing deployed. This file is the single source of truth. Anything not written here
is not a rule. Items marked **[decision]** are defaults chosen for the draft and can still change;
everything in §19 is still open.

Design in one line: **a whole chain inside one Solana program. Each chain is an NFT, the 500 chains
go to $CHAINS holders at a snapshot, and inside a chain everything is SOL.**

Inspired by MiniChain on Ethereum. Chains is an independent design for Solana.

---

## 1. Principles

1. **Owners own, they don't control.** A chain's holder earns half its fees, names it and can sell
   it. Nobody, including the holder and us, can pause a chain, change its rules, upgrade a running
   chain's behaviour or touch users' balances while it runs.
2. **Fully backed.** Internal balances (fees included) always add up to `total_deposits`, and the
   chain's account always holds at least that many lamports on top of its rent.
3. **Every operation is a Solana transaction.** No sequencer, no bridge, no validators. Solana gives
   ordering and finality.
4. **Anyone can check.** The snapshot is rebuilt from public transactions, history is a hash chain,
   and every rule the program enforces is written here.
5. **Not faster or cheaper than Solana.** Apps on a chain run slower than native programs. The point is
   owning a chain.

## 2. Constants

| Name | Value | Note |
|---|---|---|
| `MAX_CHAINS` | 500 | Hard cap in the registry |
| `CHAINS_SUPPLY` | 1,000,000,000 | pump.fun fixed supply, 6 decimals (verify on the live mint) |
| `TOKENS_PER_CLAIM` | 1,000,000 $CHAINS | Each full million held at the snapshot = one claim |
| `MIN_EXPIRY` | 30 days | Shortest end date allowed at launch; 0 = never ends |
| `PRIORITY_WINDOW` | 24 hours | After claims open, one chain per wallet for this long (§4) |
| `NAME_MAX` | 24 chars | Letters, digits, hyphens, inner spaces |
| `MAX_STEPS` | 10,000 | Per top-level call; compute is the real ceiling (§10) |
| `MAX_DEPTH` | 8 | Nested guest calls |
| `MAX_CALLDATA` | 800 bytes | Solana's 1,232-byte transaction limit |
| `MAX_CODE` | 10,240 bytes | One code account (§8) |
| `MAX_LOGS` | 32 | Logs per top-level call, else `TooManyLogs` |
| `FEE_OVERHEAD_CU` | 20,000 | **[decision]** Added to measured compute per operation |
| `FEE_LAMPORTS_PER_MCU` | TBD | **[decision]** Lamports per million compute units, frozen at deploy |
| `FEE_SHARE` | 50 / 50 | Chain holder / treasury |

## 3. $CHAINS and the snapshot

$CHAINS is a memecoin launched on pump.fun. Its only job is deciding who can claim chains. It is
never used inside a chain.

1. **Snapshot slot. [decision]** Nobody, including us, knows `S` until it has passed, and anyone
   can check how it was picked:
   - We announce a window of slots `[W0, W1]` and a reveal slot `R` at least 150 slots after `W1`.
   - Once `R` is finalized, `S = W0 + (x mod (W1 − W0 + 1))`. `x` is the first 8 bytes, big-endian,
     of `keccak256("chains:snapshot" ‖ blockhash)`, where `blockhash` is the 32-byte blockhash of
     `R`. If `R` was skipped, the next slot that has a block is used.
   - `tools/snapshot-slot.ts W0 W1 R` computes it.
   - Balances are read as of the end of `S`, from finalized transactions only. If `S` was skipped,
     that's the state after the last block before it.
2. **Who counts.** A wallet's balance is the sum of every $CHAINS token account it owns. Only owners
   that are **on-curve ed25519 keys** count. That leaves out every PDA automatically: the pump.fun
   bonding curve, PumpSwap pool vaults, other program vaults and multisig vaults.
3. **Claims.** `claims = floor(balance / TOKENS_PER_CLAIM)`. 2.5M held = 2 claims. A wallet below
   1M gets nothing.
4. **How it's computed.** `indexer/build-snapshot.ts` finds every token account that ever held
   $CHAINS (from every transaction that touched the mint). Then it reads each account's balance and
   owner from its last transaction at or before `S` (`postTokenBalances`). An account closed by
   then counts as zero. It is deterministic: the same finalized history gives the same table, byte
   for byte. It also publishes every owner's balance, and why any were left out.
5. **Publishing.** The list of `(wallet, claims)` sorted by wallet is published as a file, with its
   SHA-256 and a Merkle root. The root is posted on chain once by `set_snapshot` (§4). Anyone can
   rebuild the file and check the root. Leaf = `keccak256(0x00 ‖ wallet ‖ claims as u32 BE)`,
   node = `keccak256(0x01 ‖ smaller child ‖ larger child)`, leaves in wallet order, an odd node at
   the end of a level moves up unchanged.
6. Total claims will very likely be more than 500. One per wallet comes first, then first come,
   first served (§4).

## 4. The registry and claiming

The **registry** PDA `["registry"]` holds: `launch_authority`, `treasury`, `snapshot_root`,
`snapshot_hash`, `snapshot_slot`, `claims_open_at`, `claimed` (count), `chains_mint` (the $CHAINS
mint), and the Metaplex Core collection.

| Instruction | Who | What |
|---|---|---|
| `initialize(launch_authority, treasury, fee_lamports_per_mcu, uri_base)` | The program's upgrade authority | Creates the registry and the Core collection (update authority = registry PDA). All four values are fixed from then on |
| `set_mint(mint)` | `launch_authority`, once | Records the $CHAINS mint right after it exists |
| `set_snapshot(slot, root, hash, claims_open_at)` | `launch_authority`, once | Fixes the snapshot and when claiming opens (unix seconds). Cannot be changed afterwards |
| `claim(proof, total_claims, n)` | The listed wallet | Mints `n` chain NFTs to the signer |

`claim` rules:

- The proof must show `(signer, total_claims)` is in `snapshot_root`.
- A `ClaimRecord` PDA `["claimed", wallet]` counts how many the wallet has used. `used + n ≤ total_claims`.
- Before `claims_open_at`, claims fail with `ClaimsNotOpen`.
- **[decision] One per wallet first.** For the first `PRIORITY_WINDOW` after `claims_open_at`, each
  wallet can claim one chain in total (`OnePerWallet`). After that, any wallet with claims left can
  use them, first come, first served.
- `claimed + n ≤ MAX_CHAINS`. The 501st claim fails with `SoldOut`.
- Chain ids are given out in order, starting at 1.
- Claiming doesn't spend, burn or lock any $CHAINS.
- The claimer pays the Core asset rent (~0.003 SOL each) and the claim record.

## 5. Launching a chain

A claimed chain is **not launched**. Its holder decides when to launch it.

`launch(id, expiry)`, signed by the Core asset's current owner:

- `expiry` is 0 (never ends) or at least `MIN_EXPIRY` after now. Fixed forever once set.
- Creates the chain header and its state account (§6). The launcher pays their rent.
- Commits block 1 (`"launch"`).

Not launched → Running → Ended (after `expiry`) → Swept (§13).

## 6. Accounts

| Account | Seeds | Holds |
|---|---|---|
| Chain header | `["chain", id]` | id, name, height, head, expiry, total_deposits, fees_accrued, fees_claimed, status, and **all deposited lamports** |
| Chain state | `["state", id]` | One hash table: balances, nonces, guest storage (§7) |
| Code | `["code", id, address]` | One guest's code, immutable once sealed (§8) |
| Claim record | `["claimed", wallet]` | Claims used |

The header itself holds the SOL. A program-owned account can be debited directly, so there's no
separate vault.

**[decision] One state account per chain.** Every write on a chain goes through it, so a chain runs
strictly in order like a real chain. Nothing about state has to be known before a transaction.
Solana limits how much compute one account can take per block, so one chain tops out at very
roughly 20–30 simple app calls a second.

**The table.** Keys are `keccak256(kind ‖ address ‖ slot)` (kind is one byte; slot is zero for
balance, nonce and guest), values are 32 bytes, and zero means absent. Kinds: 0 balance, 1 nonce,
2 storage, 3 guest (set to 1 when code is sealed at that address). It uses linear hashing, so it
grows one bucket at a time and no transaction ever rehashes the whole table. Byte layout:
`programs/chains/src/table.rs`. A fresh chain starts with room for 32 entries.

**Rent.** Space costs rent on Solana (~6.96 SOL per MB). A call that needs new space must be
preceded, in the same transaction, by `grow(id, bytes)`, paid in real SOL by the transaction's fee
payer (up to 10 KB per instruction). Clients find out how much by simulating. Rent is not a chain fee
and goes to nobody; it comes back when the chain is swept (§13).

## 7. The ledger

SOL is the only asset. 1 internal lamport = 1 real lamport held by the header.

| Instruction | Fee | Nonce | Effect |
|---|---|---|---|
| `deposit(id, beneficiary, lamports)` | none | no | Signer sends lamports in; `beneficiary` is credited |
| `withdraw(id, lamports)` + `recipient` account | none | no | Signer's internal balance is debited; real lamports go to `recipient` at once |
| `transact(id, target, value, data, max_steps, max_fee)` | yes | yes | Calls a guest (§9) |
| `read(id, target, data, max_steps)` | none | no | Runs a guest without saving anything; result via return data. Use it through `simulateTransaction` |
| `deploy_*` | yes | yes | §8 |
| `claim_fees(id)` | none | no | §12 |

- An address is a 32-byte Solana public key. The signer of a transaction is the sender.
- **Relaying is built into Solana.** A transaction can have a separate fee payer, so anyone can pay to
  submit someone else's signed call. No signed-message format is needed in v0.
- A failed operation fails the whole Solana transaction: nothing commits, no nonce is used, no
  chain fee is charged. Several instructions in one transaction succeed or fail together.
- A signer whose address holds guest code is rejected.

## 8. Guests

A guest is a program stored on a chain, with its own address, its own storage, and an internal
balance. Guests can hold and move SOL inside the chain. They can read Solana accounts (§9, `ACCOUNTLOAD`)
but never write to anything outside the chain.

**Address.** `keccak256("chains:guest" ‖ chain id as u32 BE ‖ creator ‖ nonce as u64 BE ‖ salt)`.
An occupied address fails with `AddressOccupied`. `deploy_begin` takes the expected address as an
argument and fails with `BadAddress` if it doesn't match.

**Deploying.** Code is too big for one transaction, so it's uploaded in pieces:

1. `deploy_begin(id, salt, len)` creates the code account (deployer pays its rent) and uses a nonce.
2. `deploy_write(id, address, offset, bytes)` writes a piece. Deployer only.
3. `deploy_seal(id, address)` checks the code (§9) and makes it immutable. Commits the `"deploy"`
   block. Optionally followed in the same transaction by a first `transact` (deploy-and-call).

Code is never edited or deleted. A transaction that calls guests must list their code accounts
(read-only). A call to a guest whose code account isn't listed fails with `MissingCode(address)`.
Clients find the list by simulating.

## 9. MiniVM

The only engine in v0 (kind 1). 16 registers `r0`–`r15`, each 256 bits, zeroed at the start of each
call. A Solana public key is exactly one word.

**Encoding.** Each instruction starts with 4 bytes: opcode, A, B, C. Reserved bytes must be zero.
`CONST` is 36 bytes (4 + a 32-byte big-endian value). `CALL`, `LOG3`, `LOG4`, `ACCOUNTLOAD` are
8 bytes (4 + register D + 3 zero bytes). `JUMP`/`JUMPI` carry an absolute byte offset in B‖C that
must start an instruction. Everything else is 4 bytes.

`deploy_seal` rejects bad opcodes, registers, reserved bytes and jump targets (`InvalidCode(pc)`,
`InvalidOpcode(pc, op)`).

| Hex | Op | Effect |
|---|---|---|
| 00 | STOP | Return nothing |
| 01 | CONST A, v | A = v |
| 02 | MOV A, B | A = B |
| 03–05 | ADD / SUB / MUL | Wrapping mod 2^256 |
| 06 | DIV | B / C, or 0 if C = 0 |
| 07 / 08 | EQ / LT | 1 or 0 |
| 09–0b | AND / OR / XOR | Bitwise |
| 0c | NOT A, B | Bitwise not |
| 0d / 0e | SHL / SHR | 0 for shifts ≥ 256 |
| 10 | CALLER A | The calling address |
| 11 | ADDRESS A | Own address |
| 12 | CALLVALUE A | Lamports sent with the call |
| 13 | CALLDATALOAD A, B | 32 bytes of input at offset B, zero padded |
| 14 | CALLDATASIZE A | Input length |
| 15 | BALANCE A, B | Internal balance of address B |
| 16 | SLOAD A, B | A = storage[B] |
| 17 | SSTORE A, B | storage[A] = B |
| 18 | TRANSFER A, B | Send B lamports to address A; no code runs |
| 19 | REQUIRE A | Fail if A = 0 |
| 1a | RETURN A | Return one word |
| 1b | REVERT A | Fail with one word |
| 20 | JUMP L | A must be 0 |
| 21 | JUMPI A, L | Jump if A ≠ 0 |
| 22 | CALL A, B, C, D | Call guest B with C lamports and one input word D; A = first word returned |
| 23 | HASH A, B, C | A = keccak256(B ‖ C) |
| 24 | LOG3 A, B, C, D | Topics A, B, C; data D |
| 25 | LOG4 A, B, C, D | Four topics, no data |
| 30 | ACCOUNTLOAD A, B, C, D | A = 32 bytes at offset C of the Solana account whose key is in B; D must be 0. The account must be listed in the transaction (read-only), else `MissingAccount` |

- A failed `CALL` fails the caller; MiniVM can't catch it. Depth limit `MAX_DEPTH`.
- `read` frames reject `SSTORE`, logs and any value transfer (`StaticViolation`).
- Logs are emitted as program events through a self-CPI, so they are never cut off.

## 10. Steps and compute

- Every instruction costs one step. `1 ≤ max_steps ≤ MAX_STEPS`, else `InvalidStepBudget`.
  Nested calls share the budget. Running out fails with `StepLimit`.
- Steps limit work but don't price it. A Solana transaction gets at most 1.4M compute units, and
  that is usually hit first. Rough guide: 300–1,500 CU a step, so ~1,000–3,000 steps per transaction.
  The example apps (§16) need under 50. Measured on localnet (2026-11-23): a Swap buy or sell, or a
  Collection mint, costs 35–40k CU for the whole transaction, logs and history included.

## 11. Fees

Each `transact` and `deploy_seal` pays a chain fee in SOL from the sender's internal balance:

```
fee = (units + FEE_OVERHEAD_CU) × FEE_LAMPORTS_PER_MCU / 1,000,000
```

- `units` is metered from a fixed schedule, because the `sol_remaining_compute_units` syscall is not
  active on devnet or mainnet (checked 2026-11-23):
  - `transact`: 250 per step, 150 per table read, 300 per table write (the fee transfer counts as 2),
    2,000 per log, and 1 per calldata byte.
  - `deploy_seal`: 7 per code byte, plus the same read and write costs.
  - `FEE_OVERHEAD_CU` = 20,000 covers the rest: transaction base cost, events and history.
  The schedule was calibrated on localnet against real compute and is within about ±30% for the
  example apps. It is part of the program, so it is frozen like the rate.
- The sender sets `max_fee`. A higher fee fails with `FeeTooHigh`; a short balance fails with
  `InsufficientBalance`.
- Deposits, withdrawals, reads and fee claims pay no chain fee. Failed operations pay nothing.
- The rate is frozen at deploy. Nobody can change it.
- The fee is credited to the chain's own address inside the ledger (`fees_accrued`).

## 12. Claiming fees

`claim_fees(id)`, anyone can call it:

- Pays half of the unclaimed fees to the chain's **current** Core asset owner and half to the
  `treasury` (odd lamport to the holder). Both are real lamports out of the header.
- Fails with `ZeroAmount` if nothing has built up, `ChainEnded` after the end date.

## 13. End dates and sweep

- A chain launched with an `expiry` stops at that time: no deposits, calls or withdrawals. `read`
  still works.
- After that, anyone can call `sweep(id)`:
  1. the treasury's half of unclaimed fees is paid to the treasury;
  2. **everything else in the header, including other users' balances, goes to the chain's holder**;
  3. the state account is closed and its rent goes to the holder too;
  4. the header stays, with the final head and height. Code accounts stay readable. The art turns grey.
- The site shows a chain's end date on every page that takes a deposit, in plain words.

## 14. History

- `height` goes up by 1 for each committed operation.
- `head_n = keccak256(head_{n-1} ‖ n ‖ op_hash)`, and each commit emits `BlockCommitted(id, n, prev, head, op_hash)`.
- `op_hash = keccak256(tag ‖ fields…)`. `n` and integer fields are big-endian (u64/i64 as 8 bytes,
  `kind` as 1 byte); keys and hashes are 32 bytes. `keccak256(result)` is over the 32-byte word, or
  over nothing if the guest returned nothing.

| Operation | Fields |
|---|---|
| `"launch"` | holder, expiry |
| `"deposit"` | payer, beneficiary, lamports |
| `"withdraw"` | account, recipient, lamports |
| `"deploy"` | creator, nonce, address, kind, keccak256(code) |
| `"transaction"` | from, to, value, nonce, max_steps, keccak256(data), keccak256(result) |
| `"claim"` | holder, treasury, lamports |

- One Solana transaction can commit several blocks.
- The head commits to history, not to state. There's no state root in v0.

## 15. The chain NFT

**[decision] Metaplex Core.** Each chain is a Core asset in the Chains collection, so it shows in
wallets and marketplaces. Holding the asset = owning the chain.

- The holder can `set_name(id, name)` (≤ 24 chars, letters, digits, hyphens, spaces not at either
  end; empty clears it). Names aren't unique.
- The asset's URI points to the renderer: `https://<site>/chain/<id>.json`, which builds the image as
  an SVG from the chain's live on-chain state. (Core URIs are capped at 200 characters, so the image
  can't be stored in the asset.)
- The art:
  - **Stone and cut:** from `keccak256(id)`.
  - **Facets:** added at 10, 100, 1,000 and 10,000 operations.
  - **Size:** grows with SOL held, on a log scale.
  - **Glints:** one at the start, plus one each time fees earned double, up to ten.
  - **Ended:** the stone goes grey.
- Holders can't change fees, pause, upgrade, move the end date or touch balances.

## 16. Example apps

Shipped with the assembler and used in the rehearsal.

- **Swap:** a constant-product pool of SOL against one token that lives only in the pool's storage.
  The first call seeds it (name, ticker, 1,000,000 tokens). Buy and sell pay 0.3% to the seeder.
- **Collection:** an NFT collection inside the chain. Created once with a metadata hash, a cap and a
  price. Anyone can mint by paying the price to the creator. Owners can transfer.

## 17. Off-chain parts

| Part | What |
|---|---|
| `programs/chains` | The Anchor program: registry, claims, chains, MiniVM |
| `indexer/` | Snapshot builder (§3), chain follower, explorer API, live stream |
| `renderer/` | Core asset JSON + SVG art from on-chain state |
| `site/` | The Chains page: overview, own a chain, all chains, explorer, claim |
| `tools/asm.ts` | MiniVM assembler and disassembler |
| `tools/` | Rehearsal on localnet, snapshot build and check, launch |

## 18. Not in v0

- **EVM engine.** Possible in principle: an interpreter with a 1,024-word stack and up to 64 KB of
  memory on a requested larger heap, `SHA3` on the keccak syscall, storage in the same table. But an
  EVM opcode costs ~200–2,000 CU here, so a Uniswap-sized call (millions of CU) needs resumable
  execution: the call runs in slices across several transactions, saving pc, stack and memory to a
  frame account and locking the chain until the last slice commits. EVM addresses (20 bytes) would map
  to Solana keys (32 bytes) through a lookup table. Too big for v0.
- **Extra engines** run as calls into other Solana programs.
- **Signed offline requests** (sign now, anyone submits later) with the ed25519 precompile.
- **State root** so balances can be proven against the head.

## 19. Open questions

1. ~~Snapshot timing.~~ Decided 2026-11-23: a window, with the slot picked from a later blockhash (§3).
2. ~~First come, first served.~~ Decided 2026-11-23: one per wallet for the first 24 hours, then
   first come, first served (§4).
3. **Treasury half.** Draft: half of every chain's fees goes to a treasury address (multisig) fixed at
   deploy. MiniChain gives it to chain #1's holder instead.
4. **The fee rate** `FEE_LAMPORTS_PER_MCU`. Solana fees are tiny, so holders earn little unless a
   chain is busy.
5. **Sweep** sends users' leftover balances to the holder (as in MiniChain). Keep, or return each
   balance to its owner (costs a claim instruction per user)?
6. **Audit** before mainnet.
