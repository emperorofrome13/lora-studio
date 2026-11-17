#!/bin/sh
# Stop LoRA Studio on macOS and Linux. Run:  sh stop.sh
cd "$(dirname "$0")" || exit 1
node stop.mjs
