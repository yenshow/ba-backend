# 警報系統實作指南

**更新日期**：2026-01-22  
**狀態**：✅ 統一規範文檔  
**最後重構**：2026-01-22（人流統計警報重構完成）

---

## 📋 目錄

1. [概述](#概述)
2. [統一實作規範](#統一實作規範)
3. [各系統實作方式對比](#各系統實作方式對比)
4. [標準實作流程](#標準實作流程)
5. [規則配置規範](#規則配置規範)
6. [常見問題與解決方案](#常見問題與解決方案)

---

## 概述

本文檔旨在統一各系統的警報建立與處理方式，確保所有系統遵循相同的實作規範，避免不一致的實作方式導致維護困難。

### 核心原則

1. **統一使用規則配置**：所有警報都應從 `alert_rules` 表讀取配置
2. **統一使用訊息模板**：使用 `alertRuleService.formatMessage()` 格式化訊息
3. **統一使用創建接口**：優先使用 `systemAlert.createAlert()` 或 `alertService.createAlert()`
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

**一般警報**（如人流統計）：
```javascript
const rules = await alertRuleService.getAlertRules("people_counting", "error");
// 使用統一規則匹配函數（推薦）
const matchedRule = alertRuleService.matchRule(
  rules,
  "unregistered_person",
  sourceId
);
```

#### ❌ 錯誤方式

```javascript
// 不要直接硬編碼 severity 和 message
await alertService.createAlert({
  source: "people_counting",
  source_id: sourceId,
  alert_type: "error",
  severity: "warning", // ❌ 應該從規則讀取
  message: "未註冊人員刷卡", // ❌ 應該使用模板
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
  conditionType,  // 例如 "unregistered_person"
  sourceId
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

#### 方式一：使用 `systemAlert.createAlert()`（推薦）

適用於已註冊的系統（environment, lighting）：

```javascript
await systemAlert.createAlert(
  "environment",  // 系統名稱
  systemId,        // source_id
  "threshold",     // alert_type
  matchedRule.severity,
  message
);
```

**優點**：
- 自動驗證來源存在性
- 統一的錯誤處理
- 支援系統配置

#### 方式二：使用 `alertService.createAlert()`

適用於所有系統：

```javascript
await alertService.createAlert({
  source: alertService.ALERT_SOURCES.PEOPLE_COUNTING,
  source_id: sourceId,
  alert_type: alertService.ALERT_TYPES.ERROR,
  severity,
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
    null, // 系統自動解決
    "問題已恢復正常"
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
- ✅ 使用 `systemAlert.createAlert()` 創建警報
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

### 人流統計警報（People Counting）

**檔案**：`src/services/monitoring/peopleCountingMonitor.js`

**實作方式**：
- ✅ 使用 `alertRuleService.getAlertRules()` 查詢規則
- ✅ 使用 `alertRuleService.matchRule()` 匹配規則（統一規範）
- ✅ 使用 `alertRuleService.formatMessage()` 格式化訊息
- ✅ 使用 `systemAlert.createAlert()` 創建警報（統一規範，有降級處理）
- ⚠️ **缺少自動解決機制**（可選：當人員註冊後自動解決）

**規則類型**：`unregistered_person`

**condition_config 格式**：
```json
{}  // 全域規則
// 或
{
  "source_id": 1  // 指定地點規則
}
```

**重構狀態**：✅ 已重構（2026-01-22）
- 已註冊到 `systemAlertHelper.SYSTEM_CONFIGS`
- 使用統一的規則匹配函數 `matchRule()`
- 優先使用 `systemAlert.createAlert()`，失敗時降級使用 `alertService.createAlert()`
- **注意**：此類警報為事件型，不需要自動解決機制

---

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
const systemAlert = require("../alerts/systemAlertHelper");

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
  messageVariables
) {
  try {
    // 1. 查詢規則
    const rules = await alertRuleService.getAlertRules(source, alertType);
    
    // 2. 使用統一規則匹配函數（推薦）
    const matchedRule = alertRuleService.matchRule(
      rules,
      conditionType,
      sourceId
    );
    
    // 3. 使用規則中的嚴重程度，如果沒有規則則使用預設值
    const severity = matchedRule?.severity || alertService.SEVERITIES.WARNING;
    
    // 4. 格式化訊息
    let message;
    if (matchedRule?.message_template) {
      message = alertRuleService.formatMessage(
        matchedRule.message_template,
        messageVariables
      );
    } else {
      message = `預設訊息 - ${messageVariables.location_name || sourceId}`;
    }
    
    // 5. 創建警報（優先使用 systemAlert，失敗時降級使用 alertService）
    try {
      // 檢查系統是否已註冊
      if (systemAlert.SYSTEM_CONFIGS[source]) {
        return await systemAlert.createAlert(
          source,
          sourceId,
          alertType,
          severity,
          message
        );
      }
    } catch (systemAlertError) {
      // 降級處理：當來源驗證失敗時，使用 alertService（不驗證來源存在性）
      if (systemAlertError.message.includes("不存在") || 
          systemAlertError.message.includes("來源")) {
        // 繼續使用 alertService 創建
      } else {
        throw systemAlertError;
      }
    }
    
    // 使用 alertService 創建（系統未註冊或降級情況）
    return await alertService.createAlert({
      source,
      source_id: sourceId,
      alert_type: alertType,
      severity,
      message,
    });
  } catch (error) {
    logger.error("創建警報失敗", {
      error,
      source,
      sourceId,
      alertType,
      module: "createSystemAlert",
    });
    throw error;
  }
}
```

### 實作要點總結

1. **規則查詢**：使用 `alertRuleService.getAlertRules()` 或專用函數
2. **規則匹配**：使用 `alertRuleService.matchRule()` 統一函數（自動處理優先級）
3. **訊息格式化**：使用 `alertRuleService.formatMessage()` 統一函數
4. **警報創建**：優先使用 `systemAlert.createAlert()`，失敗時降級使用 `alertService.createAlert()`
5. **自動解決**：根據業務需求決定是否需要（事件類警報通常不需要）

---

## 規則配置規範

### 資料庫表結構

**表名**：`alert_rules`

**欄位**：
- `id`: 主鍵
- `source`: 系統來源（`alert_source` ENUM）
- `alert_type`: 警報類型（`alert_type` ENUM）
- `severity`: 嚴重程度（`alert_severity` ENUM）
- `condition_type`: 條件類型（VARCHAR，如 `threshold`, `error_count`, `unregistered_person`）
- `condition_config`: 條件配置（JSONB）
- `message_template`: 訊息模板（TEXT）
- `enabled`: 是否啟用（BOOLEAN）

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

#### 3. 自訂規則（如 unregistered_person）

**condition_type**: `unregistered_person`（或其他自訂值）

**condition_config**:
```json
{}  // 全域規則
// 或
{
  "source_id": 1  // 指定來源規則
}
```

**message_template**:
```
未註冊人員刷卡 - {location_name}（{device_info}）
```

**使用範例**：
```javascript
const rules = await alertRuleService.getAlertRules("people_counting", "error");
const candidateRules = rules.filter(r => r.condition_type === "unregistered_person");
```

### 規則匹配邏輯

1. **查詢規則**：根據 `source` 和 `alert_type` 查詢
2. **過濾規則**：根據 `condition_type` 過濾
3. **匹配規則**：
   - 優先匹配 `condition_config.source_id` 等於當前 `source_id` 的規則
   - 如果沒有，匹配 `condition_config` 為空或沒有 `source_id` 的全域規則
4. **使用規則**：使用匹配到的規則的 `severity` 和 `message_template`

---

## 常見問題與解決方案

### Q1: 應該使用 `systemAlert.createAlert()` 還是 `alertService.createAlert()`？

**A**: 
- **已註冊系統**（environment, lighting, people_counting）：優先使用 `systemAlert.createAlert()`
- **降級處理**：如果 `systemAlert.createAlert()` 失敗（例如來源不存在），自動降級使用 `alertService.createAlert()`
- **設備警報**：使用 `errorTracker.recordError()`（內部會調用 `alertService.createAlert()`）

**實作範例**：
```javascript
try {
  await systemAlert.createAlert("people_counting", sourceId, alertType, severity, message);
} catch (systemAlertError) {
  // 降級處理：當來源驗證失敗時，使用 alertService
  if (systemAlertError.message.includes("不存在") || systemAlertError.message.includes("來源")) {
    await alertService.createAlert({ source, source_id: sourceId, alert_type: alertType, severity, message });
  } else {
    throw systemAlertError;
  }
}
```

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
- **事件類警報**（如未註冊人員刷卡）：通常不需要自動解決機制

**狀態類警報實作範例**：
```javascript
// 當問題恢復時，自動解決對應的警報
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

### Q4: 如何為特定地點建立不同的規則？

**A**: 在 `condition_config` 中指定 `source_id`：
```sql
INSERT INTO alert_rules (
  source, alert_type, severity, condition_type,
  condition_config, message_template, enabled
) VALUES (
  'people_counting', 'error', 'error', 'unregistered_person',
  '{"source_id": 1}'::jsonb,
  '【未註冊】{location_name} 發生未註冊人員刷卡',
  TRUE
);
```

### Q5: 如何確保規則匹配的類型正確？

**A**: 使用 `Number()` 轉換確保類型一致：
```javascript
const matchedRule = candidateRules.find(r => 
  r.condition_config?.source_id !== undefined &&
  Number(r.condition_config.source_id) === Number(sourceId)
);
```

---

## 檢查清單

在實作新系統的警報功能時，請確認：

- [ ] 使用 `alertRuleService` 查詢規則（不要硬編碼）
- [ ] 使用 `alertRuleService.matchRule()` 匹配規則（不要手動實現匹配邏輯）
- [ ] 使用 `alertRuleService.formatMessage()` 格式化訊息（不要直接拼接字串）
- [ ] 優先使用 `systemAlert.createAlert()`，失敗時降級使用 `alertService.createAlert()`
- [ ] 在 `systemAlertHelper` 中註冊系統配置（如果適用）
- [ ] 判斷是否需要自動解決機制（狀態類需要，事件類不需要）
- [ ] 在資料庫中建立對應的規則配置
- [ ] 測試規則不存在時的向後兼容行為
- [ ] 記錄日誌以便排查問題

## 重構經驗總結

### 人流統計警報重構經驗（2026-01-22）

**重構步驟**：

1. **註冊系統配置**：
   - 在 `systemAlertHelper.js` 中添加 `getPeopleCountingLocationInfo()` 函數
   - 在 `SYSTEM_CONFIGS` 中註冊 `people_counting` 系統
   - 優化查詢邏輯：使用單一 SQL 查詢同時匹配 `location_systems.id` 和 `locations.id`

2. **提取通用函數**：
   - 在 `alertRuleService.js` 中添加 `matchRule()` 通用函數
   - 統一處理規則過濾和優先級匹配邏輯

3. **重構監控代碼**：
   - 使用 `matchRule()` 替代手動匹配邏輯
   - 優先使用 `systemAlert.createAlert()`，失敗時降級使用 `alertService.createAlert()`
   - 添加降級處理的錯誤判斷

4. **優化要點**：
   - 簡化 SQL 查詢（合併兩種查詢為一個）
   - 改進降級處理的錯誤判斷邏輯
   - 確認事件類警報不需要自動解決機制

**適用於其他系統**：
- 新系統可以參考此重構流程
- 統一使用 `matchRule()` 函數
- 統一使用降級處理機制

---

## 參考資料

- [警報系統說明](../ba-frontend-central/docs/ALERT_SYSTEM_REFACTORING.md) - 前端警報系統文檔
- [監控系統說明](./MONITORING_SYSTEM.md) - 監控系統架構
- `src/services/alerts/alertService.js` - 警報服務核心
- `src/services/alerts/alertRuleService.js` - 規則服務
- `src/services/alerts/errorTracker.js` - 錯誤追蹤服務
- `src/services/alerts/systemAlertHelper.js` - 系統警報輔助函數

---

**文檔結束**

