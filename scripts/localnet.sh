#!/usr/bin/env bash
# Starts a fresh local validator with Chains and Metaplex Core loaded at genesis (WSL or Linux).
# Build first with the test caps:  anchor build -- --features localnet
# Every start wipes the previous chain. Metaplex Core is fetched once from mainnet (read-only) into
# $WORK/mpl_core.so. Chains is loaded upgradeable with the local admin key as its upgrade
# authority: only that key can initialize it, as on a real deployment.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HOME/chains-build}"
ADMIN="${LOCAL_ADMIN:-/mnt/c/Users/Admin/chains-keys/localnet-admin.json}"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p "$WORK"
[ -f "$WORK/mpl_core.so" ] || solana program dump -u https://api.mainnet-beta.solana.com CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d "$WORK/mpl_core.so"
exec solana-test-validator --reset --quiet --ledger "$WORK/test-ledger" \
  --upgradeable-program 9mmzy5stpZfxmtQTWFC1fDDhWn8FwYMTwWTAkv5tLb3N "$REPO/target/deploy/chains.so" "$ADMIN" \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d "$WORK/mpl_core.so"
