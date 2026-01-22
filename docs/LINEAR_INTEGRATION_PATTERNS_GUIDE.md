# Linear 整合模式知識庫設定指南

**建立日期**：2026-01-22  
**目的**：將 Linear 作為整合模式知識庫，讓建立新系統時能快速參考已建立的整合方式

---

## 📋 目錄

1. [概述](#概述)
2. [前置準備](#前置準備)
3. [步驟一：建立專案與設定](#步驟一建立專案與設定)
4. [步驟二：建立 Custom Fields](#步驟二建立-custom-fields)
5. [步驟三：建立 Labels](#步驟三建立-labels)
6. [步驟四：建立整合模式 Issue 模板](#步驟四建立整合模式-issue-模板)
7. [步驟五：建立實作範例 Issue](#步驟五建立實作範例-issue)
8. [步驟六：使用知識庫建立新系統](#步驟六使用知識庫建立新系統)
9. [維護與更新](#維護與更新)

---

## 概述

### 目標

透過 Linear 建立一個可搜尋、可連結、可重用的整合模式知識庫，類似 MCP（Model Context Protocol）的知識參考功能。

### 核心價值

- ✅ **快速參考**：建立新系統時快速找到相關整合模式
- ✅ **避免重複**：重用已建立的整合方式，保持一致性
- ✅ **知識傳承**：記錄每個系統如何整合各種模式
- ✅ **持續改進**：模式改進時可更新，所有相關系統可見

---

## 前置準備

### 1. Linear 帳號與 Workspace

- 確保已有 Linear Workspace 存取權限
- 建議建立專用的 Workspace 或 Team：`BA System` 或 `ba-backend`

### 2. 了解現有整合模式

在開始設定前，建議先閱讀以下文檔：

- `docs/EXTERNAL_DATA_ARCHITECTURE.md` - 外部資料整合模式
- `docs/MONITORING_SYSTEM.md` - 監控系統整合模式
- `docs/ALERT_IMPLEMENTATION_GUIDE.md` - 警報系統整合模式
- `docs/BACKEND_ARCHITECTURE_ANALYSIS.md` - 整體架構分析

---

## 步驟一：建立專案與設定

### 1.1 建立「整合模式知識庫」專案

1. 在 Linear 中點擊左側「Projects」
2. 點擊「+ New Project」
3. 設定專案資訊：
   - **名稱**：`整合模式知識庫`
   - **描述**：`存放所有可重用的整合模式與實作範例，供新系統建立時參考`
   - **狀態**：`Active`

### 1.2 設定專案檢視

建議建立以下檢視（Views）：

- **所有模式**：顯示所有 `pattern:reusable` 標籤的 Issue
- **實作範例**：顯示所有 `pattern:example` 標籤的 Issue
- **依模式類型**：依 Custom Field「模式類型」分組

---

## 步驟二：建立 Custom Fields

### 2.1 建立 Custom Fields

在 Linear 設定中（Settings → Custom Fields），建立以下欄位：

#### Field 1：模式類型（Pattern Type）

- **名稱**：`模式類型`
- **類型**：`Select`（單選）
- **選項值**：
  - `external-data` - 外部資料整合
  - `monitoring` - 監控系統整合
  - `alert` - 警報系統整合
  - `websocket` - WebSocket 推送
  - `device-logging` - 設備資料記錄
  - `backup` - 備份系統
  - `example` - 實作範例
  - `other` - 其他

#### Field 2：適用系統（Used By Systems）

- **名稱**：`適用系統`
- **類型**：`Multi-select`（多選）
- **選項值**：
  - `environment` - 環境系統
  - `lighting` - 照明系統
  - `people_counting` - 人流統計系統
  - `device` - 設備系統
  - `yscp` - YSCP 系統（如適用）
  - `other` - 其他系統

#### Field 3：參考檔案（Reference Files）

- **名稱**：`參考檔案`
- **類型**：`Text`（文字）
- **說明**：對應的程式檔案路徑，例如：`src/services/externalData/baseExternalDataService.js`

#### Field 4：文檔連結（Documentation Link）

- **名稱**：`文檔連結`
- **類型**：`URL`（網址）
- **說明**：相關文檔的連結，例如：`docs/EXTERNAL_DATA_ARCHITECTURE.md`

---

## 步驟三：建立 Labels

### 3.1 建立模式標籤（Pattern Labels）

在 Linear 設定中（Settings → Labels），建立以下標籤：

#### 重用性標籤

- `pattern:reusable` - 可重用的整合模式（用於模式模板）
- `pattern:example` - 實作範例（用於已實作的系統範例）
- `pattern:template` - 模板 Issue（可複製使用）

#### 整合類型標籤

- `integration:external-data` - 外部資料整合
- `integration:monitoring` - 監控系統整合
- `integration:alert` - 警報系統整合
- `integration:websocket` - WebSocket 推送
- `integration:device-logging` - 設備資料記錄
- `integration:backup` - 備份系統

### 3.2 標籤顏色建議

- **pattern:** 系列：藍色系
- **integration:** 系列：綠色系

---

## 步驟四：建立整合模式 Issue 模板

為每個整合模式建立一個 Issue，作為知識庫入口。

### 4.1 外部資料整合模式

**建立步驟**：

1. 在「整合模式知識庫」專案中建立新 Issue
2. 設定以下資訊：

**標題**：
```
[整合模式] 外部資料系統整合 - BaseExternalDataService
```

**描述**（複製以下內容）：
```markdown
## 整合模式概述

此模式用於整合外部資料庫（如 BaseACS、Platform），提供統一的查詢介面。

## 核心組件

- **基類**：`src/services/externalData/baseExternalDataService.js`
  - 提供通用查詢、分頁、篩選功能
  - 子類別可覆寫 `getSearchableColumns()`、`validateOrderBy()` 等方法

- **工廠**：`src/services/externalData/handlerFactory.js`
  - 管理所有處理器的註冊與取得
  - 支援動態選擇對應處理器

- **系統映射**：`src/services/externalData/systemMapping.js`
  - 定義系統與資料表的對應關係
  - 支援多系統共用資料表

## 已使用此模式的系統

- ✅ **people_counting**（人流統計系統）
  - 使用 5 個外部資料表
  - 參考實作：`src/services/externalData/handlers/*`

## 整合步驟（三步驟）

### 步驟 1：建立 Handler

在 `src/services/externalData/handlers/` 建立新處理器：

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

### 步驟 2：註冊處理器

在 `src/services/externalData/handlerFactory.js` 中：

```javascript
const MyHandler = require("./handlers/myHandler");

// 在 constructor 中加入
this.register("schema", "table", new MyHandler());
```

### 步驟 3：加入白名單

在 `src/routes/externalDataRoutes.js` 的 `ALLOWED_TABLES` 中：

```javascript
const ALLOWED_TABLES = [
  // ... 現有的
  { schema: "schema", table: "table" },
];
```

## 參考範例

- **實作範例**：`src/services/externalData/handlers/platformPersonHandler.js`
- **完整文檔**：`docs/EXTERNAL_DATA_ARCHITECTURE.md`

## 相關 Issue

- [實作範例] 人流統計系統外部資料整合（連結到對應 Issue）

## 注意事項

1. **路由順序**：固定路徑（`/handlers`、`/count`）必須放在動態路徑（`/:id`）之前
2. **預設行為**：各處理器可能有預設過濾條件（如 `person_type = 0`、`is_deleted = 0`）
3. **分頁限制**：最大分頁大小為 1000 筆（可在處理器中自訂）
4. **安全性**：所有端點都需要 JWT 認證，只能存取白名單表
```

**Custom Fields**：
- 模式類型：`external-data`
- 適用系統：`people_counting`
- 參考檔案：`src/services/externalData/baseExternalDataService.js`
- 文檔連結：`docs/EXTERNAL_DATA_ARCHITECTURE.md`

**Labels**：
- `pattern:reusable`
- `pattern:template`
- `integration:external-data`

**狀態**：`Done`（已完成，作為參考模板）

---

### 4.2 監控系統整合模式

**建立步驟**：

1. 建立新 Issue

**標題**：
```
[整合模式] 背景監控系統整合 - backgroundMonitor
```

**描述**（複製以下內容）：
```markdown
## 整合模式概述

統一管理所有系統的背景監控任務，支援並行執行、錯誤隔離、狀態追蹤。

## 核心組件

- **統一管理器**：`src/services/monitoring/backgroundMonitor.js`
  - 註冊與執行所有監控任務
  - 支援並行執行（`Promise.allSettled`）
  - 錯誤隔離（單個任務失敗不影響其他任務）

- **監控任務**：各系統的 monitor（如 `environmentMonitor.js`）
  - 實作具體的監控邏輯
  - 使用 `logger` 記錄日誌
  - 錯誤不應重新拋出，由 `backgroundMonitor` 統一處理

## 已使用此模式的系統

- ✅ **environment**（環境系統）
  - 監控感測器狀態，檢查閾值規則
  - 參考實作：`src/services/monitoring/environmentMonitor.js`

- ✅ **lighting**（照明系統）
  - 監控設備連線狀態
  - 參考實作：`src/services/monitoring/lightingMonitor.js`

- ✅ **people_counting**（人流統計系統）
  - 監控刷卡記錄，檢測未註冊人員
  - 參考實作：`src/services/monitoring/peopleCountingMonitor.js`

## 整合步驟

### 步驟 1：建立監控任務函數

在對應的 monitor 檔案中實作：

```javascript
const logger = require("../../utils/logger");
const backgroundMonitor = require("./backgroundMonitor");

async function monitorMySystem() {
  try {
    // 1. 查詢需要監控的資料
    const items = await getItemsToMonitor();
    
    // 2. 並行或順序處理（依需求選擇）
    // 並行處理（適合設備狀態監控）
    await Promise.allSettled(
      items.map(async (item) => {
        // 監控邏輯
      })
    );
    
    // 或順序處理（適合事件流監控）
    for (const item of items) {
      // 監控邏輯
    }
    
    // 3. 記錄日誌（使用 logger，不要 console.log）
    logger.info("[mySystemMonitor] 監控完成");
  } catch (error) {
    // 錯誤不應重新拋出，只需記錄
    logger.error("[mySystemMonitor] 監控失敗:", error);
  }
}
```

### 步驟 2：註冊監控任務

在 `src/services/monitoring/backgroundMonitor.js` 啟動時註冊：

```javascript
// 在 backgroundMonitor.start() 中
backgroundMonitor.registerMonitoringTask(
  "my_system",
  monitorMySystem
);
```

## 處理模式差異

| 模式 | 適用場景 | 實作方式 | 範例 |
|------|---------|---------|------|
| **並行處理** | 設備狀態監控 | `Promise.allSettled()` | 環境系統、照明系統 |
| **順序處理** | 事件流監控 | `for...of` 循環 | 人流統計系統 |

## 設計原則

1. **統一錯誤處理**：任務內部錯誤由 `backgroundMonitor` 統一捕獲
2. **錯誤隔離**：單個任務失敗不影響其他任務
3. **狀態追蹤**：只在狀態改變時推送 WebSocket 事件（適用於設備狀態監控）
4. **結構化日誌**：統一使用 `logger` 進行日誌記錄

## 參考範例

- **環境監控**：`src/services/monitoring/environmentMonitor.js`
- **照明監控**：`src/services/monitoring/lightingMonitor.js`
- **人流監控**：`src/services/monitoring/peopleCountingMonitor.js`
- **完整文檔**：`docs/MONITORING_SYSTEM.md`

## 相關 Issue

- [實作範例] 環境系統監控整合（連結到對應 Issue）
- [實作範例] 照明系統監控整合（連結到對應 Issue）
- [實作範例] 人流統計系統監控整合（連結到對應 Issue）
```

**Custom Fields**：
- 模式類型：`monitoring`
- 適用系統：`environment`, `lighting`, `people_counting`
- 參考檔案：`src/services/monitoring/backgroundMonitor.js`
- 文檔連結：`docs/MONITORING_SYSTEM.md`

**Labels**：
- `pattern:reusable`
- `pattern:template`
- `integration:monitoring`

**狀態**：`Done`

---

### 4.3 警報系統整合模式

**建立步驟**：

1. 建立新 Issue

**標題**：
```
[整合模式] 統一警報系統整合 - systemAlertHelper
```

**描述**（複製以下內容）：
```markdown
## 整合模式概述

統一所有系統的警報建立與處理方式，確保一致的實作規範。

## 核心組件

- **統一輔助**：`src/services/alerts/systemAlertHelper.js`
  - 提供統一的警報創建接口
  - 支援多系統配置（environment, lighting, people_counting, device）

- **規則服務**：`src/services/alerts/alertRuleService.js`
  - 管理警報規則配置
  - 提供規則匹配和訊息格式化

- **警報服務**：`src/services/alerts/alertService.js`
  - 警報 CRUD 操作
  - 狀態管理（active/resolved/ignored）

## 已使用此模式的系統

- ✅ **environment**（環境系統）- 閾值警報
- ✅ **lighting**（照明系統）- 離線警報
- ✅ **people_counting**（人流統計系統）- 未註冊人員警報
- ✅ **device**（設備系統）- 設備離線警報

## 整合步驟

### 步驟 1：查詢警報規則

```javascript
const alertRuleService = require("../alerts/alertRuleService");

// 閾值類警報
const rules = await alertRuleService.getThresholdRules("environment");

// 錯誤次數類警報
const rule = await alertRuleService.getErrorCountRule("lighting", "offline");

// 一般警報（使用統一規則匹配）
const rules = await alertRuleService.getAlertRules("people_counting", "error");
const matchedRule = alertRuleService.matchRule(
  rules,
  "unregistered_person",  // conditionType
  sourceId
);
```

### 步驟 2：格式化訊息

```javascript
let message;
if (matchedRule?.message_template) {
  message = alertRuleService.formatMessage(matchedRule.message_template, {
    location_name: locationName,
    device_info: deviceInfo,
    // ... 其他變數
  });
} else {
  message = `預設訊息 - ${locationName}`; // 向後兼容
}
```

### 步驟 3：建立警報

**方式一：使用 `systemAlert.createAlert()`（推薦）**

適用於已註冊的系統（environment, lighting）：

```javascript
const systemAlert = require("../alerts/systemAlertHelper");

await systemAlert.createAlert(
  "environment",  // 系統名稱
  systemId,        // source_id
  "threshold",     // alert_type
  matchedRule.severity,
  message
);
```

**方式二：使用 `alertService.createAlert()`**

適用於所有系統：

```javascript
const alertService = require("../alerts/alertService");

await alertService.createAlert({
  source: alertService.ALERT_SOURCES.PEOPLE_COUNTING,
  source_id: sourceId,
  alert_type: alertService.ALERT_TYPES.ERROR,
  severity,
  message,
});
```

### 步驟 4：自動解決機制

當問題恢復時自動解決對應警報：

```javascript
if (problemResolved) {
  await alertService.updateAlertStatus(
    sourceId,
    source,
    alertType,
    alertService.ALERT_STATUS.RESOLVED,
    null, // 系統自動解決
    "問題已恢復正常"
  );
}
```

## 統一實作規範

1. **統一使用規則配置**：所有警報都應從 `alert_rules` 表讀取配置
2. **統一使用訊息模板**：使用 `alertRuleService.formatMessage()` 格式化訊息
3. **統一使用創建接口**：優先使用 `systemAlert.createAlert()` 或 `alertService.createAlert()`
4. **自動解決機制**：當問題恢復時應自動解決對應警報

## 參考範例

- **環境警報**：`src/services/monitoring/environmentMonitor.js`（閾值警報）
- **設備警報**：`src/services/alerts/errorTracker.js`（錯誤次數警報）
- **人流警報**：`src/services/monitoring/peopleCountingMonitor.js`（事件警報）
- **完整文檔**：`docs/ALERT_IMPLEMENTATION_GUIDE.md`

## 相關 Issue

- [實作範例] 環境系統警報整合（連結到對應 Issue）
- [實作範例] 照明系統警報整合（連結到對應 Issue）
- [實作範例] 人流統計系統警報整合（連結到對應 Issue）
```

**Custom Fields**：
- 模式類型：`alert`
- 適用系統：`environment`, `lighting`, `people_counting`, `device`
- 參考檔案：`src/services/alerts/systemAlertHelper.js`
- 文檔連結：`docs/ALERT_IMPLEMENTATION_GUIDE.md`

**Labels**：
- `pattern:reusable`
- `pattern:template`
- `integration:alert`

**狀態**：`Done`

---

## 步驟五：建立實作範例 Issue

為每個已建立的系統建立一個 Issue，記錄其如何整合各模式。

### 5.1 人流統計系統整合範例

**建立步驟**：

1. 建立新 Issue

**標題**：
```
[實作範例] 人流統計系統完整整合流程
```

**描述**（複製以下內容）：
```markdown
## 系統概述

人流統計系統整合了外部資料、監控、警報、WebSocket 等多個模式，是一個完整的整合範例。

## 使用的整合模式

### 1. ✅ 外部資料整合

**模式**：[整合模式] 外部資料系統整合（連結到對應 Issue）

**實作內容**：
- 使用 5 個外部資料表：
  - `platform.person` - 人員資料
  - `platform.person_group` - 人員群組
  - `platform.person_head_pic` - 人員頭像
  - `baseacs.slot_card_records` - 刷卡記錄
  - `deviceaccess.door` - 門禁設備

**實作檔案**：
- `src/services/externalData/handlers/platformPersonHandler.js`
- `src/services/externalData/handlers/baseacsSlotCardRecordsHandler.js`
- 其他 handlers...

**系統映射**：
- 在 `systemMapping.js` 中定義 `people_counting` 系統使用的資料表

### 2. ✅ 監控系統整合

**模式**：[整合模式] 背景監控系統整合（連結到對應 Issue）

**實作內容**：
- 實作 `peopleCountingMonitor.js`
- 使用順序處理模式（事件流監控）
- 監控刷卡記錄，檢測未註冊人員

**實作檔案**：
- `src/services/monitoring/peopleCountingMonitor.js`

**註冊方式**：
```javascript
backgroundMonitor.registerMonitoringTask(
  "people_counting",
  monitorPeopleCounting
);
```

### 3. ✅ 警報系統整合

**模式**：[整合模式] 統一警報系統整合（連結到對應 Issue）

**實作內容**：
- 未註冊人員刷卡警報
- 使用規則匹配和訊息模板
- 自動解決機制（當人員註冊後自動解決）

**實作檔案**：
- `src/services/monitoring/peopleCountingMonitor.js`（警報建立邏輯）

**規則配置**：
- 在 `alert_rules` 表中配置 `people_counting` 系統的警報規則

### 4. ✅ WebSocket 推送

**實作內容**：
- 即時推送新刷卡記錄
- 使用 `websocketService.emitPeopleCountingRecord()`

**實作檔案**：
- `src/services/monitoring/peopleCountingMonitor.js`（WebSocket 推送邏輯）

## 完整實作檔案清單

- **監控**：`src/services/monitoring/peopleCountingMonitor.js`
- **服務**：`src/services/systems/peopleCountingService.js`
- **路由**：`src/routes/peopleCountingRoutes.js`
- **外部資料處理器**：
  - `src/services/externalData/handlers/platformPersonHandler.js`
  - `src/services/externalData/handlers/platformPersonGroupHandler.js`
  - `src/services/externalData/handlers/platformPersonHeadPicHandler.js`
  - `src/services/externalData/handlers/baseacsSlotCardRecordsHandler.js`
  - `src/services/externalData/handlers/deviceaccessDoorHandler.js`

## 完整文檔

- `docs/PEOPLE_COUNTING_SYSTEM.md` - 系統完整說明
- `docs/EXTERNAL_DATA_ARCHITECTURE.md` - 外部資料架構
- `docs/MONITORING_SYSTEM.md` - 監控系統說明
- `docs/ALERT_IMPLEMENTATION_GUIDE.md` - 警報實作指南

## 整合流程圖

```
外部資料庫 (BaseACS, Platform)
    ↓
外部資料 Handler (BaseExternalDataService)
    ↓
人流統計監控 (peopleCountingMonitor)
    ├─ 讀取刷卡記錄
    ├─ 檢測未註冊人員
    ├─ 建立警報 (systemAlertHelper)
    └─ 推送 WebSocket 事件
```

## 參考的整合模式

- [整合模式] 外部資料系統整合（BA-XXX）
- [整合模式] 背景監控系統整合（BA-XXX）
- [整合模式] 統一警報系統整合（BA-XXX）

## 注意事項

1. **外部資料**：需要確保外部資料庫連線正常
2. **監控頻率**：每 15 秒執行一次監控
3. **警報規則**：需要在 `alert_rules` 表中配置對應規則
4. **WebSocket**：需要確保 WebSocket 服務正常運行
```

**Custom Fields**：
- 模式類型：`example`
- 適用系統：`people_counting`
- 參考檔案：`src/services/monitoring/peopleCountingMonitor.js`
- 文檔連結：`docs/PEOPLE_COUNTING_SYSTEM.md`

**Labels**：
- `pattern:example`
- `integration:external-data`
- `integration:monitoring`
- `integration:alert`

**狀態**：`Done`

---

### 5.2 環境系統整合範例

**建立步驟**：

1. 建立新 Issue

**標題**：
```
[實作範例] 環境系統完整整合流程
```

**描述**（複製以下內容）：
```markdown
## 系統概述

環境系統整合了監控、警報、設備資料記錄等模式。

## 使用的整合模式

### 1. ✅ 監控系統整合

**模式**：[整合模式] 背景監控系統整合（連結到對應 Issue）

**實作內容**：
- 實作 `environmentMonitor.js`
- 使用並行處理模式（設備狀態監控）
- 監控感測器狀態，檢查閾值規則

### 2. ✅ 警報系統整合

**模式**：[整合模式] 統一警報系統整合（連結到對應 Issue）

**實作內容**：
- 閾值警報（PM2.5、溫度等）
- 使用 `alertRuleService.getThresholdRules()`
- 自動解決機制

### 3. ✅ 設備資料記錄

**實作內容**：
- 使用 `deviceDataLogger` 記錄感測器資料
- 資料儲存到 `device_data_logs` 表

## 完整實作檔案清單

- **監控**：`src/services/monitoring/environmentMonitor.js`
- **服務**：`src/services/systems/environmentService.js`
- **路由**：`src/routes/environmentRoutes.js`

## 完整文檔

- `docs/MONITORING_SYSTEM.md` - 監控系統說明
- `docs/ALERT_IMPLEMENTATION_GUIDE.md` - 警報實作指南
```

**Custom Fields**：
- 模式類型：`example`
- 適用系統：`environment`
- 參考檔案：`src/services/monitoring/environmentMonitor.js`
- 文檔連結：`docs/MONITORING_SYSTEM.md`

**Labels**：
- `pattern:example`
- `integration:monitoring`
- `integration:alert`

**狀態**：`Done`

---

## 步驟六：使用知識庫建立新系統

### 6.1 搜尋相關整合模式

當需要建立新系統時：

1. 在 Linear 中搜尋：
   - 使用標籤：`pattern:reusable` + `integration:*`
   - 或搜尋關鍵字：「外部資料」、「監控」、「警報」

2. 查看「整合模式知識庫」專案：
   - 瀏覽所有整合模式 Issue
   - 查看每個模式的「適用系統」Custom Field

### 6.2 複製模板 Issue

1. 找到對應的「整合模式」Issue
2. 使用 Linear 的「複製 Issue」功能（或手動建立）
3. 修改為新系統的實作 Issue

### 6.3 參考實作範例

1. 查看「實作範例」Issue（如人流統計系統）
2. 對照新系統需求，選擇需要的整合模式
3. 參考對應的程式檔案和文檔

### 6.4 建立新系統 Issue

**標題**：
```
[新系統] XXX 系統整合
```

**描述模板**：
```markdown
## 系統需求

（描述新系統的功能需求）

## 需要整合的模式

- [ ] 外部資料整合（參考 [整合模式] 外部資料系統整合 - BA-XXX）
- [ ] 監控系統整合（參考 [整合模式] 背景監控系統整合 - BA-XXX）
- [ ] 警報系統整合（參考 [整合模式] 統一警報系統整合 - BA-XXX）
- [ ] WebSocket 推送（參考相關 Issue）
- [ ] 設備資料記錄（參考相關 Issue）

## 實作計劃

1. [ ] 建立外部資料 Handler（如需要）
2. [ ] 建立監控任務函數
3. [ ] 註冊監控任務
4. [ ] 實作警報邏輯
5. [ ] 建立 API 路由
6. [ ] 測試整合功能

## 參考範例

- [實作範例] 人流統計系統完整整合流程（BA-XXX）
- [實作範例] 環境系統完整整合流程（BA-XXX）

## 相關整合模式

- [整合模式] 外部資料系統整合（BA-XXX）
- [整合模式] 背景監控系統整合（BA-XXX）
- [整合模式] 統一警報系統整合（BA-XXX）

## 實作檔案

（實作完成後補充）

- 監控：`src/services/monitoring/xxxMonitor.js`
- 服務：`src/services/systems/xxxService.js`
- 路由：`src/routes/xxxRoutes.js`
```

**Custom Fields**：
- 模式類型：`example`（實作完成後）
- 適用系統：`xxx`（新系統名稱）

**Labels**：
- `pattern:example`（實作完成後）
- 相關的 `integration:*` 標籤

**狀態**：`In Progress` → `Done`（實作完成後）

---

## 維護與更新

### 7.1 更新整合模式

當整合模式有改進時：

1. 更新對應的「整合模式」Issue
2. 在 Issue 描述中記錄變更歷史
3. 通知相關的「實作範例」Issue（使用 Relations）

### 7.2 新增整合模式

當發現新的整合模式時：

1. 建立新的「整合模式」Issue
2. 設定 Custom Fields 和 Labels
3. 標記為 `pattern:reusable` 和 `pattern:template`

### 7.3 更新實作範例

當系統有重大變更時：

1. 更新對應的「實作範例」Issue
2. 記錄變更內容和原因
3. 更新「使用的整合模式」清單

### 7.4 定期檢視

建議每個月檢視一次：

1. 檢查是否有新的整合模式需要記錄
2. 檢查是否有系統需要建立實作範例
3. 更新文檔連結（如果文檔有變更）

---

## 快速參考

### 常用搜尋

- **找整合模式**：標籤 `pattern:reusable`
- **找實作範例**：標籤 `pattern:example`
- **找外部資料整合**：標籤 `integration:external-data`
- **找監控整合**：標籤 `integration:monitoring`
- **找警報整合**：標籤 `integration:alert`

### 常用 Custom Fields

- **模式類型**：快速篩選不同類型的模式
- **適用系統**：查看哪些系統使用了此模式
- **參考檔案**：快速找到對應的程式檔案
- **文檔連結**：快速找到相關文檔

### 建立新系統檢查清單

- [ ] 搜尋相關整合模式
- [ ] 複製模板 Issue
- [ ] 參考實作範例
- [ ] 建立新系統 Issue
- [ ] 實作整合功能
- [ ] 更新實作範例 Issue
- [ ] 更新「適用系統」Custom Field

---

## 總結

透過以上步驟，Linear 將成為一個強大的整合模式知識庫，讓建立新系統時能夠：

1. ✅ **快速找到**相關的整合模式
2. ✅ **重用**已建立的整合方式
3. ✅ **保持一致性**，避免重複實作
4. ✅ **持續改進**，模式改進時所有相關系統可見

這樣就能達到類似 MCP 的知識參考效果，讓團隊在建立新系統時有清晰的參考依據。

---

**最後更新**：2026-01-22  
**維護者**：BA 後端團隊
