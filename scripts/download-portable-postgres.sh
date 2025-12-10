#!/bin/bash

# 自動下載並設定可攜式 PostgreSQL（無需系統安裝）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
POSTGRES_DIR="$PROJECT_DIR/postgres"
BIN_DIR="$POSTGRES_DIR/bin"
DATA_DIR="$POSTGRES_DIR/data"
LOG_DIR="$POSTGRES_DIR/logs"
VERSION="16.2"

# 顏色輸出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 開始設定可攜式 PostgreSQL...${NC}"

# 檢測系統架構
ARCH=$(uname -m)
OS=$(uname -s)

echo "🔍 檢測系統: $OS $ARCH"

# 確定下載 URL（macOS）
if [[ "$OS" == "Darwin" ]]; then
    if [[ "$ARCH" == "arm64" ]]; then
        # Apple Silicon
        DOWNLOAD_URL="https://get.enterprisedb.com/postgresql/postgresql-${VERSION}-1-osx-arm64-binaries.zip"
        ARCHIVE_NAME="postgresql-${VERSION}-1-osx-arm64-binaries.zip"
    else
        # Intel
        DOWNLOAD_URL="https://get.enterprisedb.com/postgresql/postgresql-${VERSION}-1-osx-x86_64-binaries.zip"
        ARCHIVE_NAME="postgresql-${VERSION}-1-osx-x86_64-binaries.zip"
    fi
else
    echo -e "${RED}❌ 此腳本目前僅支援 macOS${NC}"
    exit 1
fi

mkdir -p "$POSTGRES_DIR"
cd "$POSTGRES_DIR"

# 檢查是否已下載
if [ -f "$BIN_DIR/psql" ]; then
    echo -e "${GREEN}✅ PostgreSQL 二進制檔案已存在${NC}"
else
    echo -e "${YELLOW}📥 下載 PostgreSQL...${NC}"
    
    # 下載
    if command -v curl &> /dev/null; then
        curl -L -o "$ARCHIVE_NAME" "$DOWNLOAD_URL"
    elif command -v wget &> /dev/null; then
        wget -O "$ARCHIVE_NAME" "$DOWNLOAD_URL"
    else
        echo -e "${RED}❌ 需要 curl 或 wget 來下載檔案${NC}"
        exit 1
    fi
    
    echo -e "${YELLOW}📦 解壓縮...${NC}"
    unzip -q "$ARCHIVE_NAME" -d .
    rm "$ARCHIVE_NAME"
    
    # 移動到 bin 目錄
    EXTRACTED_DIR=$(find . -maxdepth 1 -type d -name "pgsql*" | head -1)
    if [ -d "$EXTRACTED_DIR" ]; then
        mv "$EXTRACTED_DIR/bin" "$BIN_DIR"
        mv "$EXTRACTED_DIR/share" "$POSTGRES_DIR/share" 2>/dev/null || true
        rm -rf "$EXTRACTED_DIR"
    fi
    
    echo -e "${GREEN}✅ PostgreSQL 下載完成${NC}"
fi

# 初始化資料庫
if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    echo -e "${YELLOW}🔧 初始化資料庫...${NC}"
    "$BIN_DIR/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust
    
    # 設定配置
    echo "listen_addresses = 'localhost'" >> "$DATA_DIR/postgresql.conf"
    echo "port = 5432" >> "$DATA_DIR/postgresql.conf"
    echo "max_connections = 100" >> "$DATA_DIR/postgresql.conf"
    
    echo "host all all 127.0.0.1/32 trust" >> "$DATA_DIR/pg_hba.conf"
    echo "host all all ::1/128 trust" >> "$DATA_DIR/pg_hba.conf"
    
    echo -e "${GREEN}✅ 資料庫已初始化${NC}"
else
    echo -e "${GREEN}✅ PostgreSQL 資料目錄已存在${NC}"
fi

# 啟動 PostgreSQL
if ! "$BIN_DIR/pg_ctl" -D "$DATA_DIR" status &> /dev/null; then
    echo -e "${YELLOW}🚀 啟動 PostgreSQL...${NC}"
    mkdir -p "$LOG_DIR"
    "$BIN_DIR/pg_ctl" -D "$DATA_DIR" -l "$LOG_DIR/postgres.log" start
    sleep 2
    echo -e "${GREEN}✅ PostgreSQL 已啟動${NC}"
else
    echo -e "${GREEN}✅ PostgreSQL 已在運行${NC}"
fi

# 建立資料庫和使用者
echo -e "${YELLOW}📝 設定資料庫和使用者...${NC}"

# 讀取 .env
if [ -f "$PROJECT_DIR/.env" ]; then
    source <(grep -E '^DB_' "$PROJECT_DIR/.env" | sed 's/^/export /')
fi

DB_NAME="${DB_NAME:-ba_system}"
DB_USER="${DB_USER:-postgres}"

# 建立資料庫
"$BIN_DIR/psql" -U "$(whoami)" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
    "$BIN_DIR/psql" -U "$(whoami)" -d postgres -c "CREATE DATABASE $DB_NAME;"

# 建立使用者（如果不存在）
"$BIN_DIR/psql" -U "$(whoami)" -d postgres -tc "SELECT 1 FROM pg_user WHERE usename = '$DB_USER'" | grep -q 1 || \
    "$BIN_DIR/psql" -U "$(whoami)" -d postgres -c "CREATE USER $DB_USER WITH SUPERUSER PASSWORD 'postgres';"

# 授予權限
"$BIN_DIR/psql" -U "$(whoami)" -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"
"$BIN_DIR/psql" -U "$(whoami)" -d $DB_NAME -c "GRANT ALL ON SCHEMA public TO $DB_USER;"

echo ""
echo -e "${GREEN}🎉 可攜式 PostgreSQL 設定完成！${NC}"
echo ""
echo "連線資訊:"
echo "  Host: 127.0.0.1"
echo "  Port: 5432"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo "  Password: postgres"
echo ""
echo "使用方式:"
echo "  啟動: $BIN_DIR/pg_ctl -D $DATA_DIR start"
echo "  停止: $BIN_DIR/pg_ctl -D $DATA_DIR stop"
echo "  連線: $BIN_DIR/psql -U $DB_USER -d $DB_NAME"
