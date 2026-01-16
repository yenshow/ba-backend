# 外部資料架構說明文件

## 概述

本架構提供了一個通用且可擴展的系統，用於處理外部資料庫的查詢需求。系統採用分層架構設計，支援不同 schema 和 table 的專用處理邏輯。

## 架構設計

```
┌─────────────────────────────────────────┐
│         API 路由層                      │
│    (externalDataRoutes.js)              │
│  - 白名單驗證                           │
│  - 處理器驗證                           │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│         處理器工廠層                     │
│      (handlerFactory.js)                 │
│  - 管理所有處理器                        │
│  - 動態選擇對應處理器                    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│         處理器層                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Person       │  │ Person Group │  │ Door         │    │
│  │ Head Pic     │  │ Slot Records │  │              │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         └────────┬─────────┘            │
│                  ▼                      │
│      BaseExternalDataService            │
│        (基礎服務類別)                    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│         資料庫層                         │
│        (externalDb.js)                  │
│  - PostgreSQL 連線池                    │
│  - SQL 查詢執行                          │
└─────────────────────────────────────────┘
```

## 檔案結構

```
src/
├── services/
│   └── externalData/
│       ├── baseExternalDataService.js    # 基礎服務類別
│       ├── handlerFactory.js             # 處理器工廠
│       ├── systemMapping.js              # 系統與資料表對應關係
│       └── handlers/
│           ├── platformPersonHandler.js
│           ├── platformPersonGroupHandler.js
│           ├── platformPersonHeadPicHandler.js
│           ├── baseacsSlotCardRecordsHandler.js
│           └── deviceaccessDoorHandler.js
├── routes/
│   └── externalDataRoutes.js             # API 路由
└── scripts/
    └── externalData.js                   # 資料抓取腳本
```

## 已實作的處理器

### 1. Platform Person Handler

**資料表**：`platform.person`

**功能**：

- 預設只顯示 `person_type = 0`（一般人員）
- 可搜尋欄位：`full_name`, `given_name`, `family_name`, `person_code`, `email`
- 特殊方法：`getPersonTypeLabel(personType)` - 取得人員類型標籤

**關鍵欄位**：

- `id` - 人員 ID
- `person_group_id` - 人員群組 ID
- `person_type` - 人員類型（0: 一般人員, 1: 訪客, 2: 黑名單）
- `full_name` - 人員全名

### 2. Platform Person Group Handler

**資料表**：`platform.person_group`

**功能**：

- 預設只顯示 `is_deleted = 0`（未刪除）
- 可搜尋欄位：`name`

**關鍵欄位**：

- `id` - 人員群組 ID
- `name` - 人員群組名稱
- `is_deleted` - 是否刪除（0: 未刪除, 1: 已刪除）

### 3. Platform Person Head Pic Handler

**資料表**：`platform.person_head_pic`

**功能**：

- 預設按 `id` 降序排序（最新的在前）
- 可搜尋欄位：`person_id`
- 特殊方法：`getHeadPicIdByPersonId(personId)` - 根據人員 ID 取得頭像 ID

**關鍵欄位**：

- `id` - 人員頭像 ID
- `person_id` - 人員 ID
- `standard_head_portrait` - 頭像資料（Base64 編碼）

**Base64 資料處理**：

- Base64 編碼的圖片資料會直接返回，**不需要在後端解碼**
- 前端可直接使用 Base64 資料：
  ```html
  <img src="data:image/jpeg;base64,{standard_head_portrait}" />
  ```
- 如需解碼為二進位資料，應在前端使用 `atob()` 或 `Buffer.from()`

### 4. Baseacs Slot Card Records Handler

**資料表**：`baseacs.slot_card_records`

**功能**：

- 預設按 `swip_card_rev_time` 降序排序（最新的在前）
- 預設只顯示 `is_deleted = false`（未刪除）
- 可搜尋欄位：`full_name`, `card_no`, `message_key`
- **自動標記 `is_registered`**：`person_id = -1` 時為 `false`（未註冊），此欄位會在後處理中自動加入，供前端顯示使用
- **時間範圍篩選**：支援多種時間範圍查詢
- **`physical_id` 欄位**：已包含在查詢結果中，可用於對應到 `deviceaccess.door` 表
- 特殊方法：
  - `getUnregisteredRecords()` - 取得未註冊人員的刷卡記錄
  - `getRecordsByPersonId()` - 取得特定人員的刷卡記錄

**關鍵欄位**：

- `physical_id` - 物理設備 ID（可能對應到 `deviceaccess.door.id`）
- `person_id` - 人員 ID（-1 代表未註冊）
- `swip_card_rev_time` - 刷卡時間
- `snap_pic_url` - 抓拍圖片 URL
- `is_registered` - 是否已註冊（自動計算，`person_id !== -1` 時為 `true`）

**時間範圍篩選**：

支援以下時間範圍參數（`timeRange`）：

| 值             | 說明               |
| -------------- | ------------------ |
| `last_hour`    | 過去一小時         |
| `today`        | 今天               |
| `yesterday`    | 昨天               |
| `this_week`    | 本週（週一到今天） |
| `last_week`    | 上週（週一到週日） |
| `last_30_days` | 最近 30 天         |

**自訂時間範圍**：

使用 `startTime` 和 `endTime` 參數（ISO 8601 格式）：

```bash
GET /api/external-data/baseacs/slot_card_records?startTime=2025-01-01T00:00:00Z&endTime=2025-01-31T23:59:59Z
```

### 5. Deviceaccess Door Handler

**資料表**：`deviceaccess.door`

**功能**：

- 預設只顯示 `is_deleted = 0`（未刪除）
- 可搜尋欄位：`dev_name`, `guid`
- 特殊方法：
  - `getDoorsByDeviceId(deviceId)` - 根據設備 ID 取得門列表
  - `getDoorByPhysicalId(physicalId)` - 根據 physical_id 取得門資訊（需確認對應關係）

**關鍵欄位**：

- `id` - 門 ID（可能對應到 `baseacs.slot_card_records.physical_id`）
- `device_id` - 門禁設備 ID
- `dev_name` - 門名稱
- `door_index` - 門在設備中的序號
- `is_deleted` - 是否刪除（0: 未刪除, 1: 已刪除）

**與 `baseacs.slot_card_records` 的關聯**：

- `baseacs.slot_card_records.physical_id` 可能對應到 `deviceaccess.door.id`
- 需要實際測試確認對應關係
- 如需關聯查詢，建議在服務層進行，而非在處理器中直接 JOIN（跨資料庫）

使用 `startTime` 和 `endTime` 參數（ISO 8601 格式）：

```bash
GET /api/external-data/baseacs/slot_card_records?startTime=2025-01-01T00:00:00Z&endTime=2025-01-31T23:59:59Z
```

## API 端點

### 1. 取得資料列表

**端點**：`GET /api/external-data/:schema/:table`

**查詢參數**：

| 參數             | 類型   | 說明                               | 範例                       |
| ---------------- | ------ | ---------------------------------- | -------------------------- |
| `limit`          | number | 每頁筆數（預設：50，最大：1000）   | `10`                       |
| `offset`         | number | 偏移量（預設：0）                  | `20`                       |
| `orderBy`        | string | 排序欄位（預設依處理器而定）       | `full_name`                |
| `orderDirection` | string | 排序方向（ASC/DESC）               | `DESC`                     |
| `columns`        | string | 指定欄位（逗號分隔）               | `id,full_name,person_type` |
| `search`         | string | 搜尋關鍵字（會搜尋所有可搜尋欄位） | `Tony`                     |
| `{欄位名}`       | any    | 篩選條件（等於）                   | `person_type=0`            |

**範例**：

```bash
# 取得人員列表
GET /api/external-data/platform/person?limit=10

# 取得人員頭像（特定人員）
GET /api/external-data/platform/person_head_pic?person_id=1

# 取得刷卡記錄（未註冊人員）
GET /api/external-data/baseacs/slot_card_records?person_id=-1

# 取得今天的刷卡記錄
GET /api/external-data/baseacs/slot_card_records?timeRange=today

# 取得門禁設備列表
GET /api/external-data/deviceaccess/door?is_deleted=0

# 取得特定設備的門列表
GET /api/external-data/deviceaccess/door?device_id=28

# 取得過去一小時的刷卡記錄
GET /api/external-data/baseacs/slot_card_records?timeRange=last_hour

# 取得最近 30 天的刷卡記錄
GET /api/external-data/baseacs/slot_card_records?timeRange=last_30_days

# 自訂時間範圍
GET /api/external-data/baseacs/slot_card_records?startTime=2025-01-01T00:00:00Z&endTime=2025-01-31T23:59:59Z

# 搜尋和排序
GET /api/external-data/platform/person?search=Tony&orderBy=full_name&orderDirection=ASC
```

**回應格式**：

```json
{
  "success": true,
  "data": [...],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "count": 10
  }
}
```

### 2. 取得單筆資料

**端點**：`GET /api/external-data/:schema/:table/:id`

**範例**：

```bash
GET /api/external-data/platform/person/2
GET /api/external-data/platform/person_head_pic/1
GET /api/external-data/baseacs/slot_card_records/100
GET /api/external-data/deviceaccess/door/10
```

### 3. 取得資料總數

**端點**：`GET /api/external-data/:schema/:table/count`

**範例**：

```bash
GET /api/external-data/platform/person/count
GET /api/external-data/platform/person/count?person_group_id=1
```

**回應格式**：

```json
{
  "success": true,
  "data": {
    "count": 150
  }
}
```

### 4. 取得處理器列表

**端點**：`GET /api/external-data/handlers`

**回應格式**：

```json
{
  "success": true,
  "data": [
    "platform.person",
    "platform.person_group",
    "platform.person_head_pic",
    "baseacs.slot_card_records",
    "deviceaccess.door"
  ]
}
```

## 擴展指南

### 新增處理器（三步驟）

#### 步驟 1：建立處理器檔案

在 `src/services/externalData/handlers/` 建立新檔案：

```javascript
const BaseExternalDataService = require("../baseExternalDataService");

class MyHandler extends BaseExternalDataService {
  constructor() {
    super("schema", "table", {
      defaultOrderBy: "id",
      defaultOrderDirection: "DESC",
      defaultLimit: 50,
      maxLimit: 1000,
    });
  }

  getSearchableColumns() {
    return ["field1", "field2"];
  }

  async getList(filters = {}) {
    // 自訂邏輯（可選）
    if (filters.status === undefined) {
      filters.status = "active";
    }
    return await super.getList(filters);
  }
}

module.exports = MyHandler;
```

#### 步驟 2：註冊處理器

在 `src/services/externalData/handlerFactory.js` 中：

```javascript
const MyHandler = require("./handlers/myHandler");

// 在 constructor 中加入
this.register("schema", "table", new MyHandler());
```

#### 步驟 3：加入白名單

在 `src/routes/externalDataRoutes.js` 的 `ALLOWED_TABLES` 中：

```javascript
const ALLOWED_TABLES = [
  // ... 現有的
  { schema: "schema", table: "table" },
];
```

## 核心組件

### BaseExternalDataService

提供所有處理器的通用功能：

- **查詢方法**：

  - `getList(filters)` - 取得資料列表
  - `getById(id)` - 取得單筆資料
  - `getCount(filters)` - 取得資料總數

- **可覆寫方法**：
  - `getSearchableColumns()` - 定義可搜尋欄位
  - `validateOrderBy(orderBy)` - 驗證排序欄位

### HandlerFactory

管理處理器的註冊與取得：

- `register(schema, table, handler)` - 註冊處理器
- `getHandler(schema, table)` - 取得處理器
- `hasHandler(schema, table)` - 檢查處理器是否存在
- `getAllHandlers()` - 取得所有處理器列表

## 安全機制

1. **JWT 認證**：所有端點都需要認證
2. **白名單驗證**：只允許存取白名單中的資料表
3. **處理器驗證**：確保處理器存在才執行查詢
4. **SQL 注入防護**：使用參數化查詢

## 注意事項

1. **路由順序**：固定路徑（`/handlers`、`/count`）必須放在動態路徑（`/:id`）之前
2. **預設行為**：各處理器可能有預設過濾條件（如 `person_type = 0`、`is_deleted = 0`）
3. **分頁限制**：最大分頁大小為 1000 筆（可在處理器中自訂）
4. **Base64 資料**：圖片 Base64 資料直接返回，前端可直接使用，無需後端解碼

## 完整性檢查（目前狀態）

- **外部資料庫連線**：`src/database/externalDb.js` 透過 `EXTERNAL_DB_*` 環境變數建立 PostgreSQL 連線池
- **安全性**：
  - 所有端點必須通過 JWT 認證（`authenticate`）
  - 只能存取白名單表（`ALLOWED_TABLES`）
  - 查詢使用參數化，避免 SQL injection
- **擴展性**：新增 table 只需新增 handler + 註冊 + 白名單三步驟
- **穩定性**：
  - `scripts/externalData.js` 呼叫 API 有 timeout（避免無限等待）
  - 已避免 `nodemon` 因寫入 `output/` 而自動重啟導致連線中斷（見下方）

## 測試與資料抓取

### 統一腳本

所有外部資料相關操作已合併為單一腳本 `scripts/externalData.js`，支援兩種模式：

#### 1. 測試模式

測試所有 API 端點：

```bash
npm run external-data:test
```

#### 2. 抓取模式

抓取資料並儲存到檔案：

```bash
npm run external-data:fetch
```

### 認證設定

腳本會自動從 `.env` 檔案讀取認證資訊，**無需手動輸入密碼**：

**使用者名稱**：

1. `API_USER` - 指定 API 登入用戶名（可選）
2. 如果未設定，自動從資料庫查詢第一個管理員帳號

**密碼**：

- `API_PASSWORD` - **必填**，這是 `users` 表中管理員帳號的密碼（不是資料庫密碼）

**範例 `.env` 設定**：

```env
# API 登入認證（用於測試和資料抓取）
API_USER=admin
API_PASSWORD=your_admin_password
```

**重要提醒**：

- `API_PASSWORD` 是 `users` 表中管理員帳號的密碼，**不是**資料庫密碼
- 如果未設定 `API_USER`，腳本會自動從資料庫查詢第一個管理員帳號
- 如果忘記密碼，可以使用 `npm run admin:create` 建立新的管理員帳號

### 輸出檔案

抓取模式會產生以下檔案到 `output` 目錄：

- `platform-person-{timestamp}.json` / `.txt` - 人員資料
- `platform-person_group-{timestamp}.json` / `.txt` - 群組資料
- `platform-person_head_pic-{timestamp}.json` / `.txt` - 頭像資料
- `baseacs-slot_card_records-{timestamp}.json` / `.txt` - 刷卡記錄

> 注意：目前 **不再輸出** `external-data-summary-{timestamp}.json/.txt`（避免產生多餘彙總檔案）

## 開發模式注意（避免 ECONNRESET）

若使用 `npm run dev`（nodemon）啟動後端，`scripts/externalData.js fetch` 會寫入 `output/`，若 nodemon 監控到檔案變更將自動重啟，會造成腳本端出現 `ECONNRESET`。

已透過專案根目錄的 `nodemon.json` 讓 nodemon **只監控 `src/`**，並忽略 `output/`、`docs/`：

```json
{
  "watch": ["src"],
  "ignore": ["output/**", "docs/**", "*.log"],
  "ext": "js,json"
}
```

若你是新增此檔後才遇到問題，請**重啟** `npm run dev` 讓設定生效。

## 架構優勢

1. **可擴展性**：新增處理器只需三個步驟
2. **可維護性**：各處理器獨立，業務邏輯集中
3. **可重用性**：基礎服務提供通用功能
4. **安全性**：多層驗證機制
5. **靈活性**：每個處理器可自訂邏輯

## 多系統支援

### 系統分類架構

系統已支援多系統分類，每個系統可以定義其使用的資料表。目前實作的系統：

- **people_counting**（人流統計系統）：使用 5 個資料表
  - `platform.person`
  - `platform.person_group`
  - `platform.person_head_pic`
  - `baseacs.slot_card_records`
  - `deviceaccess.door`

### 系統對應關係配置

系統對應關係定義在 `src/services/externalData/systemMapping.js`：

```javascript
const SYSTEM_TABLE_MAPPING = {
  people_counting: [
    { schema: "platform", table: "person" },
    // ... 其他資料表
  ],
  // 未來可以加入其他系統
};
```

### 新增系統的步驟

1. **在 `systemMapping.js` 中加入系統定義**

   ```javascript
   new_system: [
     { schema: "schema", table: "table" },
   ],
   ```

2. **建立對應的處理器**（如需要特殊邏輯）

   - 在 `src/services/externalData/handlers/` 建立處理器
   - 繼承 `BaseExternalDataService`

3. **註冊處理器**

   - 在 `handlerFactory.js` 中註冊

4. **加入白名單**
   - 在 `externalDataRoutes.js` 的 `ALLOWED_TABLES` 中加入

### API 端點

#### 取得所有系統

```bash
GET /api/external-data/systems
```

回應：

```json
{
  "success": true,
  "data": {
    "systems": [
      {
        "systemType": "people_counting",
        "tables": [...],
        "tableCount": 5
      }
    ]
  }
}
```

#### 取得指定系統的資料表

```bash
GET /api/external-data/systems/:systemType/tables
```

範例：

```bash
GET /api/external-data/systems/people_counting/tables
```

#### 取得資料表被哪些系統使用

```bash
GET /api/external-data/tables/:schema/:table/systems
```

範例：

```bash
GET /api/external-data/tables/platform/person/systems
```

### 資料抓取腳本

#### 按系統抓取資料

```bash
# 抓取人流統計系統的資料（預設）
npm run external-data:fetch

# 抓取指定系統的資料
npm run external-data:fetch -- --system=people_counting
```

#### 輸出檔案命名

- 預設模式：`{schema}-{table}-{timestamp}.json`
- 系統模式：`{systemType}-{schema}-{table}-{timestamp}.json`

### 共用資料表

一個資料表可能被多個系統使用（例如 `platform.person` 可能同時被 `people_counting` 和 `visitor_management` 使用）。系統會自動追蹤這種對應關係。

## 未來改進

- 快取機制
- 查詢優化
- 批次查詢
- 更嚴格的欄位驗證
- 操作日誌記錄
- 系統級別的權限控制
