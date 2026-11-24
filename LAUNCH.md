# Launching Chains on mainnet

Launch day, start to finish. Every on-chain step goes through `scripts/launch.ts`: it prints what it
will do, refuses anything out of order, and only sends with `--send`. The whole sequence is
rehearsed end to end on a local validator by `scripts/rehearse-launch.ts` (see the end of this file):
run that first, on the exact build you are about to deploy.

```
export CHAINS_CLUSTER=mainnet-beta
export CHAINS_RPC=<private mainnet RPC URL>      # never the public one on launch day
export CHAINS_ADMIN=<path to the admin keypair>  # upgrade authority + launch authority
node scripts/launch.ts status                    # run it between every step
```

## What you need first

| | What | Notes |
|---|---|---|
| 1 | **Admin keypair** | Deploys the program and becomes its upgrade authority and the launch authority. Keep it off this repo (like `C:\Users\Admin\chains-keys\`). Fund it with **~10 SOL** (see costs). |
| 2 | **Program id keypair** | `chains-keys/program-v2.json` (`9mmzy5…`) works on mainnet too, or make a new one (then update `declare_id!`, `Anchor.toml`, `idl/`, `scripts/localnet.sh`). |
| 3 | **Treasury** | A Squads multisig **vault** address. Gets half of every chain's fees. **Fixed forever at `init`.** |
| 4 | **Domain** | e.g. `https://chains.xyz/`. NFT metadata lives at `<domain>/chain/<id>.json` and `<domain>/collection.json`. **Fixed forever at `init`.** |
| 5 | **Private RPC** | Helius / Triton / QuickNode. Used by the scripts and by the site (`RPC_URL` on Railway). The snapshot builder reads the whole token history: the public RPC will rate-limit it. |
| 6 | **$CHAINS mint** | From pump.fun. Set once with `set-mint`. |
| 7 | **Decisions** | Audit (SPEC §19 Q6). Whether team or creator wallets are in the snapshot: the builder counts every on-curve wallet (pools, the bonding curve and program vaults are left out automatically). If some wallets must be excluded, say so in the announcement *before* the window, and filter `balances.csv` the same published way. |

**Costs:** program rent ≈ 4.5 SOL (the .so is ~640 KB), plus about as much again held by the deploy
buffer while uploading (returned at the end). `init` ≈ 0.01 SOL. Transactions are cents. Users pay
their own claim (~0.003 SOL) and launch (~0.02 SOL) rent.

**Can never change after `init`:** treasury, fee rate (1 lamport per metered compute unit), URI base,
launch authority. The snapshot root and claims-open time are set once. Check each value character
by character before `--send`.

## 1. Build and deploy the program (T−7 days or earlier)

In WSL:

```
anchor build                     # the real build: NO --features localnet
sha256sum target/deploy/chains.so
solana program deploy target/deploy/chains.so \
  --program-id <program keypair> -k <admin keypair> -u <RPC> \
  --with-compute-unit-price 50000 --max-sign-attempts 50
```

Then `node scripts/launch.ts status` must show `program deployed` and the admin as upgrade authority.
Optionally publish a verifiable build (`solana-verify`) so anyone can match the bytes to the source.

## 2. Initialize

```
node scripts/launch.ts init --treasury <SQUADS VAULT> --uri-base https://<domain>/
node scripts/launch.ts init --treasury <SQUADS VAULT> --uri-base https://<domain>/ --send
```

Only the upgrade authority can initialize, so nobody can front-run this. It also creates the Core
collection (the registry is its update authority).

## 3. The site on mainnet

Railway service `chains`, variables:

```
CLUSTER=mainnet-beta
RPC_URL=<private RPC>
PUBLIC_ORIGIN=https://<domain>
DATA_DIR=/data            # with a Railway volume mounted at /data: history survives redeploys
```

Point the domain at the service (Railway → Settings → Networking → Custom domain). Check
`https://<domain>/collection.json` and `https://<domain>/chain/1.json` load.

## 4. The token

Launch $CHAINS on pump.fun. Then:

```
node scripts/launch.ts set-mint --mint <MINT>            # checks it's a real mint, prints decimals and supply
node scripts/launch.ts set-mint --mint <MINT> --send
```

## 5. Announce the snapshot window (before it opens)

Pick a window of slots in the future, and a reveal slot at least 150 slots after it ends. Slots are
~0.4 s, so e.g. a 24 h window is ~216,000 slots. `status` prints the current slot.

```
node scripts/launch.ts announce --w0 <SLOT> --w1 <SLOT> --reveal <SLOT>
```

This writes `deploy/announcement.mainnet-beta.json`. Commit it and deploy the site: the **Snapshot**
page now shows the window with estimated times. Post the three slot numbers publicly (X, Telegram)
at the same time. From now on nobody, you included, can know or pick the snapshot slot.

## 6. After the reveal slot: pick the slot and build the snapshot

```
node scripts/launch.ts pick-slot      # refuses until the reveal block is finalized
node scripts/launch.ts snapshot       # reads the token's history up to the slot; takes a while
```

Check `deploy/snapshot-mainnet-beta-<slot>/balances.csv`: the biggest holders should be real wallets,
and the bonding curve / pool vaults must show `counted=false`. Anyone can reproduce the slot with
`node tools/snapshot-slot.ts W0 W1 R` and the list with `node indexer/build-snapshot.ts --mint … --slot …`.

Commit `deploy/announcement.mainnet-beta.json`, `deploy/snapshot.mainnet-beta.csv` and
`deploy/snapshot.mainnet-beta.json`, deploy the site, and check the Snapshot page shows the hash and
the download works. **The site must serve this file before claims open**: it builds every claim's
Merkle proof from it.

## 7. Set the snapshot on chain and open claims

Give people time: open claims at least a few hours after publishing the list.

```
node scripts/launch.ts set-snapshot --opens-at 2027-01-15T17:00:00Z
node scripts/launch.ts set-snapshot --opens-at 2027-01-15T17:00:00Z --send
node scripts/launch.ts status         # must say: deploy file matches the root on chain ✓
```

For the first 24 h each listed wallet can claim one chain; then the rest go first come, first served
until all 500 are claimed. The Snapshot page counts down; the claim page goes live by itself.

## 8. After launch

- Watch `status` and the site. Holders launch their own chains from the chain page.
- **Upgrade authority.** Once things are stable, move it to the Squads multisig (or make the program
  immutable). `node scripts/launch.ts handover --to <SQUADS VAULT>` prints the exact command.
- Keep the admin key safe: it stays the launch authority (it can't touch chains or balances; it only
  set the mint and the snapshot, both once).

## Rehearsal (do this first, on the build you will deploy)

```
anchor build                          # WSL, no features
bash scripts/localnet.sh              # WSL; fresh validator, the build loaded with the local admin
node scripts/rehearse-launch.ts       # Windows or WSL
```

It runs steps 2 and 4–7 through `scripts/launch.ts` with throwaway keys and a fake 6-decimal token,
moves tokens after the window (which must not count), puts 300M in a program-owned "bonding curve"
vault (which must not count), checks the snapshot is exactly right, sets it, and claims through the
site's claim API with the one-per-wallet rule. It ends with `✓ launch rehearsal passed`.

`scripts/actions-devnet.ts` rehearses the site's wallet actions (deposit, buy, sell, send, withdraw,
launch, rename, pay out) on devnet with the test wallets.
