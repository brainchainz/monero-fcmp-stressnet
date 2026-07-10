#!/bin/sh
# Ensure data directories exist inside mounted volumes.
# Umbrel creates mount points as root, so we run as root
# and let the daemon create subdirectories with proper ownership.
mkdir -p /data/testnet
mkdir -p /home/monero/wallet
mkdir -p /home/monero/spammer-wallet

exec monerod "$@"
