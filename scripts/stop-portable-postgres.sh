#!/bin/bash

# 停止專案目錄中的可攜式 PostgreSQL

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POSTGRES_DIR="$PROJECT_DIR/postgres"
BIN_DIR="$POSTGRES_DIR/bin"
DATA_DIR="$POSTGRES_DIR/data"

if [ ! -f "$BIN_DIR/pg_ctl" ]; then
    echo "❌ PostgreSQL 尚未下載"
    exit 1
fi

if "$BIN_DIR/pg_ctl" -D "$DATA_DIR" status &> /dev/null; then
    echo "🛑 停止 PostgreSQL..."
    "$BIN_DIR/pg_ctl" -D "$DATA_DIR" stop
    echo "✅ PostgreSQL 已停止"
else
    echo "✅ PostgreSQL 未運行"
fi
