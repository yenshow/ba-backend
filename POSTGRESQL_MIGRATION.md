# PostgreSQL 資料庫設定說明

## 概述

專案使用 PostgreSQL 作為資料庫，並支援可攜式 PostgreSQL（無需系統安裝）。這是純 PostgreSQL 實現，不包含任何 MySQL 兼容層。

## 主要變更

### 1. 資料庫驅動程式

- **使用**: `pg` (PostgreSQL)

### 2. SQL 語法變更

- `AUTO_INCREMENT` → `SERIAL` 或 `BIGSERIAL`
- `INT UNSIGNED` → `INTEGER` (PostgreSQL 沒有 UNSIGNED)
- `ENUM` → PostgreSQL 的 `ENUM` 類型（需要先建立）
- `ON UPDATE CURRENT_TIMESTAMP` → 使用觸發器實現
- `INSERT IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
- `?` 佔位符 → `$1, $2, ...` (自動轉換，保持代碼可讀性)
- 使用 `RETURNING id` 子句取得插入的 ID：`result[0].id`
- 使用 `rowCount` 取得受影響的行數：`result.rowCount`

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

- 自動下載 PostgreSQL 二進制檔案到 `postgres/` 目錄
- 初始化資料庫
- 建立資料庫和使用者
- 啟動 PostgreSQL 服務

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
npm run postgres:start    # 啟動 PostgreSQL
npm run postgres:stop     # 停止 PostgreSQL
npm run postgres:download # 下載並設定（只需一次）

# 資料庫操作
npm run db:init           # 初始化 Schema
npm run db:test           # 測試連線
npm run db:backup         # 備份資料
npm run db:cleanup        # 清理舊資料
npm run admin:create      # 建立管理員
```

## 資料庫連接

### 使用 psql 連線

```bash
# 使用專案中的 PostgreSQL
./postgres/bin/psql -U postgres -d ba_system

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

所有 PostgreSQL 檔案都在 `postgres/` 目錄中：

- `postgres/bin/` - 執行檔
- `postgres/data/` - 資料庫資料
- `postgres/logs/` - 日誌檔案

### 3. 開發環境設定

此設定使用 `trust` 認證方式，僅適合開發環境。生產環境請修改 `postgres/data/pg_hba.conf`。

## 疑難排解

### 問題：下載失敗

**解決方案**：確保有網路連線，或手動下載 PostgreSQL 二進制檔案。

### 問題：連接埠被占用

**解決方案**：

```bash
# 檢查占用 5432 的進程
lsof -i :5432

# 或修改 .env 中的 DB_PORT
DB_PORT=5433
```

### 問題：權限錯誤

**解決方案**：

```bash
chmod +x scripts/*.sh
```

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

## 下一步

1. ✅ 安裝依賴：`npm install`
2. ✅ 下載 PostgreSQL：`npm run postgres:download`
3. ✅ 初始化 Schema：`npm run db:init`
4. ✅ 建立管理員：`npm run admin:create`
5. ✅ 啟動服務：`npm run dev`

## 技術細節

### 自動參數轉換

`db.js` 中的 `convertQueryParams` 函數會自動將 `?` 佔位符轉換為 PostgreSQL 的 `$1, $2, ...`，保持代碼的可讀性和一致性。

### INSERT 語句

所有 INSERT 語句都使用 `RETURNING id` 子句，直接從結果中取得插入的 ID：`result[0].id`

### DELETE/UPDATE 語句

使用 `result.rowCount` 取得受影響的行數。

### 觸發器

所有表的 `updated_at` 欄位使用觸發器自動更新，無需在應用程式層處理。
