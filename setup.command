#!/bin/zsh
set -eu
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install -e .
echo 'セットアップ完了。start.commandでローカルサーバーを起動できます。'
