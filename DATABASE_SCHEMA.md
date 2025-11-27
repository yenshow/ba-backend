# 資料庫架構與初始化說明

## 📋 總覽

本文檔說明 BA 系統的資料庫架構、初始化流程、資料表結構與關係設計。

---

## 🔧 資料庫連線設定

### 環境變數配置

| 變數                  | 說明                 | 預設值      |
| --------------------- | -------------------- | ----------- |
| `DB_HOST`             | MySQL 資料庫主機位址 | `127.0.0.1` |
| `DB_PORT`             | MySQL 資料庫 port    | `3306`      |
| `DB_USER`             | MySQL 使用者名稱     | `root`      |
| `DB_PASSWORD`         | MySQL 密碼           | -           |
| `DB_NAME`             | 資料庫名稱           | `ba_system` |
| `DB_CONNECTION_LIMIT` | 連線池最大連線數     | `10`        |

### 連線池設定

**檔案**: `src/database/db.js`

```javascript
const pool = mysql.createPool({
	host: config.database.host,
	port: config.database.port,
	user: config.database.user,
	password: config.database.password,
	database: config.database.database,
	waitForConnections: true,
	connectionLimit: 10,
	queueLimit: 0,
	enableKeepAlive: true,
	keepAliveInitialDelay: 0
});
```

**功能**:

- 自動管理連線池
- 支援並發查詢
- 自動重連機制
- Keep-Alive 保持連線

---

## 🚀 初始化流程

### 1. 初始化資料庫 Schema

**命令**:

```bash
npm run db:init
```

**流程**:

1. 連接到 MySQL 伺服器（不指定資料庫）
2. 建立資料庫（如果不存在）
   - 資料庫名稱：`ba_system`
   - 字符集：`utf8mb4`
   - 排序規則：`utf8mb4_unicode_ci`
3. 切換到目標資料庫
4. 依序建立所有資料表：
   - `users` - 用戶管理
   - `devices` - 設備管理
   - `device_data_logs` - 設備資料歷史記錄
   - `device_alerts` - 設備告警記錄

### 2. 測試資料庫連線

**命令**:

```bash
npm run db:test
```

**功能**:

- 測試連線池是否正常運作
- 驗證資料庫連線設定是否正確

---

## 📊 資料表結構

### 1. users - 用戶管理表

**用途**: 儲存系統用戶資訊、角色與權限

**結構**:

| 欄位            | 類型                                      | 說明            | 約束             |
| --------------- | ----------------------------------------- | --------------- | ---------------- |
| `id`            | `INT UNSIGNED`                            | 用戶 ID（主鍵） | AUTO_INCREMENT   |
| `username`      | `VARCHAR(50)`                             | 用戶名稱        | UNIQUE, NOT NULL |
| `email`         | `VARCHAR(100)`                            | 電子郵件        | UNIQUE, NOT NULL |
| `password_hash` | `VARCHAR(255)`                            | 密碼雜湊值      | NOT NULL         |
| `role`          | `ENUM('admin', 'operator', 'viewer')`     | 角色            | DEFAULT 'viewer' |
| `status`        | `ENUM('active', 'inactive', 'suspended')` | 帳號狀態        | DEFAULT 'active' |
| `created_at`    | `TIMESTAMP`                               | 建立時間        | AUTO             |
| `updated_at`    | `TIMESTAMP`                               | 更新時間        | AUTO UPDATE      |

**索引**:

- `PRIMARY KEY (id)`
- `INDEX idx_username (username)`
- `INDEX idx_email (email)`
- `INDEX idx_status (status)`

**角色說明**:

- `admin`: 系統管理員，擁有所有權限
- `operator`: 操作員，可以管理設備和查看資料
- `viewer`: 檢視者，只能查看資料

**狀態說明**:

- `active`: 正常使用中
- `inactive`: 停用（暫時無法登入）
- `suspended`: 暫停（違規或管理員停用）

---

### 2. devices - 設備管理表

**用途**: 儲存 Modbus 設備資訊與連線參數

**結構**:

| 欄位             | 類型                                                | 說明                | 約束              |
| ---------------- | --------------------------------------------------- | ------------------- | ----------------- |
| `id`             | `INT UNSIGNED`                                      | 設備 ID（主鍵）     | AUTO_INCREMENT    |
| `name`           | `VARCHAR(100)`                                      | 設備名稱            | NOT NULL          |
| `device_type`    | `VARCHAR(50)`                                       | 設備類型            | NOT NULL          |
| `modbus_host`    | `VARCHAR(255)`                                      | Modbus 設備 IP 位址 | NOT NULL          |
| `modbus_port`    | `INT UNSIGNED`                                      | Modbus TCP 埠號     | NOT NULL          |
| `modbus_unit_id` | `INT UNSIGNED`                                      | Modbus Unit ID      | NOT NULL          |
| `location`       | `VARCHAR(255)`                                      | 設備位置            | NULL              |
| `description`    | `TEXT`                                              | 設備描述            | NULL              |
| `status`         | `ENUM('online', 'offline', 'maintenance', 'error')` | 設備狀態            | DEFAULT 'offline' |
| `last_seen_at`   | `TIMESTAMP`                                         | 最後連線時間        | NULL              |
| `created_by`     | `INT UNSIGNED`                                      | 建立者 ID           | NULL, FK          |
| `created_at`     | `TIMESTAMP`                                         | 建立時間            | AUTO              |
| `updated_at`     | `TIMESTAMP`                                         | 更新時間            | AUTO UPDATE       |

**索引**:

- `PRIMARY KEY (id)`
- `INDEX idx_modbus_connection (modbus_host, modbus_port, modbus_unit_id)`
- `INDEX idx_status (status)`
- `INDEX idx_device_type (device_type)`
- `FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL`

**狀態說明**:

- `online`: 設備在線，正常運作
- `offline`: 設備離線，無法連線
- `maintenance`: 維護中，暫時停用
- `error`: 發生錯誤，需要處理

**外鍵關係**:

- `created_by` → `users.id`: 記錄建立此設備的用戶，刪除用戶時設為 NULL

---

### 3. device_data_logs - 設備資料歷史記錄表

**用途**: 儲存設備讀取的歷史資料（時間序列資料）

**結構**:

| 欄位            | 類型                                           | 說明            | 約束           |
| --------------- | ---------------------------------------------- | --------------- | -------------- |
| `id`            | `BIGINT UNSIGNED`                              | 記錄 ID（主鍵） | AUTO_INCREMENT |
| `device_id`     | `INT UNSIGNED`                                 | 設備 ID         | NOT NULL, FK   |
| `register_type` | `ENUM('holding', 'input', 'coil', 'discrete')` | 寄存器類型      | NOT NULL       |
| `address`       | `INT UNSIGNED`                                 | Modbus 位址     | NOT NULL       |
| `value`         | `JSON`                                         | 資料值（陣列）  | NOT NULL       |
| `recorded_at`   | `TIMESTAMP`                                    | 記錄時間        | AUTO           |

**索引**:

- `PRIMARY KEY (id)`
- `INDEX idx_device_recorded (device_id, recorded_at)`
- `INDEX idx_recorded_at (recorded_at)`
- `FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE`

**寄存器類型說明**:

- `holding`: Holding Registers (FC03)
- `input`: Input Registers (FC04)
- `coil`: Coils (FC01)
- `discrete`: Discrete Inputs (FC02)

**資料格式範例**:

```json
{
	"device_id": 1,
	"register_type": "coil",
	"address": 0,
	"value": [true, false, true, false],
	"recorded_at": "2024-01-01 12:00:00"
}
```

**外鍵關係**:

- `device_id` → `devices.id`: 刪除設備時，相關記錄一併刪除（CASCADE）

---

### 4. device_alerts - 設備告警記錄表

**用途**: 儲存設備告警與異常記錄

**結構**:

| 欄位          | 類型                                                   | 說明            | 約束              |
| ------------- | ------------------------------------------------------ | --------------- | ----------------- |
| `id`          | `INT UNSIGNED`                                         | 告警 ID（主鍵） | AUTO_INCREMENT    |
| `device_id`   | `INT UNSIGNED`                                         | 設備 ID         | NOT NULL, FK      |
| `alert_type`  | `ENUM('offline', 'error', 'threshold', 'maintenance')` | 告警類型        | NOT NULL          |
| `severity`    | `ENUM('info', 'warning', 'error', 'critical')`         | 嚴重程度        | DEFAULT 'warning' |
| `message`     | `TEXT`                                                 | 告警訊息        | NOT NULL          |
| `resolved`    | `BOOLEAN`                                              | 是否已解決      | DEFAULT FALSE     |
| `resolved_at` | `TIMESTAMP`                                            | 解決時間        | NULL              |
| `resolved_by` | `INT UNSIGNED`                                         | 解決者 ID       | NULL, FK          |
| `created_at`  | `TIMESTAMP`                                            | 建立時間        | AUTO              |

**索引**:

- `PRIMARY KEY (id)`
- `INDEX idx_device_resolved (device_id, resolved)`
- `INDEX idx_created_at (created_at)`
- `FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE`
- `FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL`

**告警類型說明**:

- `offline`: 設備離線告警
- `error`: 設備錯誤告警
- `threshold`: 數值超過閾值告警
- `maintenance`: 維護提醒

**嚴重程度說明**:

- `info`: 資訊性告警
- `warning`: 警告
- `error`: 錯誤
- `critical`: 嚴重錯誤

**外鍵關係**:

- `device_id` → `devices.id`: 刪除設備時，相關告警一併刪除（CASCADE）
- `resolved_by` → `users.id`: 記錄解決告警的用戶，刪除用戶時設為 NULL

---

## 🔗 資料表關係圖

```
users (用戶)
  │
  ├── created_by (devices.created_by) → SET NULL
  │
  └── resolved_by (device_alerts.resolved_by) → SET NULL

devices (設備)
  │
  ├── device_id (device_data_logs.device_id) → CASCADE
  │
  └── device_id (device_alerts.device_id) → CASCADE
```

**關係說明**:

- `users` 與 `devices`: 一對多（一個用戶可以建立多個設備）
- `users` 與 `device_alerts`: 一對多（一個用戶可以解決多個告警）
- `devices` 與 `device_data_logs`: 一對多（一個設備有多筆歷史記錄）
- `devices` 與 `device_alerts`: 一對多（一個設備可以有多個告警）

---

## 🛠️ 資料庫操作 API

### 連線池操作

**檔案**: `src/database/db.js`

```javascript
const db = require("./database/db");

// 執行查詢
const results = await db.query("SELECT * FROM users WHERE id = ?", [1]);

// 執行事務
await db.transaction(async (connection) => {
	await connection.query("INSERT INTO users ...");
	await connection.query("INSERT INTO devices ...");
	return result;
});

// 測試連線
const isConnected = await db.testConnection();

// 關閉連線池
await db.close();
```

### 查詢範例

**查詢所有設備**:

```javascript
const devices = await db.query("SELECT * FROM devices WHERE status = ?", ["online"]);
```

**查詢設備歷史資料**:

```javascript
const logs = await db.query("SELECT * FROM device_data_logs WHERE device_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC", [deviceId, startDate]);
```

**查詢未解決的告警**:

```javascript
const alerts = await db.query("SELECT * FROM device_alerts WHERE resolved = FALSE ORDER BY created_at DESC");
```

---

## 📝 使用建議

### 1. 資料保留策略

**重要原則**: ⚠️ **先備份後刪除** - 所有資料清理操作都必須先備份，確認備份成功後才進行刪除。

**device_data_logs**:

- 建議定期清理舊資料（例如：保留 30 天）
- **清理前必須先備份**（JSON 和 CSV 格式）
- 可考慮使用分區表（Partitioning）按時間分區
- 大量資料可考慮使用時間序列資料庫（如 InfluxDB）

**device_alerts**:

- 已解決的告警可定期歸檔
- 建議保留至少 90 天的告警記錄
- **清理前必須先備份**（JSON 和 CSV 格式）

**備份與清理工具**:

```bash
# 只備份資料（不刪除）
npm run db:backup -- --days 30 --backup-only

# 備份並清理舊資料（先備份後刪除）
npm run db:cleanup -- --days 30

# 自訂保留天數
npm run db:cleanup -- --days 90
```

**備份檔案位置**: `backups/` 目錄

- JSON 格式: `{table_name}_{timestamp}.json`
- CSV 格式: `{table_name}_{timestamp}.csv`

**安全機制**:

- 備份失敗時自動中止刪除操作
- 備份檔案包含完整時間戳，避免覆蓋
- 支援只備份不刪除模式（`--backup-only`）

### 1.1. 自動排程設定

**使用 cron 定期執行備份與清理**:

#### Linux/macOS (crontab)

編輯 crontab:

```bash
crontab -e
```

**範例排程設定**:

```bash
# 每週日凌晨 2 點執行資料清理（保留 30 天）
0 2 * * 0 cd /path/to/ba-backend && npm run db:cleanup -- --days 30 >> /var/log/ba-backend-cleanup.log 2>&1

# 每天凌晨 3 點只備份資料（不刪除，保留 30 天）
0 3 * * * cd /path/to/ba-backend && npm run db:backup -- --days 30 --backup-only >> /var/log/ba-backend-backup.log 2>&1

# 每月 1 號凌晨 4 點執行深度清理（保留 90 天）
0 4 1 * * cd /path/to/ba-backend && npm run db:cleanup -- --days 90 >> /var/log/ba-backend-cleanup.log 2>&1
```

**cron 時間格式說明**:

```
* * * * *
│ │ │ │ │
│ │ │ │ └── 星期幾 (0-7, 0 和 7 都代表星期日)
│ │ │ └──── 月份 (1-12)
│ │ └────── 日期 (1-31)
│ └──────── 小時 (0-23)
└────────── 分鐘 (0-59)
```

**常用時間範例**:

- `0 2 * * *` - 每天凌晨 2 點
- `0 2 * * 0` - 每週日凌晨 2 點
- `0 2 1 * *` - 每月 1 號凌晨 2 點
- `0 */6 * * *` - 每 6 小時執行一次
- `0 2 * * 1-5` - 週一到週五凌晨 2 點

#### Windows (工作排程器)

1. 開啟「工作排程器」
2. 建立基本工作
3. 設定觸發條件（例如：每週日 02:00）
4. 設定動作：啟動程式
   - 程式：`node`
   - 引數：`scripts/cleanupOldData.js --days 30`
   - 開始位置：`C:\path\to\ba-backend`

#### 使用 PM2 (推薦用於 Node.js 應用)

安裝 PM2:

```bash
npm install -g pm2
```

建立排程腳本 `ecosystem.config.js`:

```javascript
module.exports = {
	apps: [
		{
			name: "ba-backend",
			script: "src/server.js",
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: "1G"
		}
	],
	cron_restart: "0 2 * * 0" // 每週日凌晨 2 點重啟
	// 或使用 PM2 的 cron 功能執行腳本
};
```

使用 PM2 執行 cron 任務:

```bash
# 安裝 PM2 cron 模組
pm2 install pm2-cron

# 設定 cron 任務
pm2 set pm2-cron:cleanup "0 2 * * 0 cd /path/to/ba-backend && npm run db:cleanup -- --days 30"
```

#### 使用 systemd (Linux)

建立服務檔案 `/etc/systemd/system/ba-backend-cleanup.service`:

```ini
[Unit]
Description=BA Backend Data Cleanup
After=network.target

[Service]
Type=oneshot
User=your-user
WorkingDirectory=/path/to/ba-backend
ExecStart=/usr/bin/npm run db:cleanup -- --days 30
StandardOutput=journal
StandardError=journal
```

建立計時器檔案 `/etc/systemd/system/ba-backend-cleanup.timer`:

```ini
[Unit]
Description=BA Backend Data Cleanup Timer
Requires=ba-backend-cleanup.service

[Timer]
OnCalendar=weekly
OnCalendar=Sun 02:00
Persistent=true

[Install]
WantedBy=timers.target
```

啟用計時器:

```bash
sudo systemctl enable ba-backend-cleanup.timer
sudo systemctl start ba-backend-cleanup.timer
```

#### 排程建議

**資料備份排程**:

- **頻率**: 每天或每週
- **時間**: 凌晨低峰時段（例如：02:00-04:00）
- **建議**: 先執行備份，確認成功後再考慮清理

**資料清理排程**:

- **頻率**: 每週或每月
- **時間**: 凌晨低峰時段
- **建議**: 與備份排程分開執行，避免同時進行

**監控與日誌**:

- 將輸出重導向到日誌檔案，方便追蹤執行結果
- 設定失敗通知機制（Email、Slack 等）
- 定期檢查備份檔案是否正常產生

**範例完整排程**:

```bash
# 每週日凌晨 1 點：備份 30 天前的資料（不刪除）
0 1 * * 0 cd /path/to/ba-backend && npm run db:backup -- --days 30 --backup-only >> /var/log/ba-backend-backup.log 2>&1

# 每週日凌晨 2 點：清理 30 天前的資料（先備份後刪除）
0 2 * * 0 cd /path/to/ba-backend && npm run db:cleanup -- --days 30 >> /var/log/ba-backend-cleanup.log 2>&1

# 每月 1 號凌晨 3 點：深度清理 90 天前的資料
0 3 1 * * cd /path/to/ba-backend && npm run db:cleanup -- --days 90 >> /var/log/ba-backend-cleanup.log 2>&1
```

### 2. 效能優化

- 已建立必要的索引，支援常見查詢
- `device_data_logs` 使用 `BIGINT` 作為主鍵，支援大量資料
- 使用連線池管理資料庫連線，避免連線過多

### 3. 資料完整性

- 使用外鍵約束確保資料完整性
- 使用 `CASCADE` 確保刪除設備時相關資料一併清理
- 使用 `SET NULL` 確保刪除用戶時不影響設備記錄

---

## 🔍 常見查詢範例

### 查詢設備及其建立者

```sql
SELECT
  d.*,
  u.username as created_by_username
FROM devices d
LEFT JOIN users u ON d.created_by = u.id
WHERE d.status = 'online';
```

### 查詢設備最新資料

```sql
SELECT
  d.name,
  d.modbus_host,
  d.modbus_port,
  d.modbus_unit_id,
  d.status,
  d.last_seen_at,
  (SELECT COUNT(*) FROM device_data_logs WHERE device_id = d.id) as log_count,
  (SELECT COUNT(*) FROM device_alerts WHERE device_id = d.id AND resolved = FALSE) as active_alerts
FROM devices d
ORDER BY d.last_seen_at DESC;
```

### 查詢告警統計

```sql
SELECT
  alert_type,
  severity,
  COUNT(*) as count
FROM device_alerts
WHERE resolved = FALSE
GROUP BY alert_type, severity
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'error' THEN 2
    WHEN 'warning' THEN 3
    WHEN 'info' THEN 4
  END;
```

---

## ⚠️ 注意事項

1. **字符集**: 所有表使用 `utf8mb4` 字符集，支援完整的 Unicode（包括 emoji）
2. **時區**: 所有 `TIMESTAMP` 欄位使用伺服器時區，建議統一使用 UTC
3. **JSON 欄位**: `device_data_logs.value` 使用 JSON 類型，MySQL 5.7+ 支援
4. **外鍵約束**: 確保刪除順序正確，避免外鍵約束錯誤
5. **索引維護**: 定期檢查索引使用情況，必要時優化

---

## 🚀 後續擴充建議

1. **設備分組**: 新增 `device_groups` 表，支援設備分組管理
2. **權限管理**: 新增 `user_device_permissions` 表，支援細粒度權限控制
3. **資料匯出**: 新增資料匯出功能，支援 CSV/Excel 格式
4. **備份策略**: 建立自動備份機制，定期備份資料庫
5. **監控告警**: 整合監控系統，自動產生告警記錄
