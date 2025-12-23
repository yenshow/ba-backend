# 資料庫完整文檔

## 目錄

1. [概述](#概述)
2. [快速開始](#快速開始)
3. [PostgreSQL 設定](#postgresql-設定)
4. [資料庫結構](#資料庫結構)
5. [設備資料庫結構分析](#設備資料庫結構分析)
6. [遷移歷史](#遷移歷史)
7. [疑難排解](#疑難排解)

---

## 概述

本專案使用 **PostgreSQL** 作為資料庫，並支援**可攜式 PostgreSQL**（無需系統安裝）。

**主要特點**：

- ✅ **完全開源**：使用 GitHub 開源二進制檔案，無需登入
- ✅ **跨平台支援**：macOS、Windows、Linux
- ✅ **自動下載**：腳本自動檢測平台並下載對應二進制檔案
- ✅ **可攜式**：所有檔案都在專案目錄中，無需系統安裝
- ✅ **統一配置**：所有設備連接資訊統一存儲在 `config` JSONB 欄位中
- ✅ **自動生成**：`unitId` 可自動生成，無需手動指定

---

## 快速開始

### 1. 安裝依賴

```bash
npm install
```

### 2. 下載並設定可攜式 PostgreSQL（只需一次）

```bash
npm run postgres:download
```

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

### 6. 建立首個管理員

```bash
npm run admin:create
```

### 7. 啟動應用程式

```bash
npm run dev
```

---

## PostgreSQL 設定

### 可攜式 PostgreSQL

#### 下載與設定

**方式一：自動下載（推薦）**

```bash
npm run postgres:download
```

**方式二：手動下載**

如果自動下載失敗，可以手動下載：

1. **檢測您的系統平台**：執行腳本會自動顯示

   ```bash
   npm run postgres:download
   ```

2. **手動下載檔案**：

   - 訪問：https://github.com/theseus-rs/postgresql-binaries/releases
   - 找到可用版本（例如 **16.11.0**、**16.10.0** 等）
   - 根據您的系統平台，找到對應的檔案：
     - **macOS ARM64 (Apple Silicon)**：`postgresql-<版本>-aarch64-apple-darwin.tar.gz`
     - **macOS Intel**：`postgresql-<版本>-x86_64-apple-darwin.tar.gz`
     - **Windows x64**：`postgresql-<版本>-x86_64-pc-windows-msvc.tar.gz`
     - **Linux x64**：`postgresql-<版本>-x86_64-unknown-linux-gnu.tar.gz`
     - **Linux ARM64**：`postgresql-<版本>-aarch64-unknown-linux-gnu.tar.gz`
   - 將下載的 `.tar.gz` 檔案放置到專案的 `postgres/` 目錄
   - 重新執行 `npm run postgres:download`

#### 支援的平台

| 平台    | 架構                  | 目標標識符 (Target Triple)  |
| ------- | --------------------- | --------------------------- |
| macOS   | ARM64 (Apple Silicon) | `aarch64-apple-darwin`      |
| macOS   | x86_64 (Intel)        | `x86_64-apple-darwin`       |
| Windows | x64                   | `x86_64-pc-windows-msvc`    |
| Linux   | x64                   | `x86_64-unknown-linux-gnu`  |
| Linux   | ARM64                 | `aarch64-unknown-linux-gnu` |

#### 目錄結構

```
postgres/
├── bin/          # PostgreSQL 執行檔
├── lib/          # 共享庫
├── data/         # 資料庫資料
├── logs/         # 日誌檔案
└── share/        # 共享檔案
```

### 環境變數設定

在 `.env` 檔案中設定：

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=ba_system
```

### 常用指令

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

### PostgreSQL 技術特點

#### 1. 資料庫驅動程式

- 使用 `pg` (PostgreSQL) 驅動程式
- 支援連線池管理
- 自動參數轉換（`?` → `$1, $2, ...`）

#### 2. SQL 語法

| 功能 | PostgreSQL 實現 |
| ----------------------------- | ----------------------------------- |
| 自動遞增 | `SERIAL` 或 `BIGSERIAL` |
| 整數類型 | `INTEGER`（無 UNSIGNED） |
| 枚舉類型 | `ENUM` 類型（需要 CREATE TYPE） |
| 自動更新時間戳 | 使用觸發器實現 |
| 衝突處理 | `INSERT ... ON CONFLICT DO NOTHING` |
| 參數化查詢 | `$1, $2, ...` 佔位符 |
| 取得插入 ID | `RETURNING id` |
| 受影響行數 | `result.rowCount` |
| JSON 存儲 | `JSONB`（高效能 JSON 類型） |

---

## 資料庫結構

### devices 表

#### 欄位定義

| 欄位 | 類型 | 必填 | 說明 |
|---|---|---|---|
| `id` | SERIAL | ✅ | 主鍵 |
| `name` | VARCHAR(100) | ✅ | 設備名稱 |
| `type_id` | INTEGER | ✅ | 設備類型 ID（外鍵 → device_types.id） |
| `model_id` | INTEGER | ✅ | 設備型號 ID（外鍵 → device_models.id，必填） |
| `location` | VARCHAR(255) | ❌ | 設備位置 |
| `description` | TEXT | ❌ | 設備描述/備註 |
| `status` | device_status | ✅ | 狀態（active/inactive/error） |
| `config` | JSONB | ❌ | 設備配置（連接資訊統一存儲在此） |
| `last_seen_at` | TIMESTAMP | ❌ | 最後連線時間 |
| `created_by` | INTEGER | ❌ | 建立者 ID（外鍵 → users.id） |
| `created_at` | TIMESTAMP | ✅ | 建立時間 |
| `updated_at` | TIMESTAMP | ✅ | 更新時間 |

#### 索引

- `idx_devices_status` - 狀態索引
- `idx_devices_type_id` - 類型 ID 索引
- `idx_devices_model_id` - 型號 ID 索引
- `idx_devices_config` - config JSONB GIN 索引（用於 JSON 查詢）

#### 外鍵約束

- `fk_devices_type` → `device_types(id)` ON DELETE RESTRICT
- `fk_devices_model` → `device_models(id)` ON DELETE RESTRICT
- `fk_devices_created_by` → `users(id)` ON DELETE SET NULL

#### 連接資訊存儲

**重要：** 所有連接資訊統一存儲在 `config` JSONB 欄位中，不再使用獨立的 `modbus_*` 欄位。

##### controller 類型配置

```json
{
  "type": "controller",
  "host": "192.168.2.205",    // 必填：主機 IP
  "port": 502,                 // 可選：端口（可從 device_models.port 繼承）
  "unitId": 1                  // 可選：Unit ID（未提供時自動生成）
}
```

##### camera 類型配置

```json
{
  "type": "camera",
  "ip_address": "192.168.2.100"  // 必填：IP 位址
}
```

##### sensor 類型配置（Modbus）

```json
{
  "type": "sensor",
  "protocol": "modbus",           // 必填：協議類型（modbus/http/mqtt）
  "host": "192.168.2.200",        // protocol=modbus 時必填
  "port": 502,                     // protocol=modbus 時必填
  "unitId": 1                      // protocol=modbus 時必填
}
```

##### sensor 類型配置（HTTP）

```json
{
  "type": "sensor",
  "protocol": "http",
  "api_endpoint": "http://192.168.2.200/api/data"  // 必填
}
```

##### tablet 類型配置

```json
{
  "type": "tablet",
  "mac_address": "AA:BB:CC:DD:EE:FF"  // 必填：MAC 位址
}
```

##### network 類型配置

```json
{
  "type": "network",
  "ip_address": "192.168.2.1",        // 必填：IP 位址
  "device_type": "router"              // 必填：設備類型（router/switch/access_point/other）
}
```

#### 查詢範例

##### 查詢所有 controller 類型的設備

```sql
SELECT * FROM devices d
INNER JOIN device_types dt ON d.type_id = dt.id
WHERE dt.code = 'controller';
```

##### 查詢特定 host 和 port 的設備

```sql
SELECT * FROM devices
WHERE config->>'host' = '192.168.2.205'
AND (config->>'port')::integer = 502;
```

##### 查詢所有使用 Modbus 的設備（controller 或 sensor with modbus protocol）

```sql
SELECT * FROM devices d
INNER JOIN device_types dt ON d.type_id = dt.id
WHERE dt.code = 'controller'
OR (dt.code = 'sensor' AND config->>'protocol' = 'modbus');
```

---

### device_types 表

| 欄位 | 類型 | 必填 | 說明 |
|---|---|---|---|
| `id` | SERIAL | ✅ | 主鍵 |
| `name` | VARCHAR(100) | ✅ | 類型名稱 |
| `code` | VARCHAR(50) | ✅ | 類型代碼（唯一） |
| `description` | TEXT | ❌ | 描述 |

#### 預設類型

- `camera` - 攝影機
- `sensor` - 感測器
- `controller` - 控制器（Modbus）
- `tablet` - 平板
- `network` - 網路裝置

---

### device_models 表

| 欄位 | 類型 | 必填 | 說明 |
|---|---|---|---|
| `id` | SERIAL | ✅ | 主鍵 |
| `name` | VARCHAR(100) | ✅ | 型號名稱 |
| `type_id` | INTEGER | ✅ | 設備類型 ID（外鍵 → device_types.id） |
| `port` | INTEGER | ✅ | 預設端口（如 Modbus TCP 標準端口 502） |
| `description` | TEXT | ❌ | 描述 |
| `config` | JSONB | ❌ | 型號配置 |
| `created_at` | TIMESTAMP | ✅ | 建立時間 |
| `updated_at` | TIMESTAMP | ✅ | 更新時間 |

**注意：** `port` 欄位用於存儲該型號的預設端口，創建設備時可以從型號繼承此端口值。

---

## 設備資料庫結構分析

### 目前資料庫內容

#### 設備類型 (device_types)

| ID | 名稱 | 代碼 (code) | 描述 |
|---|---|---|---|
| 1 | 攝影機 | `camera` | 影像監控、車牌辨識、人流統計 |
| 3 | 感測器 | `sensor` | 感測器設備 |
| 40 | 控制器 | `controller` | modbus |
| 41 | 平板 | `tablet` | 平板電腦設備 |
| 42 | 網路裝置 | `network` | 路由器、交換器、無線基地台等網路設備 |

#### 設備型號 (device_models)

| ID | 名稱 | 類型 ID | Port | 描述 |
|---|---|---|---|---|
| 3 | ZC160 | 40 (controller) | 502 | 展廳測試 DI / DO |

#### 設備列表 (devices)

目前資料庫中**沒有設備資料**（空表）

---

### 核心設計原則

#### 1. 統一配置存儲

**已移除獨立欄位：** `modbus_host`、`modbus_port`、`modbus_unit_id` 欄位已移除

**新的設計：** 所有連接資訊統一存儲在 `config` JSONB 欄位中：
- `controller` 類型：`config.host`、`config.port`、`config.unitId`（unitId 可自動生成）
- 其他類型：根據類型不同，使用不同的 config 結構

#### 2. 自動生成 unitId

**功能：**
- 對於 `controller` 類型，如果未提供 `unitId`，系統會自動生成
- 自動查找相同 `host + port` 的設備，找出未使用的 `unitId`
- 從 1 開始，最多到 255

#### 3. model_id 必填

**改進：**
- `model_id` 現在是必填欄位（NOT NULL）
- 每個設備都必須有對應的設備型號
- 外鍵約束改為 `ON DELETE RESTRICT`（防止誤刪型號）

#### 4. port 繼承機制

**設計：**
- `device_models` 表包含 `port` 欄位（預設 502）
- 創建設備時，可以從型號繼承 `port` 值
- 如果設備的 `config.port` 未提供，會使用 `device_models.port`

---

### 各設備類型的 config 結構

#### `controller` 類型

```json
{
  "type": "controller",
  "host": "192.168.2.205",    // 必填
  "port": 502,                 // 可選（可從 model.port 繼承）
  "unitId": 1                  // 可選（未提供時自動生成）
}
```

#### `camera` 類型

```json
{
  "type": "camera",
  "ip_address": "192.168.2.100"  // 必填
}
```

#### `sensor` 類型

```json
{
  "type": "sensor",
  "protocol": "modbus",        // modbus/http/mqtt
  "host": "192.168.2.200",     // protocol=modbus 時必填
  "port": 502,                 // protocol=modbus 時必填
  "unitId": 1                  // protocol=modbus 時必填
}
```

#### `tablet` 類型

```json
{
  "type": "tablet",
  "mac_address": "AA:BB:CC:DD:EE:FF"  // 必填
}
```

#### `network` 類型

```json
{
  "type": "network",
  "ip_address": "192.168.2.1",        // 必填
  "device_type": "router"              // router/switch/access_point/other
}
```

---

## 遷移歷史

### 已完成的遷移

#### 1. 移除 modbus 欄位 (`scripts/removeModbusFields.js`)

- 移除 `modbus_host`、`modbus_port`、`modbus_unit_id` 欄位
- 移除 `idx_devices_modbus_connection` 索引
- 連接資訊統一存儲在 `config` JSONB 中

#### 2. model_id 改為必填 (`scripts/makeModelIdRequired.js`)

- 將 `model_id` 欄位改為 NOT NULL
- 更新外鍵約束為 `ON DELETE RESTRICT`

#### 3. 添加 port 欄位到 device_models (`scripts/addPortToDeviceModels.js`)

- 為 `device_models` 表添加 `port` 欄位
- 預設值為 502（Modbus TCP 標準端口）

---

## 疑難排解

### 問題：下載失敗 (404 或檔案不存在)

**可能原因**：

- 該版本尚未發布到 GitHub
- 版本號格式不正確
- 該平台沒有對應版本的二進制檔案

**解決方案**：

1. **檢查可用版本**：
   - 訪問 [GitHub Releases](https://github.com/theseus-rs/postgresql-binaries/releases)
   - 查看有哪些版本可用（例如：v16.11.0、v16.10.0 等）

2. **手動下載**：
   - 執行 `npm run postgres:download` 查看您的平台資訊
   - 從 GitHub Releases 下載對應平台的 `.tar.gz` 檔案
   - 將檔案放到 `postgres/` 目錄
   - 重新執行 `npm run postgres:download`

3. **檔案名稱格式**：
   - 格式：`postgresql-<版本>-<目標標識符>.tar.gz`
   - 例如：`postgresql-16.11.0-aarch64-apple-darwin.tar.gz`

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

---

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

---

## 重要注意事項

### 1. 可攜式 PostgreSQL 位置

所有 PostgreSQL 檔案都在 `postgres/` 目錄中，此目錄已加入 `.gitignore`，不會被提交到版本控制。

### 2. 開發環境設定

此設定使用 `trust` 認證方式，僅適合開發環境。生產環境請修改 `postgres/data/pg_hba.conf`。

### 3. 防火牆

Windows 防火牆可能會詢問是否允許 PostgreSQL 存取網路，請選擇允許。

---

## 參考資料

- [theseus-rs/postgresql-binaries GitHub](https://github.com/theseus-rs/postgresql-binaries)
- [GitHub Releases](https://github.com/theseus-rs/postgresql-binaries/releases)
- [PostgreSQL 官方文檔](https://www.postgresql.org/docs/)

