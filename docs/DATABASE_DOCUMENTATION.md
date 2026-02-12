# 資料庫文檔

## 目錄

1. [概述](#概述)
2. [快速開始](#快速開始)
3. [PostgreSQL 設定](#postgresql-設定)
4. [Schema 初始化](#schema-初始化)
5. [資料庫結構](#資料庫結構)
6. [設計原則](#設計原則)
7. [遷移歷史](#遷移歷史)
8. [疑難排解](#疑難排解)
9. [連接與注意事項](#連接與注意事項)

---

## 概述

本專案使用 **PostgreSQL** 作為資料庫，並支援**可攜式 PostgreSQL**（無需系統安裝）。

**特點**：開源可攜式、跨平台、自動下載、連接資訊統一存於 `config` JSONB、`unitId` 可自動生成。備份由伺服器定時執行，見 `docs/SYSTEM_DATA_AND_BACKUP.md`。

---

## 快速開始

```bash
npm install
npm run postgres:download   # 只需一次
npm run postgres:start
npm run db:init
npm run db:test
npm run admin:create
npm run dev
```

---

## PostgreSQL 設定

### 可攜式 PostgreSQL

- **下載**：`npm run postgres:download`（失敗時可至 [GitHub Releases](https://github.com/theseus-rs/postgresql-binaries/releases) 手動下載對應平台的 `postgresql-<版本>-<target>.tar.gz` 放入 `postgres/`）
- **支援平台**：macOS (aarch64/x86_64)、Windows x64、Linux (x64/aarch64)
- **目錄**：`postgres/` → `bin/`、`lib/`、`data/`、`logs/`、`share/`

### 環境變數

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=ba_system
```

### 常用指令

| 指令                                       | 說明                   |
| ------------------------------------------ | ---------------------- |
| `npm run postgres:download`                | 下載並設定（只需一次） |
| `npm run postgres:start` / `postgres:stop` | 啟動／停止 PostgreSQL  |
| `npm run db:init`                          | 初始化 Schema          |
| `npm run db:test`                          | 測試連線               |
| `npm run admin:create`                     | 建立管理員             |

### 技術要點

- 驅動：`pg`，支援連線池；參數化查詢使用 `$1, $2, ...`
- 自增：`SERIAL` / `BIGSERIAL`；JSON：`JSONB`；衝突：`INSERT ... ON CONFLICT`；插入 ID：`RETURNING id`

---

## Schema 初始化

- **執行**：`npm run db:init` 或 `node src/database/initSchema.js`
- **流程**：連到 `postgres` → 若無目標庫則建立 `ba_system` → 連到目標庫 → 建立 ENUM、表、索引、觸發器、預設資料
- **ENUM**：`user_role`、`user_status`、`device_status`、`register_type`、`alert_type`、`alert_severity`、`alert_source`、`alert_status`
- **觸發器**：`update_updated_at_column()` 套用於所有含 `updated_at` 的表
- **相容性**：腳本可重複執行（idempotent）；會補齊 `device_models.port`、`zones.image_url`、`locations.description`、`unique_zone_location_name`、`alert_source` 枚舉值、`location_systems` 的 `vehicle_access` 等

---

## 資料庫結構

### 使用者

| 表        | 說明       | 關鍵欄位                                                                                                          |
| --------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| **users** | 系統使用者 | `id`, `username`, `email`, `password_hash`, `role` (user_role), `status` (user_status), `created_at`/`updated_at` |

### 設備

| 表                | 說明     | 關鍵欄位                                                                                                                                                                                                                            |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **device_types**  | 設備類型 | `id`, `name`, `code` (唯一), `description`。預設：camera, sensor, controller, access_control                                                                                                                                       |
| **device_models** | 設備型號 | `id`, `name`, `type_id`→device_types, `port` (預設 502), `config` JSONB, `created_at`/`updated_at`                                                                                                                                  |
| **devices**       | 設備實例 | `id`, `name`, `model_id`(必填)→device_models, `type_id`→device_types, `location`, `description`, `status` (device_status), `config` JSONB, `last_seen_at`, `created_by`→users, 時間戳。索引：status, type_id, model_id, GIN(config) |

**devices.config 依類型**（連接資訊皆在 config，無獨立 modbus 欄位）：

- **controller**：`type`, `host`(必), `port`(可選，可繼承 model.port), `unitId`(可選，可自動生成)
- **camera**：`type`, `ip_address`(必)
- **sensor**：`type`, `protocol`(modbus/http/mqtt), Modbus 時需 `host`, `port`, `unitId`
- **access_control**：`type`, `host`(必), `port`(選，預設 80), `username`(必), `password`(必)；ISAPI Digest Auth 用。型號差異存於 device_models.config（見 [ACCESS_CONTROL_DEVICE_DESIGN.md](./ACCESS_CONTROL_DEVICE_DESIGN.md)）

**查詢範例**：

```sql
-- 依類型
SELECT * FROM devices d
INNER JOIN device_types dt ON d.type_id = dt.id
WHERE dt.code = 'controller';

-- 依 config
SELECT * FROM devices
WHERE config->>'host' = '192.168.2.205' AND (config->>'port')::integer = 502;
```

### 人流與環境

| 表                       | 說明                                   | 關鍵欄位                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **people_counting_logs** | 人流刷卡記錄快取（同步自外部 baseacs） | `id` BIGSERIAL, `external_id`, `person_id`, `swip_card_rev_time`, `physical_id`, `person_name`, `unit_id`, `unit_name`, `snap_pic_url`, `location_id`, `created_at`。UNIQUE(person_id, swip_card_rev_time) |
| **environment_readings** | 環境感測器讀數（依地點）               | `id` BIGSERIAL, `location_id`→locations, `source_id`, `recorded_at`, `data` JSONB, `device_id`→devices, `created_at`。索引：(location_id, recorded_at), recorded_at                                        |

**說明**：`device_data_logs` 已移除，環境相關改為 `environment_readings`。

### 人員主檔與門禁權限（本系統）

| 表                       | 說明                         | 關鍵欄位                                                                                                                                 |
| ------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **person_groups**        | 人員群組                     | `id`, `name`, `description`, `created_by`→users, `created_at`/`updated_at`                                                               |
| **persons**              | 人員主檔                     | `id`, `employee_no`(唯一), `full_name`, `person_group_id`→person_groups, `status`, `face_url`, `config` JSONB, `created_by`/`user_id`→users, 時間戳 |
| **person_location_access** | 門禁權限（人員可進出地點）   | `id`, `person_id`→persons, `location_id`→locations, `created_at`。UNIQUE(person_id, location_id) |

人員與門禁設備同步由 API 觸發、同步執行 ISAPI；詳見 [PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md](./PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md)。

### 警報

| 表                 | 說明         | 關鍵欄位                                                                                                                                                                                                                                                                  |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **alerts**         | 統一警報     | `id`, `source` (alert_source), `source_id`, `alert_type`, `severity`, `message`, `status` (alert_status), `ignored_at`/`ignored_by`, `created_at`, `updated_at`。解決時間由 status=resolved 時之 updated_at 表示。索引：複合 (source, source_id, alert_type, status) 等。 |
| **error_tracking** | 錯誤狀態追蹤 | `id`, `source`, `source_id`, `error_count`, `last_error_at`, `alert_created`, 時間戳。UNIQUE(source, source_id)                                                                                                                                                           |
| **alert_rules**    | 警報規則     | `id`, `source`, `alert_type`, `severity`, `condition_type`, `condition_config` JSONB, `message_template`, `enabled`, 時間戳                                                                                                                                               |

### 地點

| 表                   | 說明           | 關鍵欄位                                                                                                                                                                                               |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **zones**            | 區域／樓層     | `id`, `name`(唯一), `building_id`, `image_url`, `description`, `created_by`→users, 時間戳                                                                                                              |
| **locations**        | 物理地點       | `id`, `zone_id`(必)→zones ON DELETE CASCADE, `name`, `description`, `created_by`, 時間戳。UNIQUE(zone_id, name)                                                                                        |
| **location_systems** | 地點－系統關聯 | `id`, `location_id`→locations ON DELETE CASCADE, `system_type` ('environment' \| 'lighting' \| 'people_counting' \| 'vehicle_access'), `system_config` JSONB, 時間戳。UNIQUE(location_id, system_type) |

**people_counting 的 system_config**（與門禁設備整合）：

- **person_group_ids**：人員群組 ID 陣列（YSCP 或本系統）。
- **entry_door_id** / **exit_door_id**：YSCP 出入口設備 ID（當 `data_source` 為 `yscp` 時使用）。
- **data_source**：`'yscp'`（預設）或 `'access_control'`。為 `access_control` 時改用本系統門禁設備。
- **entry_device_id** / **exit_device_id**：本系統 `devices.id`（門禁設備），當 `data_source === 'access_control'` 時必填入口。

### 照明與系統設定

| 表                      | 說明       | 關鍵欄位                                                                                                                                                                  |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **lighting_categories** | 照明分類點 | `id`, `name`, `zone_id`→zones, `location_x`/`location_y`, `description`, `device_id`→devices, `modbus_config` JSONB, `room_ids` INTEGER[], `status`, `created_by`, 時間戳 |
| **system_settings**     | 系統設定   | `id`, `key`(唯一), `value` TEXT, `description`, 時間戳                                                                                                                    |

---

## 設計原則

- **統一配置**：設備連接資訊僅存於 `devices.config` JSONB；`unitId` 可自動生成（同 host+port 下 1..255）。
- **地點架構**：zones → locations → location_systems，物理地點與系統配置分離，支援多 system_type。
- **統一警報**：所有來源用 `alerts` + `source`/`source_id`；按天限制等邏輯在應用層。
- **外鍵**：CASCADE（子隨父刪，如 locations→zones）、RESTRICT（防刪有引用，如 devices→device_models）、SET NULL（如 devices.created_by→users）。
- **索引**：外鍵欄位、常用查詢複合索引、部分索引（如 alerts 活躍）、JSONB 用 GIN。

---

## 遷移歷史

- 移除 devices 的 `modbus_host`、`modbus_port`、`modbus_unit_id`，改由 `config` 存儲。
- `model_id` 改為 NOT NULL，外鍵 ON DELETE RESTRICT。
- `device_models` 新增 `port`（預設 502）。
- 移除 `device_data_logs`，新增 `environment_readings`；新增 `people_counting_logs`。
- `location_systems.system_type` 支援 `vehicle_access`。

---

## 疑難排解

| 問題           | 處理                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 下載失敗 404   | 檢查 [Releases](https://github.com/theseus-rs/postgresql-binaries/releases)，手動下載對應平台 `.tar.gz` 至 `postgres/`，再執行 download |
| Windows 無 tar | 使用 Git for Windows 或 WSL                                                                                                             |
| 埠 5432 占用   | `lsof -i :5432`（macOS/Linux）或 `netstat -ano \| findstr :5432`（Windows）；或改 `.env` 的 `DB_PORT`                                   |
| 權限錯誤       | macOS/Linux：`chmod +x scripts/*.js`                                                                                                    |
| 解壓失敗       | 確認磁碟空間與寫入權限、檔案完整                                                                                                        |

---

## 連接與注意事項

**psql**：

```bash
./postgres/bin/psql -U postgres -d ba_system
# Windows: .\postgres\bin\psql.exe -U postgres -d ba_system
# 或: psql -U postgres -d ba_system -h 127.0.0.1 -p 5432
```

**外部工具**：Host `127.0.0.1`，Port `5432`，Database `ba_system`，User/Password `postgres`。

**注意**：`postgres/` 已在 `.gitignore`；可攜式設定為 `trust` 僅適合開發，生產請改 `pg_hba.conf`；Windows 防火牆可能需允許 PostgreSQL。

---

## 參考資料

- [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries)
- [PostgreSQL 官方文檔](https://www.postgresql.org/docs/)
- 後端架構：`docs/BACKEND_ARCHITECTURE_ANALYSIS.md`；警報實作：`docs/ALERT_IMPLEMENTATION_GUIDE.md`（若存在）
