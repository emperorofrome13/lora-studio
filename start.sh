#!/bin/sh
# LoRA Studio for macOS and Linux. Run:  sh start.sh
# Starts the server in the background and opens it in Google Chrome (or your default browser).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 20 or newer from https://nodejs.org, then run this again."
  exit 1
fi
node launch.mjs "$@"
