#!/bin/zsh
# Cron/launchd wrapper: run the wheel engine and email only when there are
# orders to place. Configure via .env (copy from .env.example). Safe to run
# daily — --only-if-actionable suppresses no-op days.
set -e
cd "$(dirname "$0")/../.."                         # repo root

set -a
[ -f research/smallcap_live_testing/.env ] && source research/smallcap_live_testing/.env
set +a

# Fall back to ~/.zshrc for the Public key if not set in .env
if [ -z "$PUBLI_API_KEY" ]; then
  export PUBLI_API_KEY=$(grep '^export PUBLI_API_KEY=' ~/.zshrc | sed -E 's/^export PUBLI_API_KEY="?([^"]*)"?/\1/')
fi

ARGS=(--equity "${WHEEL_EQUITY:-100000}" --cash "${WHEEL_CASH:-100000}" --only-if-actionable)
[ -n "$WHEEL_EMAIL_TO" ] && ARGS+=(--email "$WHEEL_EMAIL_TO")
[ -n "$WHEEL_POSITIONS" ] && [ -f "$WHEEL_POSITIONS" ] && ARGS+=(--positions "$WHEEL_POSITIONS")
[ -n "$WHEEL_BAIL" ] && ARGS+=(--bail "$WHEEL_BAIL")

python3 research/smallcap_live_testing/wheel_live.py "${ARGS[@]}" \
  >> research/smallcap_live_testing/orders/run.log 2>&1
