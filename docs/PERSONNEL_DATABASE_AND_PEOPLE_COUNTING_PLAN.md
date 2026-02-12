# 人員資料庫與人流統計／區域／地點關聯規劃

## 1. 概述

本文件規劃在本系統新增**人員主檔（Personnel Database）**後，與**人流統計區域／地點**及**門禁設備**的關聯方式。本系統人員與外部資料庫（如 YSCP）**不做對應**，外部資料與本系統人員兩種方法分開處理。資料流程以「人流統計建立區域地點與設備」與「人員管理配對門禁權限」為主，設備端依權限透過 ISAPI 同步人員與人臉。

---

## 2. 現況分析

### 2.1 門禁設備與人員資料

| 項目 | 說明 |
|------|------|
| **資料所在** | 人員資料存在**門禁設備上**，經由 ISAPI 讀寫 |
| **服務層** | `src/services/accessControl/accessControlService.js`、`isapiClient.js` |
| **API** | `searchUserInfo`（查詢）、`updateUserInfo`（新增/修改）、`deleteUserInfo`（刪除）、`updateFace`、`captureFaceData` |
| **關鍵欄位** | `employeeNo`、`name`、`userType`、`Valid`、`doorRight`、`RightPlan`、`faceURL` 等（見 ISAPI UserInfo） |
| **路由** | `src/routes/accessControlRoutes.js`：`/api/access-control/devices/:deviceId/user-info` |

**結論**：門禁人員目前**沒有本系統的持久化主檔**，僅能透過設備 ID 查詢該設備上的名單；多台門禁設備之間也無統一人員主檔可對應。

### 2.2 外部系統（YSCP）人員與群組

| 項目 | 說明 |
|------|------|
| **人員表** | 外部 DB `platform.person`（id, person_group_id, person_type, full_name 等） |
| **群組表** | 外部 DB `platform.person_group`（id, name, is_deleted） |
| **用途** | 人流統計地點的「進場單位」= `personGroupIds`（YSCP 的 person_group_id 陣列） |
| **查詢** | `peopleCountingService.getPersonIdsByGroupIds(personGroupIds)` 查 `platform.person` 取得人員 ID 列表 |
| **刷卡記錄** | 外部 `baseacs.slot_card_records`（person_id, swip_card_rev_time, physical_id…），person_id = -1 表示未註冊 |

**結論**：人流統計（data_source = `yscp`）的人員與單位完全依賴**外部 YSCP**；本系統僅有 `people_counting_logs` 快取表，其 `person_id` 對應外部 `platform.person.id`。

### 2.3 人流統計與地點架構

| 項目 | 說明 |
|------|------|
| **地點架構** | `zones`（區域/樓層）→ `locations`（物理地點）→ `location_systems`（系統關聯） |
| **人流系統類型** | `location_systems.system_type = 'people_counting'` |
| **設定來源** | `location_systems.system_config`（JSONB）： |
| | • **data_source**：`'yscp'`（預設）或 `'access_control'` |
| | • **yscp**：`person_group_ids`（YSCP 群組 ID）、`entry_door_id`、`exit_door_id` |
| | • **access_control**：`entry_device_id`、`exit_device_id`（本系統門禁設備 ID）、`access_control_groups`（顯示用群組） |
| **記錄快取** | `people_counting_logs`：person_id, person_name, unit_id, unit_name, location_id, swip_card_rev_time 等 |

**結論**：人流「進場單位」目前為  
- **YSCP**：`personGroupIds` → 外部 `platform.person_group` + `platform.person`  
- **門禁**：無對應本系統人員主檔，僅設備上 UserInfo；`accessControlGroups` 為顯示用。

### 2.4 現有系統使用者（users）

| 項目 | 說明 |
|------|------|
| **表** | `users`（系統登入帳號） |
| **用途** | 登入後台、JWT 認證、角色權限（admin / operator / viewer） |
| **關鍵欄位** | id, username, email, password_hash, role, status, created_at, updated_at |
| **引用** | devices.created_by、alerts.ignored_by、zones/locations/lighting_categories.created_by |

**結論**：`users` = **誰可以登入 BA 系統**；與門禁/人流的「人員」（誰可以刷門禁、有人臉）職責不同，見下方 3.4 與 10 節。

### 2.5 小結：人員資料流

```
現況：
┌─────────────────┐     ISAPI      ┌──────────────────┐
│ 門禁設備         │ ◄────────────► │ 設備上 UserInfo   │  （無本系統主檔）
└─────────────────┘                └──────────────────┘
         │
         │ data_source=access_control
         ▼
┌─────────────────┐                ┌─────────────────────┐
│ 人流地點         │   personGroupIds │ platform.person      │
│ (location_       │ ◄──────────────► │ platform.person_group│  （YSCP 外部）
│  systems)        │   (僅 yscp)     └─────────────────────┘
└────────┬────────┘                          │
         │                                    │
         ▼                                    ▼
┌─────────────────┐                ┌─────────────────────┐
│ people_counting_│   person_id ──►│ 外部 person_id      │
│ logs            │                │ 或 -1(未註冊)       │
└─────────────────┘                └─────────────────────┘
```

---

## 3. 目標資料流程與關聯

### 3.1 設計原則

- **本系統與外部資料分開**：本系統人員／群組**不**與外部資料庫（如 YSCP）做 `external_id` 或 `code` 對應；外部資料由既有流程處理，本系統人員由本系統獨立管理。
- **權限以「區域地點」為單位**：門禁權限 = 人員可進出的**系統區域地點**（`locations`）；一名人員可擁有多個門禁權限（多個地點）。
- **設備依權限同步**：同一區域地點的入口與出口設備，人員名單一致；有權限則 ISAPI 新增人員與人臉，無權限則刪除。

### 3.2 資料流程（目標）

**步驟一：人流統計系統頁面**

- 建立**區域**（zones）、**地點**（locations）。
- 為地點配對**出入口設備**（entry_device_id、exit_device_id），即該地點的門禁入口／出口設備。

**步驟二：人員管理頁面**

- 建立**人員群組**（person_groups）、**人員資料**（persons）。
- 為人員配對**門禁權限** = 可進出的**系統區域地點**（多對多：一名人員可勾選多個地點）。
- 門禁權限僅指向本系統的 zones／locations，不對應外部 DB。

**步驟三：設備同步（依門禁權限 + ISAPI）**

- 以「區域地點」為單位：每個有配對入口／出口設備的地點，取得該地點**有權限的人員列表**（本系統 persons）。
- **有權限**：在該地點的**入口設備**與**出口設備**上，以 ISAPI **新增**該人員資料與人臉比對；若已存在則更新。
- **無權限**：在該地點的**入口設備**與**出口設備**上，以 ISAPI **刪除**該人員。
- **一致性**：同一區域地點的入口設備與出口設備，人員名單**一致處理**（同一份名單同步至兩台設備）。

### 3.3 概念關聯圖

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 人流統計系統頁面                                                          │
│  區域 (zones) → 地點 (locations) → 配對 入口設備 / 出口設備                │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      │ 每個地點有 entry_device_id, exit_device_id
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 人員管理頁面                                                              │
│  人員群組 (person_groups) → 人員 (persons) → 門禁權限（多個地點）          │
│  門禁權限 = person_location_access (person_id, location_id)               │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      │ 同步規則：有權限→新增/更新人臉，無權限→刪除
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 設備同步（ISAPI）                                                         │
│  依「地點」為單位：該地點有權限的人員 → 入口設備 + 出口設備 一致寫入/刪除   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.4 與現有 users 的關係（建議不合併）

| 維度 | users（現有） | persons（本規劃） |
|------|----------------|-------------------|
| **職責** | 系統登入帳號（誰能登入 BA 後台） | 門禁／人員主檔（誰能刷門禁、有人臉） |
| **辨識** | username / email | employee_no |
| **認證** | password_hash、JWT | 無（門禁以人臉/卡） |
| **引用** | created_by、ignored_by 等稽核 | 門禁權限、設備同步 |

**建議：不合併為同一張表。**

- 一人可能「只有系統帳號」「只有門禁人員」「兩者皆有」；合併會讓欄位混雜（password 與 face 同表）、權限與稽核複雜。
- **可選關聯**（稽核與便利）：
  - **persons.created_by** → users(id)：記錄「哪個系統使用者建立/異動此人員」，與 zones、locations 一致。
  - **persons.user_id** → users(id)（可選）：若「此門禁人員同時擁有系統帳號」可存對應 user_id，供前端顯示或單一登入擴充；無則 NULL。

---

## 4. 資料庫設計建議

### 4.1 本系統人員群組表：`person_groups`

供人員所屬單位使用，**不與外部資料庫對應**（無 external_id／code 對應）。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PRIMARY KEY | 主鍵 |
| name | VARCHAR(255) NOT NULL | 群組名稱（如單位/工地別） |
| description | TEXT | 說明 |
| created_by | INTEGER REFERENCES users(id) ON DELETE SET NULL | 建立者（稽核，可選） |
| created_at, updated_at | TIMESTAMPTZ | 時間戳 |

### 4.2 本系統人員表：`persons`

**不與外部資料庫對應**（無 external_id／source 對應）；員工編號為本系統唯一識別，同步至門禁設備時作為 ISAPI 的 employeeNo。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PRIMARY KEY | 主鍵 |
| employee_no | VARCHAR(64) NOT NULL | 員工編號（同步至門禁時即為 ISAPI employeeNo） |
| full_name | VARCHAR(255) | 姓名 |
| person_group_id | INTEGER REFERENCES person_groups(id) ON DELETE SET NULL | 所屬群組 |
| status | VARCHAR(32) DEFAULT 'active' | 狀態：active / inactive / deleted |
| face_url | TEXT | 人臉圖 URL（可選，預覽用） |
| config | JSONB | 擴充欄位（門禁 RightPlan、備註等） |
| created_by | INTEGER REFERENCES users(id) ON DELETE SET NULL | 建立者（稽核，可選） |
| user_id | INTEGER REFERENCES users(id) ON DELETE SET NULL | 對應系統帳號（可選，無則 NULL） |
| created_at, updated_at | TIMESTAMPTZ | 時間戳 |

- **唯一約束**：`employee_no` UNIQUE。
- **索引**：person_group_id、status。
- **人臉**：不建議本系統存 BYTEA；同步時由上傳檔或設備擷取即時送 ISAPI 即可（見 8.2）。

### 4.3 門禁權限表：`person_location_access`

人員與「可進出的區域地點」多對多；**門禁權限 = 該人員可進出的地點列表**。

| 欄位 | 類型 | 說明 |
|------|------|------|
| id | SERIAL PRIMARY KEY | 主鍵 |
| person_id | INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE | 人員 |
| location_id | INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE | 地點（本系統 locations.id） |
| created_at | TIMESTAMPTZ | 時間戳 |

- **唯一約束**：UNIQUE(person_id, location_id)。
- **索引**：location_id（依地點查有權限的人員）、person_id（依人員查可進出地點）。

**業務意義**：人員管理頁面為人員勾選「可進出的地點」時，寫入/刪除本表。設備同步時，依 location_id 查出有權限的 person_id 列表，再對該地點的 entry_device_id、exit_device_id 做 ISAPI 新增/刪除。

### 4.4 人流地點與設備（沿用 location_systems）

**現有** `location_systems.system_config`（people_counting，data_source = `access_control`）已有：

- `entry_device_id` / `exit_device_id`：該地點的入口／出口門禁設備（devices.id）。
- 人流統計頁面建立區域、地點後，在此配對出入口設備。

**設備同步邏輯**（見 4.6）：以「地點」為單位，從 `person_location_access` 取得該 location_id 下有權限的人員，對 entry_device_id、exit_device_id **一致**進行 ISAPI 新增/刪除與人臉寫入。

### 4.5 刷卡記錄與本系統人員關聯：`people_counting_logs`（可選擴充）

**現有**：person_id 多為外部 platform.person.id 或 -1。

**可選**：新增 `internal_person_id` INTEGER REFERENCES persons(id) ON DELETE SET NULL，在可識別為本系統人員時寫入；原 `person_id` 保留。本系統報表可優先以 `internal_person_id` 維度查詢。

### 4.6 設備同步規則（ISAPI）

- **以地點為單位**：遍歷有 `people_counting` 且 `data_source = 'access_control'` 的 location，取得 `entry_device_id`、`exit_device_id`。
- **該地點目標人員**：從 `person_location_access` 取得該 `location_id` 下所有 `person_id`，再從 `persons` 取得有效（如 status = 'active'）人員的 employee_no、full_name、face 等。
- **入口設備**：  
  - 有權限且設備上無此人 → ISAPI 新增人員 + 人臉。  
  - 有權限且設備上已有此人 → 可選更新。  
  - 無權限但設備上有此人 → ISAPI 刪除。
- **出口設備**：與入口設備**同一份目標名單**，同樣執行新增/刪除，使入口與出口設備人員名單一致。
- **本實作**：同步請求**直接執行** ISAPI（同步執行），無佇列、無 worker。若單一地點人員數不多，請求可於合理時間內完成；日後若需大批量再考慮加回佇列（見 5.5 說明）。

### 4.7 批次與佇列（可選擴充）

ISAPI 僅支援單人新增/刪除，若一次同步人數很多或匯入後一次觸發多地點，可考慮改為佇列：表 `person_sync_jobs` 記錄任務，背景 worker 輪詢執行，API 回傳 jobId、前端輪詢任務狀態。本實作未採用，維持同步執行以精簡架構。

---

## 5. 服務與 API 規劃

### 5.1 人員群組 CRUD

- **表**：`person_groups`。
- **API**：`GET/POST /api/personnel/groups`，`GET/PUT/DELETE /api/personnel/groups/:id`。刪除時需檢查是否有 persons 引用。

### 5.2 人員 CRUD 與查詢

- **表**：`persons`。
- **API**：`GET/POST /api/personnel/persons`，`GET/PUT/DELETE /api/personnel/persons/:id`。列表可依 person_group_id、status 篩選。可選 `GET /api/personnel/persons/by-employee-no/:employeeNo`。

### 5.3 門禁權限（人員 ↔ 地點）

- **表**：`person_location_access`。
- **API**：  
  - `GET /api/personnel/persons/:personId/access-locations`：該人員可進出的地點列表。  
  - `PUT /api/personnel/persons/:personId/access-locations`：Body `{ locationIds: number[] }`，覆寫該人員的門禁權限（多個地點）。  
  - 或 `POST /api/personnel/person-location-access`、`DELETE` 單筆，依前端操作習慣選擇。

### 5.4 人流統計頁面（區域／地點／設備）

- 沿用現有 zones、locations、location_systems（people_counting）與 `entry_device_id`、`exit_device_id`。
- 建立/更新人流地點時配對入口、出口設備即可；不需本文件新增欄位。

### 5.5 設備同步（本實作採**同步執行**，無佇列）

- **依地點同步**：`POST /api/personnel/sync-location/:locationId` 直接對該地點入口/出口設備執行 ISAPI，完成後回傳 `{ success: true }`。
- **全量同步**：`POST /api/personnel/sync-all-locations` 對所有可同步地點依序執行，回傳 `{ synced: number[] }`。
- 底層沿用 `accessControlService`：`searchUserInfo`、`updateUserInfo`、`deleteUserInfo`。

**關於 person_sync_jobs（佇列表）**  
原規劃可選「佇列 + worker」：因 ISAPI 僅支援單人新增/刪除，大量人員或 Excel 匯入時，若在單一請求內依序呼叫會逾時或阻塞，故以 `person_sync_jobs` 表記錄任務、背景 worker 依序執行。  
**本實作不採用佇列**：改為同步執行，不寫入任務表、無背景 worker，實作簡單；若單一地點人員數不多（例如數十人內），請求在合理時間內可完成。若日後需支援大批量（例如上百人或多地點一次觸發），再考慮加回佇列與 worker。

### 5.6 批次匯入（JSON）

- **匯入 API**：`POST /api/personnel/import`（JSON）。  
  - Body：`{ persons: [ { employeeNo, fullName?, personGroupId?, locationIds? } ] }`；  
  - 寫入 `persons`、`person_location_access`，回傳匯入摘要與錯誤行；  
  - 不自動觸發同步，由前端依需求呼叫 sync-location 或 sync-all-locations。  
- 後續可擴充：Excel 解析、範本下載、錯誤行回報。

---

## 6. 實作階段建議

### Phase 1：人員主檔、群組與門禁權限

1. 建立 `person_groups`、`persons`、`person_location_access` 表與索引、FK（locations 已存在，person_location_access 參照 locations.id）。  
2. 實作 person_groups、persons、person_location_access 的 CRUD 與 API（門禁權限的取得/覆寫）。  
3. 人員管理頁面：建立群組、人員，並為人員配對門禁權限（多個地點）。  
4. 不變更現有 YSCP／人流地點設定邏輯；本系統人員與外部資料分開處理。

### Phase 2：設備同步（ISAPI，同步執行）

1. 實作「依地點」同步：取得該地點 entry/exit 設備、有權限人員，與設備現有名單 diff 後依序 ISAPI 新增/刪除。  
2. API：`POST /api/personnel/sync-location/:locationId`、`POST /api/personnel/sync-all-locations` 直接執行並回傳結果，無佇列。

### Phase 3：批次匯入與人流報表（可選）

1. **Excel 匯入**：`POST /api/personnel/import`，解析後寫入 persons + person_location_access，並將受影響地點排入同步佇列。  
2. 人流統計若使用本系統人員維度：依 `person_location_access` + `persons` 顯示「該地點可進出人員」；`people_counting_logs` 可選新增 `internal_person_id`。  
3. 報表與儀表板以本系統人員／群組為維度。

---

## 7. 風險與注意事項

- **入口與出口一致**：同一地點的 entry_device_id、exit_device_id 必須以同一份人員名單同步，避免兩台設備名單不一致。  
- **人臉資料**：人員新增/編輯時若上傳人臉，需在同步至設備時一併呼叫 `updateFace`；若人臉僅在設備端擷取，則同步時可依設備既有資料不重複上傳。  
- **權限**：人員/群組/門禁權限 API 建議僅管理員或指定角色可寫入；同步 API 同上。  
- **locations 範圍**：`person_location_access.location_id` 建議僅允許「有 people_counting（access_control）且已配對 entry/exit 設備」的地點」，避免同步時設備為空。

---

## 8. 架構檢視與優化

### 8.1 與現有 users 的取捨

- **不合併**：users = 系統登入，persons = 門禁／人員主檔，職責分離（見 3.4）。  
- **可選關聯**：`persons.created_by` → users(id) 稽核；`persons.user_id` → users(id) 表示「此人擁有系統帳號」；不影響既有 users 表與登入流程。

### 8.2 精簡與優化

| 項目 | 建議 | 說明 |
|------|------|------|
| **persons.face_data** | 建議移除或延後 | BYTEA 存人臉體積大、與設備端可能重複；人臉可改為「同步時由上傳檔或設備擷取」即時送 ISAPI，本系統僅保留 face_url（預覽用）或省略。若未來需離線比對再考慮 face_data。 |
| **persons / person_groups.created_by** | 建議新增 | 與 zones、locations、devices 一致，便於稽核；FK → users(id) ON DELETE SET NULL。 |
| **person_groups** | 保留 | 用於所屬單位顯示與篩選；門禁權限仍以 person_location_access 為準，群組不重複表達權限。 |
| **person_location_access** | 無冗餘 | 必要多對多，無需刪減。 |
| **同步 API 行為** | 已納入 4.7 / 5.5 | 同步改為佇列 + job_id，避免長時間阻塞與 ISAPI 單人限制；Excel 匯入與大量異動皆經佇列。 |

### 8.3 多餘與重複

- **無重複表**：person_groups、persons、person_location_access 各司其職；與 users 分離後無概念重疊。  
- **location_systems**：沿用既有 people_counting + entry/exit_device_id，不新增「本系統人員群組」欄位，權限完全由 person_location_access 表達，避免地點設定與權限雙重維護。

### 8.4 小結

- 不與 users 合併；可選 persons.created_by / user_id 關聯。  
- 同步一律經佇列；ISAPI 單人限制以「每地點一 job、job 內依序處理」因應；Excel 匯入後排入受影響地點的 job。  
- face_data 建議省略或延後；persons / person_groups 可加 created_by 與現有稽核一致。

---

## 9. 相關文件

- [DATABASE_DOCUMENTATION.md](./DATABASE_DOCUMENTATION.md) — 現有 DB 結構、location_systems、people_counting_logs、locations  
- [ACCESS_CONTROL_DEVICE_DESIGN.md](./ACCESS_CONTROL_DEVICE_DESIGN.md) — 門禁設備與人流 data_source  
- [EXTERNAL_DATA_ARCHITECTURE.md](./EXTERNAL_DATA_ARCHITECTURE.md) — 外部 platform.person / person_group（本系統人員與其分開處理）

---

## 10. 附錄：表結構 SQL 草稿（Phase 1）

```sql
-- 人員群組（本系統，不與外部對應）
CREATE TABLE IF NOT EXISTS person_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 人員（本系統；employee_no 同步至門禁即為 ISAPI employeeNo）
-- face_data 可省略，人臉改為同步時由上傳檔/設備擷取送 ISAPI
CREATE TABLE IF NOT EXISTS persons (
  id SERIAL PRIMARY KEY,
  employee_no VARCHAR(64) NOT NULL UNIQUE,
  full_name VARCHAR(255),
  person_group_id INTEGER REFERENCES person_groups(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  face_url TEXT,
  config JSONB,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_persons_person_group_id ON persons(person_group_id);
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);

-- 門禁權限：人員可進出的地點（多對多）
CREATE TABLE IF NOT EXISTS person_location_access (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(person_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_person_location_access_location_id ON person_location_access(location_id);
CREATE INDEX IF NOT EXISTS idx_person_location_access_person_id ON person_location_access(person_id);

-- 觸發器 updated_at（與現有專案一致）
-- 依 initSchema.js 的 createUpdatedAtTrigger 對 person_groups、persons 各建一次
```

以上為人員資料庫與人流統計／區域／地點關聯的完整規劃；本實作採同步執行、無佇列，門禁權限以「區域地點」為單位。
