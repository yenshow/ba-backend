# PostgreSQL 資料庫設定與遷移指南

## 概述

專案使用 PostgreSQL 作為資料庫，並支援**可攜式 PostgreSQL**（無需系統安裝）。這是純 PostgreSQL 實現，不包含任何 MySQL 兼容層。

**主要特點**：

- ✅ **完全開源**：使用 GitHub 開源二進制檔案，無需登入
- ✅ **跨平台支援**：macOS、Windows、Linux
- ✅ **自動下載**：腳本自動檢測平台並下載對應二進制檔案
- ✅ **可攜式**：所有檔案都在專案目錄中，無需系統安裝

## 快速開始

### 1. 安裝依賴

```bash
npm install
```

這會安裝 `pg` 套件（PostgreSQL 驅動程式）。

### 2. 下載並設定可攜式 PostgreSQL（只需一次）

```bash
npm run postgres:download
```

這個腳本會：

- **自動檢測作業系統**（macOS、Windows、Linux）
- 自動下載對應平台的 PostgreSQL 二進制檔案到 `postgres/` 目錄
- 初始化資料庫
- 建立資料庫和使用者
- 啟動 PostgreSQL 服務

**支援的平台**：

| 平台    | 架構                  | 目標標識符 (Target Triple)  |
| ------- | --------------------- | --------------------------- |
| macOS   | ARM64 (Apple Silicon) | `aarch64-apple-darwin`      |
| macOS   | x86_64 (Intel)        | `x86_64-apple-darwin`       |
| Windows | x64                   | `x86_64-pc-windows-msvc`    |
| Linux   | x64                   | `x86_64-unknown-linux-gnu`  |
| Linux   | ARM64                 | `aarch64-unknown-linux-gnu` |

### 3. 啟動 PostgreSQL（之後每次使用）

```bash
npm run postgres:start
```

### 4. 初始化資料庫 Schema

```bash
npm run db:init
```

### 5. 測試連線

```bash
npm run db:test
```

### 6. 啟動應用程式

```bash
npm run dev
```

## 主要變更（從 MySQL 遷移）

### 1. 資料庫驅動程式

- **之前**: `mysql2` (MySQL)
- **現在**: `pg` (PostgreSQL)

### 2. SQL 語法變更

| MySQL                         | PostgreSQL                          |
| ----------------------------- | ----------------------------------- |
| `AUTO_INCREMENT`              | `SERIAL` 或 `BIGSERIAL`             |
| `INT UNSIGNED`                | `INTEGER` (無 UNSIGNED)             |
| `ENUM`                        | PostgreSQL 的 `ENUM` 類型           |
| `ON UPDATE CURRENT_TIMESTAMP` | 使用觸發器實現                      |
| `INSERT IGNORE`               | `INSERT ... ON CONFLICT DO NOTHING` |
| `?` 佔位符                    | `$1, $2, ...` (自動轉換)            |
| `result.insertId`             | `result[0].id` (使用 RETURNING)     |
| `result.affectedRows`         | `result.rowCount`                   |

### 3. 資料庫架構

所有表結構已轉換為 PostgreSQL 格式：

- `users` - 用戶表
- `modbus_device_types` - 設備類型表
- `modbus_device_models` - 設備型號表
- `modbus_ports` - 端口配置表
- `devices` - 設備表（包含 `config` JSONB 欄位）
- `modbus_device_addresses` - 設備地址表
- `device_data_logs` - 資料日誌表
- `device_alerts` - 告警記錄表

## 環境變數設定

在 `.env` 檔案中設定：

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=ba_system
```

## 常用指令

```bash
# PostgreSQL 管理
npm run postgres:download  # 下載並設定（只需一次）
npm run postgres:start     # 啟動 PostgreSQL
npm run postgres:stop      # 停止 PostgreSQL

# 資料庫操作
npm run db:init            # 初始化 Schema
npm run db:test            # 測試連線
npm run db:backup          # 備份資料
npm run db:cleanup         # 清理舊資料
npm run admin:create       # 建立管理員
```

## 可攜式 PostgreSQL 詳情

### 下載來源

使用 [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries) GitHub 專案提供的開源二進制檔案：

- ✅ **完全開源**：無需登入或註冊
- ✅ **跨平台支援**：macOS、Windows、Linux
- ✅ **自動下載**：腳本會自動從 GitHub Releases 下載
- ✅ **版本齊全**：支援多個 PostgreSQL 版本

### 下載 URL 格式

```
https://github.com/theseus-rs/postgresql-binaries/releases/download/v{VERSION}/postgresql-{VERSION}-{TARGET_TRIPLE}.tar.gz
```

例如：

- macOS ARM64: `https://github.com/theseus-rs/postgresql-binaries/releases/download/v16.2/postgresql-16.2-aarch64-apple-darwin.tar.gz`
- Windows x64: `https://github.com/theseus-rs/postgresql-binaries/releases/download/v16.2/postgresql-16.2-x86_64-pc-windows-msvc.tar.gz`
- Linux x64: `https://github.com/theseus-rs/postgresql-binaries/releases/download/v16.2/postgresql-16.2-x86_64-unknown-linux-gnu.tar.gz`

### 目錄結構

```
postgres/
├── bin/          # PostgreSQL 執行檔
├── lib/          # 共享庫
├── data/         # 資料庫資料
├── logs/         # 日誌檔案
└── share/        # 共享檔案
```

### 版本管理

當前使用的 PostgreSQL 版本定義在 `scripts/download-portable-postgres.js`：

```javascript
const VERSION = "16.2"; // 對應 GitHub Releases 標籤 v16.2
```

要更改版本，請：

1. 檢查 [GitHub Releases](https://github.com/theseus-rs/postgresql-binaries/releases) 是否有該版本
2. 更新 `VERSION` 常數
3. 重新執行下載腳本

### 技術實現

#### 跨平台腳本

使用 **Node.js** 腳本而非 shell 腳本，確保在所有平台上都能運行：

- `scripts/download-portable-postgres.js` - 下載與設定腳本
- `scripts/start-portable-postgres.js` - 啟動腳本
- `scripts/stop-portable-postgres.js` - 停止腳本

#### 平台檢測

腳本使用 Node.js 內建模組自動檢測：

```javascript
const platform = os.platform(); // 'darwin' | 'win32' | 'linux'
const arch = os.arch(); // 'x64' | 'arm64'
```

#### 解壓縮方式

所有平台統一使用 `tar` 命令解壓縮 `.tar.gz` 檔案：

- **macOS**: 使用 `tar` 命令（通常已預裝）
- **Windows**: 使用 `tar` 命令（Windows 10+ 已內建）
- **Linux**: 使用 `tar` 命令（通常已預裝）

## 資料庫連接

### 使用 psql 連線

```bash
# 使用專案中的 PostgreSQL
./postgres/bin/psql -U postgres -d ba_system

# Windows
.\postgres\bin\psql.exe -U postgres -d ba_system

# 或如果已加入 PATH
psql -U postgres -d ba_system -h 127.0.0.1 -p 5432
```

### 使用外部工具

- **Host**: `127.0.0.1`
- **Port**: `5432`
- **Database**: `ba_system`
- **User**: `postgres`
- **Password**: `postgres`

## 重要注意事項

### 1. 資料遷移

⚠️ **此遷移不包含資料轉移**。如果您的 MySQL 資料庫中有重要資料，需要手動遷移。

### 2. 可攜式 PostgreSQL 位置

所有 PostgreSQL 檔案都在 `postgres/` 目錄中，此目錄已加入 `.gitignore`，不會被提交到版本控制。

### 3. 開發環境設定

此設定使用 `trust` 認證方式，僅適合開發環境。生產環境請修改 `postgres/data/pg_hba.conf`。

### 4. 防火牆

Windows 防火牆可能會詢問是否允許 PostgreSQL 存取網路，請選擇允許。

## 疑難排解

### 問題：下載失敗 (404)

**可能原因**：

- 該版本尚未發布到 GitHub
- 版本號格式不正確

**解決方案**：

1. 檢查 [GitHub Releases](https://github.com/theseus-rs/postgresql-binaries/releases)
2. 確認版本號是否正確（例如：`16.2` 對應標籤 `v16.2`）
3. 手動下載：
   - 訪問：https://github.com/theseus-rs/postgresql-binaries/releases
   - 找到對應版本（例如：`v16.2`）
   - 下載對應平台的 `.tar.gz` 檔案
   - 將檔案放到 `postgres/` 目錄
   - 重新執行 `npm run postgres:download`

### 問題：Windows tar 命令不可用

**解決方案**：

1. **Windows 10+**: 通常已內建，確保已啟用
2. **安裝 Git for Windows**: 包含 `tar` 命令
3. **或使用 WSL**: 在 WSL 中執行腳本

### 問題：連接埠被占用

**解決方案**：

```bash
# macOS/Linux - 檢查占用 5432 的進程
lsof -i :5432

# Windows - 檢查占用 5432 的進程
netstat -ano | findstr :5432

# 或修改 .env 中的 DB_PORT
DB_PORT=5433
```

### 問題：權限錯誤

**解決方案**：

```bash
# macOS/Linux
chmod +x scripts/*.js

# Windows: 確保以管理員權限執行（如需要）
```

### 問題：解壓縮失敗

**解決方案**：

- 確保有足夠的磁碟空間
- 確保有寫入權限
- 檢查檔案是否完整下載

## 架構對比

| 項目       | MySQL            | PostgreSQL       |
| ---------- | ---------------- | ---------------- |
| 驅動程式   | mysql2           | pg               |
| 連線池     | mysql.createPool | pg.Pool          |
| 參數化查詢 | `?`              | `$1, $2, ...`    |
| 自動遞增   | AUTO_INCREMENT   | SERIAL           |
| ENUM       | 內建支援         | 需要 CREATE TYPE |
| JSON       | JSON             | JSONB (更高效)   |
| 更新時間戳 | ON UPDATE        | 觸發器           |
| 插入 ID    | insertId         | RETURNING id     |
| 受影響行數 | affectedRows     | rowCount         |

## 技術細節

### 自動參數轉換

`src/database/db.js` 中的 `convertQueryParams` 函數會自動將 `?` 佔位符轉換為 PostgreSQL 的 `$1, $2, ...`，保持代碼的可讀性和一致性。

### INSERT 語句

所有 INSERT 語句都使用 `RETURNING id` 子句，直接從結果中取得插入的 ID：`result[0].id`

### DELETE/UPDATE 語句

使用 `result.rowCount` 取得受影響的行數。

### 觸發器

所有表的 `updated_at` 欄位使用觸發器自動更新，無需在應用程式層處理。

## 參考資料

- [theseus-rs/postgresql-binaries GitHub](https://github.com/theseus-rs/postgresql-binaries)
- [GitHub Releases](https://github.com/theseus-rs/postgresql-binaries/releases)
- [PostgreSQL 官方文檔](https://www.postgresql.org/docs/)
