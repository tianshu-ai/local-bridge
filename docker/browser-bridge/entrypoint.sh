#!/bin/bash
set -e

# If args are passed directly (docker run <image> tsbridge --server ...),
# exec them as-is, bypassing env-var mode.
if [ $# -gt 0 ]; then
  exec "$@"
fi

# Env-var mode (docker run -e TIANSHU_SERVER=... -e TIANSHU_TOKEN=...)
if [ -z "$TIANSHU_SERVER" ]; then
  echo "ERROR: pass CLI args or set TIANSHU_SERVER + TIANSHU_TOKEN env"
  echo ""
  echo "Usage:"
  echo "  docker run <image> tianshu-local-bridge --server <ws://...> --token <...> --headless --shell"
  echo "  docker run -e TIANSHU_SERVER=ws://... -e TIANSHU_TOKEN=*** <image>"
  exit 1
fi

exec tianshu-local-bridge \
  --server "$TIANSHU_SERVER" \
  --token "$TIANSHU_TOKEN" \
  --headless \
  --shell \
  ${BRIDGE_NAME:+--name "$BRIDGE_NAME"}
