#!/usr/bin/env bash
# Deploy the yammbo-social Worker. Reads the CF credentials at runtime so neither
# the token nor the account id appears in a tool/bash command line, and so the
# account id stays out of the public repo.
set -euo pipefail
cd /root/repos/yammbo-social
export CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)"
export CLOUDFLARE_ACCOUNT_ID="$(cat /root/.cloudflare-account-id)"
npx wrangler deploy "$@"
