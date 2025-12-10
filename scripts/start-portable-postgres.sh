#!/bin/bash

# 啟動專案目錄中的可攜式 PostgreSQL

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POSTGRES_DIR="$PROJECT_DIR/postgres"
BIN_DIR="$POSTGRES_DIR/bin"
DATA_DIR="$POSTGRES_DIR/data"
LOG_DIR="$POSTGRES_DIR/logs"

if [ ! -f "$BIN_DIR/pg_ctl" ]; then
    echo "❌ PostgreSQL 尚未下載"
    echo "請先執行: ./scripts/download-portable-postgres.sh"
    exit 1
fi

if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    echo "❌ 資料庫尚未初始化"
    echo "請先執行: ./scripts/download-portable-postgres.sh"
    exit 1
fi

if "$BIN_DIR/pg_ctl" -D "$DATA_DIR" status &> /dev/null; then
    echo "✅ PostgreSQL 已在運行"
else
    echo "🚀 啟動 PostgreSQL..."
    mkdir -p "$LOG_DIR"
    "$BIN_DIR/pg_ctl" -D "$DATA_DIR" -l "$LOG_DIR/postgres.log" start
    sleep 1
    echo "✅ PostgreSQL 已啟動"
fi
