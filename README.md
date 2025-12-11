## BA 系統後端

Node.js / Express 後端服務，整合 Modbus TCP 通訊與 PostgreSQL 資料庫，提供完整的 BA（Building Automation）系統功能，包括用戶管理、設備管理等。

### 安裝

```bash
npm install
```

### 設定環境變數

複製 `.env.example` 為 `.env`，並依實際環境調整。

```bash
cp .env.example .env
```

| 變數                  | 說明                      | 預設        |
| --------------------- | ------------------------- | ----------- |
| `HOST`                | 後端服務監聽位址          | `0.0.0.0`   |
| `PORT`                | 後端服務監聽 port         | `4000`      |
| `MODBUS_TIMEOUT`      | Modbus 請求超時時間（ms） | `2000`      |
| `DB_HOST`             | PostgreSQL 資料庫主機位址 | `127.0.0.1` |
| `DB_PORT`             | PostgreSQL 資料庫 port    | `5432`      |
| `DB_USER`             | PostgreSQL 使用者名稱     | `postgres`  |
| `DB_PASSWORD`         | PostgreSQL 密碼           | `postgres`  |
| `DB_NAME`             | 資料庫名稱                | `ba_system` |
| `DB_CONNECTION_LIMIT` | 連線池最大連線數          | `10`        |
| `JWT_SECRET`          | JWT 密鑰                  | -           |
| `JWT_EXPIRES_IN`      | JWT 過期時間              | `7d`        |

**注意**：設備連線資訊（`host`、`port`、`unitId`）由前端在 API 請求中提供，無需在環境變數中設定。後端支援同時連接多個不同的 Modbus 設備。

### 設定 PostgreSQL（可攜式）

專案支援可攜式 PostgreSQL，無需在系統安裝 PostgreSQL。**支援 macOS、Windows 和 Linux**：

```bash
# 下載並設定 PostgreSQL（只需一次，自動檢測作業系統）
npm run postgres:download

# 啟動 PostgreSQL
npm run postgres:start

# 停止 PostgreSQL
npm run postgres:stop
```

**支援的平台**：

- ✅ macOS (Intel / Apple Silicon)
- ✅ Windows (x64)
- ✅ Linux (x64 / ARM64)

詳細說明請參考 [POSTGRESQL_MIGRATION.md](./POSTGRESQL_MIGRATION.md)

### 初始化資料庫

首次使用前，需要初始化資料庫 Schema：

```bash
npm run db:init
```

此命令會自動建立以下資料表：

- `users` - 用戶管理
- `devices` - 設備管理
- `device_data_logs` - 設備資料歷史記錄
- `device_alerts` - 設備告警記錄

### 測試資料庫連線

```bash
npm run db:test
```

### 建立首個管理員

初始化資料庫後，需要建立首個管理員帳號：

```bash
npm run admin:create
```

此命令會引導您輸入：

- 用戶名
- Email
- 密碼（至少 6 個字元）
- 確認密碼

### 啟動方式

開發模式（自動重啟）：

```bash
npm run dev
```

正式執行：

```bash
npm start
```

服務啟動後，可透過下列 API 使用：

## API 端點

### 用戶管理 API

| Method   | Path                      | 說明             | 認證需求   |
| -------- | ------------------------- | ---------------- | ---------- |
| `POST`   | `/api/users/register`     | 註冊新用戶       | 無         |
| `POST`   | `/api/users/login`        | 用戶登入         | 無         |
| `GET`    | `/api/users/me`           | 取得當前用戶資訊 | 需要認證   |
| `GET`    | `/api/users`              | 取得用戶列表     | 需要管理員 |
| `GET`    | `/api/users/:id`          | 取得單一用戶     | 需要管理員 |
| `PUT`    | `/api/users/:id`          | 更新用戶資訊     | 需要認證   |
| `PUT`    | `/api/users/:id/password` | 更新密碼         | 需要認證   |
| `DELETE` | `/api/users/:id`          | 刪除用戶         | 需要管理員 |

**認證方式**: 在請求 Header 中加入 `Authorization: Bearer <token>`

### Modbus API

**所有 Modbus API 都需要在 query 參數中提供設備資訊：`host`、`port`、`unitId`**

| Method | Path                                                                                     | 說明                   |
| ------ | ---------------------------------------------------------------------------------------- | ---------------------- |
| `GET`  | `/api/modbus/health?host=192.168.2.204&port=502&unitId=1`                                | 查看連線狀態           |
| `GET`  | `/api/modbus/holding-registers?address=0&length=10&host=192.168.2.204&port=502&unitId=1` | 讀取 Holding Registers |
| `GET`  | `/api/modbus/input-registers?address=0&length=10&host=192.168.2.204&port=502&unitId=1`   | 讀取 Input Registers   |
| `GET`  | `/api/modbus/coils?address=0&length=10&host=192.168.2.204&port=502&unitId=1`             | 讀取 Coils             |
| `GET`  | `/api/modbus/discrete-inputs?address=0&length=10&host=192.168.2.204&port=502&unitId=1`   | 讀取 Discrete Inputs   |

**API 參數說明**：

- `host`（必填）：Modbus 設備 IP 位址
- `port`（必填）：Modbus TCP 埠號（通常為 502）
- `unitId`（必填）：Modbus Unit ID（0-255）
- `address`（選填）：讀取起始位址，預設 0
- `length`（選填）：讀取筆數，預設 10，最大 125

### 工具腳本

- `npm run test:modbus <host> [port]` - 測試 Modbus 連接並自動檢測配置
- `npm run scan:modbus <host> <port> <unitId> <type> <startAddress> <endAddress>` - 掃描 Modbus 地址範圍
- `npm run postgres:download` - 下載並設定可攜式 PostgreSQL（只需一次）
- `npm run postgres:start` - 啟動 PostgreSQL
- `npm run postgres:stop` - 停止 PostgreSQL
- `npm run db:init` - 初始化資料庫 Schema
- `npm run db:test` - 測試資料庫連線
- `npm run db:backup [--days <天數>] [--backup-only]` - 備份舊資料（預設 30 天前）
- `npm run db:cleanup [--days <天數>]` - 清理舊資料（先備份後刪除，預設 30 天前）
- `npm run admin:create` - 建立系統管理員帳號

### 資料庫架構

系統已建立以下資料表：

- **users**: 用戶帳號、角色（admin/operator/viewer）、狀態管理
- **devices**: 設備資訊、Modbus 連線參數、狀態追蹤
- **device_data_logs**: 設備資料歷史記錄（時間序列）
- **device_alerts**: 設備告警記錄與處理狀態

### 後續開發計劃

- [x] 資料庫連線與 Schema 初始化
- [x] 用戶管理 API（註冊、登入、權限管理）
- [ ] 設備管理 API（CRUD、狀態監控）
- [ ] 背景排程服務（定期輪詢設備資料）
- [ ] 告警系統（閾值監控、通知）
- [ ] 資料查詢 API（歷史資料、統計分析）
