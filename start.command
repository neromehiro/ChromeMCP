#!/bin/zsh
set -eu
cd "$(dirname "$0")"
exec .venv/bin/chrome-bridge serve
