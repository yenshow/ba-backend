# 警報系統實作指南

**更新日期**：2026-02-10  
**狀態**：✅ 統一規範文檔  
**最後重構**：2026-02-10（統一 createAlert、精簡時間欄位）

---

## 📋 目錄

1. [概述](#概述)
2. [統一實作規範](#統一實作規範)
3. [各系統實作方式對比](#各系統實作方式對比)
4. [標準實作流程](#標準實作流程)
5. [規則配置規範](#規則配置規範)
6. [警報資料模型：時間與操作者欄位](#警報資料模型時間與操作者欄位)
7. [常見問題與解決方案](#常見問題與解決方案)

---

## 概述

本文檔旨在統一各系統的警報建立與處理方式，確保所有系統遵循相同的實作規範，避免不一致的實作方式導致維護困難。

### 核心原則

1. **統一使用規則配置**：所有警報都應從 `alert_rules` 表讀取配置
2. **統一使用訊息模板**：使用 `alertRuleService.formatMessage()` 格式化訊息
3. **統一使用創建接口**：一律使用 `alertService.createAlert()`
4. **自動解決機制**：當問題恢復時應自動解決對應警報

---

## 統一實作規範

### 1. 規則查詢方式

#### ✅ 正確方式

**閾值類警報**（如環境監控）：

```javascript
const rules = await alertRuleService.getThresholdRules("environment");
```

**錯誤次數類警報**（如設備離線）：

```javascript
const rule = await alertRuleService.getErrorCountRule("lighting", "offline");
```

#### ❌ 錯誤方式

```javascript
// 不要直接硬編碼 severity 和 message
await alertService.createAlert({
  source: "environment",
  source_id: sourceId,
  alert_type: "threshold",
  severity: "warning", // ❌ 應從規則讀取
  message: "自訂訊息", // ❌ 應使用模板
});
```

### 2. 規則匹配優先級

**標準優先級順序**：

1. **指定來源規則**（`condition_config.source_id` 匹配）
2. **全域規則**（`condition_config` 為空或沒有 `source_id`）
3. **預設值**（如果沒有規則）

**實作範例**：

```javascript
// 1. 查詢規則
const rules = await alertRuleService.getAlertRules(source, alertType);

// 2. 使用統一規則匹配函數（推薦）
const matchedRule = alertRuleService.matchRule(
  rules,
  conditionType,
  sourceId,
);

// 3. 使用規則或預設值
const severity = matchedRule?.severity || alertService.SEVERITIES.WARNING;
```

**注意**：`matchRule()` 函數內部已經處理了過濾和優先級匹配邏輯，無需手動實現。

### 3. 訊息格式化

**標準方式**：

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

### 4. 警報創建接口

一律使用 `alertService.createAlert()`：

```javascript
await alertService.createAlert({
  source: alertService.ALERT_SOURCES.ENVIRONMENT,
  source_id: sourceId,
  alert_type: "threshold",
  severity: matchedRule.severity,
  message,
});
```

### 5. 自動解決機制

**標準實作**：

```javascript
// 當問題恢復時，自動解決對應的警報
if (problemResolved) {
  await alertService.updateAlertStatus(
    sourceId,
    source,
    alertType,
    alertService.ALERT_STATUS.RESOLVED,
    null,
  );
}
```

---

## 各系統實作方式對比

### 環境警報（Environment）

**檔案**：`src/services/monitoring/environmentMonitor.js`

**實作方式**：

- ✅ 使用 `alertRuleService.getThresholdRules("environment")`
- ✅ 使用 `alertRuleService.evaluateThreshold()` 評估閾值
- ✅ 使用 `alertRuleService.formatMessage()` 格式化訊息
- ✅ 使用 `alertService.createAlert()` 創建警報
- ✅ 有自動解決機制（`resolveThresholdAlert()`）

**規則類型**：`threshold`

**condition_config 格式**：

```json
{
  "parameter": "pm25",
  "operator": ">",
  "value": 50,
  "unit": "µg/m³"
}
```

### 設備警報（Device/Lighting）

**檔案**：`src/services/alerts/errorTracker.js`

**實作方式**：

- ✅ 使用 `error_tracking` 表追蹤錯誤次數
- ✅ 使用 `alertRuleService.getErrorCountRule()` 查詢規則
- ✅ 使用 `alertRuleService.formatMessage()` 格式化訊息
- ✅ 使用 `alertService.createAlert()` 創建警報
- ✅ 有自動解決機制（`clearError()`）

**規則類型**：`error_count`

**condition_config 格式**：

```json
{
  "min_errors": 5
}
```

## 標準實作流程

### 流程圖

```
開始
  ↓
查詢警報規則
  ↓
過濾規則（根據 condition_type）
  ↓
匹配規則（優先級：指定來源 > 全域）
  ↓
評估條件（閾值/錯誤次數/其他）
  ↓
格式化訊息（使用模板）
  ↓
創建/更新警報
  ↓
（可選）自動解決機制
  ↓
結束
```

### 完整實作範例

```javascript
const alertService = require("../alerts/alertService");
const alertRuleService = require("../alerts/alertRuleService");

/**
 * 創建系統警報（統一規範實作）
 * @param {string} source - 系統來源
 * @param {number} sourceId - 來源 ID
 * @param {string} alertType - 警報類型
 * @param {string} conditionType - 條件類型（用於匹配規則）
 * @param {Object} messageVariables - 訊息模板變數
 * @returns {Promise<Object|null>} 創建的警報
 */
async function createSystemAlert(
  source,
  sourceId,
  alertType,
  conditionType,
  messageVariables,
) {
  try {
    // 1. 查詢規則
    const rules = await alertRuleService.getAlertRules(source, alertType);

    // 2. 使用統一規則匹配函數（推薦）
    const matchedRule = alertRuleService.matchRule(
      rules,
      conditionType,
      sourceId,
    );

    // 3. 使用規則中的嚴重程度，如果沒有規則則使用預設值
    const severity = matchedRule?.severity || alertService.SEVERITIES.WARNING;

    // 4. 格式化訊息
    let message;
    if (matchedRule?.message_template) {
      message = alertRuleService.formatMessage(
        matchedRule.message_template,
        messageVariables,
      );
    } else {
      message = `預設訊息 - ${messageVariables.location_name || sourceId}`;
    }

    // 5. 創建警報
    return await alertService.createAlert({
      source,
      source_id: sourceId,
      alert_type: alertType,
      severity,
      message,
    });
  } catch (error) {
    logger.error("創建警報失敗", { error, source, sourceId, alertType });
    throw error;
  }
}
```

### 實作要點總結

1. **規則查詢**：使用 `alertRuleService.getAlertRules()` 或專用函數
2. **規則匹配**：使用 `alertRuleService.matchRule()` 統一函數（自動處理優先級）
3. **訊息格式化**：使用 `alertRuleService.formatMessage()` 統一函數
4. **警報創建**：一律使用 `alertService.createAlert()`
5. **自動解決**：根據業務需求決定是否需要（事件類警報通常不需要）

---

## 規則配置規範

### 資料庫表結構

#### alert_rules（警報規則表）

**欄位**：

- `id`: 主鍵
- `source`: 系統來源（`alert_source` ENUM）
- `alert_type`: 警報類型（`alert_type` ENUM）
- `severity`: 嚴重程度（`alert_severity` ENUM）
- `condition_type`: 條件類型（VARCHAR，如 `threshold`, `error_count`）
- `condition_config`: 條件配置（JSONB）
- `message_template`: 訊息模板（TEXT）
- `enabled`: 是否啟用（BOOLEAN）

#### alerts（警報表）

**欄位**：

- `id`: 主鍵
- `source`: 系統來源（`alert_source` ENUM）
- `source_id`: 來源 ID（設備/位置/系統 ID）
- `alert_type`: 警報類型（`alert_type` ENUM）
- `severity`: 嚴重程度（`alert_severity` ENUM）
- `message`: 警報訊息（TEXT）
- `status`: 狀態（`alert_status` ENUM：`active`、`resolved`、`ignored`）
- **時間欄位**：`created_at`、`updated_at`、`ignored_at`（解決時間由 status=resolved 時之 `updated_at` 表示）
- **操作者欄位**：`ignored_by`（FK → `users.id`，ON DELETE SET NULL）— 僅保留忽略者，解決一律為系統自動

詳見下方「[警報資料模型：時間與操作者欄位](#警報資料模型時間與操作者欄位)」。

### 規則類型與配置格式

#### 1. 閾值規則（threshold）

**condition_type**: `threshold`

**condition_config**:

```json
{
  "parameter": "pm25",
  "operator": ">",
  "value": 50,
  "unit": "µg/m³"
}
```

**message_template**:

```
{source_name}的{parameter}超過{threshold}{unit},當前值:{value}{unit} ({severity_text})
```

**使用範例**：

```javascript
const rules = await alertRuleService.getThresholdRules("environment");
const parameterRules = alertRuleService.groupRulesByParameter(rules);
```

#### 2. 錯誤次數規則（error_count）

**condition_type**: `error_count`

**condition_config**:

```json
{
  "min_errors": 5
}
```

**message_template**:

```
{source_name} 連續 {error_count} 次無法連接，請檢查狀態
```

**使用範例**：

```javascript
const rule = await alertRuleService.getErrorCountRule("lighting", "offline");
```

#### 3. 自訂規則（其他 condition_type）

**condition_config** 可含 `source_id` 指定來源；**message_template** 依需求自訂。使用 `alertRuleService.getAlertRules(source, alert_type)` 與 `matchRule(rules, conditionType, sourceId)` 匹配。

### 規則匹配邏輯

1. **查詢規則**：根據 `source` 和 `alert_type` 查詢
2. **過濾規則**：根據 `condition_type` 過濾
3. **匹配規則**：
   - 優先匹配 `condition_config.source_id` 等於當前 `source_id` 的規則
   - 如果沒有，匹配 `condition_config` 為空或沒有 `source_id` 的全域規則
4. **使用規則**：使用匹配到的規則的 `severity` 和 `message_template`

---

## 警報資料模型：時間與操作者欄位

警報表 `alerts` 透過時間戳與操作者欄位記錄生命週期，供列表、報表與稽核使用。

### 時間欄位

| 欄位           | 類型               | 說明         | 設定時機                                                                                  |
| -------------- | ------------------ | ------------ | ----------------------------------------------------------------------------------------- |
| **created_at** | TIMESTAMP NOT NULL | 警報建立時間 | 插入時由資料庫 `DEFAULT CURRENT_TIMESTAMP` 設定。                                         |
| **updated_at** | TIMESTAMP NOT NULL | 最後更新時間 | 每次 `UPDATE` 由觸發器自動設為 `CURRENT_TIMESTAMP`。status=resolved 時即表示解決時間點。   |
| **ignored_at** | TIMESTAMP NULL     | 忽視時間     | 僅在狀態改為 `ignored` 時寫入；取消忽視時清為 `NULL`。                                    |

- 不再單獨儲存「解決時間」；是否解決由 `status` 判斷，解決時間點即該筆變為 resolved 時的 `updated_at`。

### 操作者欄位（僅保留忽略者）

| 欄位           | 類型                         | 說明          | 設定時機                                                          |
| -------------- | ---------------------------- | ------------- | ----------------------------------------------------------------- |
| **ignored_by** | INTEGER NULL, FK → users(id) | 忽視者用戶 ID | 狀態改為 `ignored` 時由 API 傳入當前登入用戶 ID（需管理員權限）。 |

- **解決**：一律為系統自動（設備/環境恢復時由後端呼叫），無「解決者」欄位。
- **忽視**：僅能透過「忽視」API 設定，`ignored_by` 記錄執行忽視的管理員；取消忽視時清為 `NULL`。

### API 與報表回傳

- 列表與單筆查詢會 JOIN `users` 表，回傳 **ignored_by_username**（忽視者帳號名稱）。
- 備份/報表格式會輸出：創建時間、更新時間、忽視時間、忽視者等。

### 狀態與時間/操作者對應

| 狀態     | created_at | updated_at | ignored_at | ignored_by |
| -------- | ---------- | ---------- | ---------- | ---------- |
| active   | ✓          | 每次更新   | NULL       | NULL       |
| resolved | ✓          | 每次更新   | NULL       | NULL       |
| ignored  | ✓          | 每次更新   | 有值       | 有值       |

### 相關服務與 API

- **更新狀態**：`alertService.updateAlertStatus(sourceId, source, alertType, newStatus, userId)`（標記為已解決時 `userId` 傳 `null`）
- **標記為已解決**：`alertService.resolveAlert(sourceId, alertType, source)` — 一律系統自動，無解決者參數
- **標記為已忽視**：`alertService.ignoreAlerts(sourceId, alertType, ignoredBy, source)`
- **取消忽視**：`alertService.unignoreAlerts(sourceId, alertType, source)` → 狀態改回 `active`，並清空 `ignored_at`、`ignored_by`（設備類會同步 `error_tracking` 與可能自動解決）

### 設計說明：當天有效、解決架構與限天

#### 1. 當天有效（創建邏輯）

- **現有實作**：創建警報時，只會查詢「**當天**」是否已有同來源、同類型、同狀態的 active 警報（`findExistingActiveAlert` 使用 `getTodayDateRange()`）。
- **效果**：同一（source, source_id, alert_type）在**同一天**內只會有一筆 active，重複觸發會更新該筆；**隔天**再發生相同問題時，因「當天」範圍不同，會**另創一筆新警報**。
- 因此「隔天發生相同問題就另外產生警報」已符合目前設計。

#### 2. 解決架構（已實作：只解最新一筆 + 每日結案）

- **問題恢復時**：`updateAlertStatus(..., RESOLVED)` 只更新**最新一筆** active，該筆之 `updated_at` 即解決時間點。
- **每日結案**：備份排程執行時會先呼叫 `resolveStaleActiveAlerts()`，將「創建時間早於今日 00:00 UTC」且仍為 active 的警報標記為已解決，避免跨日未結案。
- 詳見 [警報系統重構方案](./ALERT_SYSTEM_REFACTORING_PLAN.md)。

#### 3. 限天設計（與種類的關係）

- **有做限天**：備份排程（`backupScheduler`）依 **保留天數**（`backupConfig.retention.databaseDays`，預設 30 天）清理資料庫。
- **警報限天規則**：只刪除已解決且「最後更新時間」超過保留天數的警報：`status = 'resolved' AND updated_at < beforeDate`。**active / ignored 不會被刪**。

#### 4. 欄位取捨

| 欄位           | 說明                                             |
| -------------- | ------------------------------------------------ |
| **created_at** | 警報發生時間，排序、報表、當天有效與限天都依賴。 |
| **updated_at** | 最後變更時間；status=resolved 時即為解決時間。  |
| **ignored_at** | 忽視時間，報表與稽核用。                         |
| **ignored_by** | 忽視為人為操作，需記錄操作者。                   |

---

## 常見問題與解決方案

### Q1: 如何創建警報？

**A**：一律使用 `alertService.createAlert({ source, source_id, alert_type, severity, message })`。設備離線/錯誤類由 `errorTracker.recordError()` 觸發（內部會調用 `createAlert`）。

### Q2: 如何處理規則不存在的情況？

**A**: 使用預設值：

```javascript
const severity = matchedRule?.severity || alertService.SEVERITIES.WARNING;
const message = matchedRule?.message_template
  ? alertRuleService.formatMessage(matchedRule.message_template, variables)
  : `預設訊息 - ${locationName}`;
```

### Q3: 如何實作自動解決機制？

**A**:

- **狀態類警報**（如環境閾值、設備離線）：當問題恢復時，調用 `alertService.updateAlertStatus()`
- **事件類警報**：依需求決定是否需自動解決

**狀態類警報實作範例**：

```javascript
if (problemResolved) {
  await alertService.updateAlertStatus(
    sourceId,
    source,
    alertType,
    alertService.ALERT_STATUS.RESOLVED,
    null,
  );
}
// 或：alertService.resolveAlert(sourceId, alertType, source)
```

### Q4: 創建／解決時間與當天有效、限天

**A**：

- **創建**：同一天內同來源同類型只會有一筆 active；隔天相同問題會另創新警報。
- **解決**：問題恢復時只更新「最新一筆」active，該筆之 `updated_at` 即解決時間點；昨日及更早的 active 由每日結案（`resolveStaleActiveAlerts()`）標記為已解決。
- **限天**：只刪除已解決且 `updated_at` 超過保留天數的警報；active / ignored 不刪。

### Q5: 如何為特定地點建立不同的規則？

**A**: 在 `condition_config` 中指定 `source_id` 可限定該規則僅適用於特定來源，例如：

```sql
INSERT INTO alert_rules (
  source, alert_type, severity, condition_type,
  condition_config, message_template, enabled
) VALUES (
  'environment', 'threshold', 'warning', 'threshold',
  '{"source_id": 1, "parameter": "pm25", "operator": ">", "value": 50, "unit": "µg/m³"}'::jsonb,
  '{source_name}的{parameter}超過閾值',
  TRUE
);
```

### Q6: 如何確保規則匹配的類型正確？

**A**: 使用 `Number()` 轉換確保類型一致：

```javascript
const matchedRule = candidateRules.find(
  (r) =>
    r.condition_config?.source_id !== undefined &&
    Number(r.condition_config.source_id) === Number(sourceId),
);
```

---

## 檢查清單

在實作新系統的警報功能時，請確認：

- [ ] 使用 `alertRuleService` 查詢規則（不要硬編碼）
- [ ] 使用 `alertRuleService.matchRule()` 匹配規則（不要手動實現匹配邏輯）
- [ ] 使用 `alertRuleService.formatMessage()` 格式化訊息（不要直接拼接字串）
- [ ] 一律使用 `alertService.createAlert()` 創建警報
- [ ] 若使用 `systemAlert.recordError`/`clearError`，需在 `systemAlertHelper.SYSTEM_CONFIGS` 註冊
- [ ] 判斷是否需要自動解決機制（狀態類需要，事件類不需要）
- [ ] 在資料庫中建立對應的規則配置
- [ ] 測試規則不存在時的向後兼容行為
- [ ] 記錄日誌以便排查問題
- [ ] 需顯示忽視者時使用 API 回傳的 `ignored_by_username`；解決一律為系統自動，無解決者欄位

## 參考資料

- [警報系統重構方案](./ALERT_SYSTEM_REFACTORING_PLAN.md) - 一列一事件、只解決當前、每日結案、列表一列一筆（已實作 Phase 1～3）
- [警報系統說明](../ba-frontend-central/docs/ALERT_SYSTEM_REFACTORING.md) - 前端警報系統文檔
- [監控系統說明](./MONITORING_SYSTEM.md) - 監控系統架構
- `src/services/alerts/alertService.js` - 警報服務核心
- `src/services/alerts/alertRuleService.js` - 規則服務
- `src/services/backup/alertsReportFormat.js` - 警報報表格式（創建/更新/忽視時間與忽視者）
- `src/services/backup/backupScheduler.js`、`backupConfig.js` - 警報限天刪除（僅刪已解決且 `updated_at` 超過保留天數）
- `src/services/alerts/errorTracker.js` - 錯誤追蹤服務
- `src/services/alerts/systemAlertHelper.js` - recordError/clearError 輔助
