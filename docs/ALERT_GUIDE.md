# 警報系統實作指南

**更新日期**：2026-02-10  
**狀態**：統一規範 + 重構 Phase 1～3 已實作（一列一事件、只解決當前、每日結案、列表一列一筆）

---

## 1. 概述與原則

### 核心實作原則

1. **規則配置**：從 `alert_rules` 讀取，不硬編碼 severity / message
2. **訊息模板**：使用 `alertRuleService.formatMessage()` 格式化
3. **創建接口**：一律使用 `alertService.createAlert()`
4. **自動解決**：問題恢復時呼叫 `alertService.updateAlertStatus(..., RESOLVED, null)` 或 `resolveAlert()`

### 架構原則（重構後）

- **一列一事件**：每筆 `alerts` 對應一個事件；解決時間 = 該筆變為 resolved 時的 `updated_at`
- **當天有效**：同一天同 (source, source_id, alert_type) 僅一筆 active；隔天再發生為新一筆
- **只解決當前**：問題恢復時只更新「最新一筆」active；其餘由每日排程 `resolveStaleActiveAlerts()` 結案
- **列表一列一筆**：API 不 GROUP BY，每列一筆警報，與 DB / 報表一致

---

## 2. 統一實作規範

### 2.1 規則查詢

| 類型         | 用法 |
|--------------|------|
| 閾值類       | `alertRuleService.getThresholdRules("environment")` |
| 錯誤次數類   | `alertRuleService.getErrorCountRule("lighting", "offline")` |
| 通用         | `alertRuleService.getAlertRules(source, alertType)` + `matchRule(rules, conditionType, sourceId)` |

### 2.2 規則匹配與訊息

```javascript
const rules = await alertRuleService.getAlertRules(source, alertType);
const matchedRule = alertRuleService.matchRule(rules, conditionType, sourceId);
const severity = matchedRule?.severity || alertService.SEVERITIES.WARNING;

let message;
if (matchedRule?.message_template) {
  message = alertRuleService.formatMessage(matchedRule.message_template, {
    location_name: locationName,
    device_info: deviceInfo,
    // ...
  });
} else {
  message = `預設訊息 - ${locationName}`;
}
```

### 2.3 創建警報與自動解決

```javascript
// 創建
await alertService.createAlert({
  source: alertService.ALERT_SOURCES.ENVIRONMENT,
  source_id: sourceId,
  alert_type: "threshold",
  severity,
  message,
});

// 問題恢復時：只解最新一筆 active
if (problemResolved) {
  await alertService.updateAlertStatus(
    sourceId, source, alertType,
    alertService.ALERT_STATUS.RESOLVED,
    null,
  );
  // 或：alertService.resolveAlert(sourceId, alertType, source);
}
```

### 2.4 錯誤示範（勿用）

```javascript
// ❌ 不要硬編碼
await alertService.createAlert({
  source: "environment",
  source_id: sourceId,
  severity: "warning",   // 應從規則讀取
  message: "自訂訊息",   // 應使用模板
});
```

---

## 3. 規則配置

### 3.1 規則表 `alert_rules` 要點

- `source`, `alert_type`, `severity`, `condition_type`, `condition_config`(JSONB), `message_template`, `enabled`
- 匹配優先級：`condition_config.source_id` 指定來源 > 全域（無 source_id）

### 3.2 規則類型與 condition_config 範例

**閾值（threshold）**

```json
{
  "parameter": "pm25",
  "operator": ">",
  "value": 50,
  "unit": "µg/m³"
}
```

**錯誤次數（error_count）**

```json
{
  "min_errors": 5
}
```

**指定來源**：在 `condition_config` 加上 `"source_id": 1` 即限定該來源。

### 3.3 警報表 `alerts` 時間與操作者

| 欄位         | 說明 |
|--------------|------|
| **created_at** | 建立時間（當天有效、限天依賴） |
| **updated_at** | 最後更新；status=resolved 時即為解決時間 |
| **ignored_at** | 僅在 status=ignored 時有值 |
| **ignored_by** | 忽視者 user id（FK → users）；解決無「解決者」欄位 |

- 創建：同天同來源同類型僅一筆 active；隔天另創新筆。
- 解決：只解最新一筆 active；昨日及更早的 active 由 `resolveStaleActiveAlerts()` 在備份前結案。
- 限天：只刪除「已解決且 `updated_at` 超過保留天數」的列；active / ignored 不刪。

---

## 4. 標準流程與完整範例

流程：查詢規則 → 匹配規則（matchRule）→ 評估條件 → 格式化訊息 → createAlert →（可選）自動解決。

```javascript
const alertService = require("../alerts/alertService");
const alertRuleService = require("../alerts/alertRuleService");

async function createSystemAlert(
  source,
  sourceId,
  alertType,
  conditionType,
  messageVariables,
) {
  const rules = await alertRuleService.getAlertRules(source, alertType);
  const matchedRule = alertRuleService.matchRule(rules, conditionType, sourceId);
  const severity = matchedRule?.severity || alertService.SEVERITIES.WARNING;
  const message = matchedRule?.message_template
    ? alertRuleService.formatMessage(matchedRule.message_template, messageVariables)
    : `預設訊息 - ${messageVariables.location_name || sourceId}`;

  return await alertService.createAlert({
    source,
    source_id: sourceId,
    alert_type: alertType,
    severity,
    message,
  });
}
```

---

## 5. 常見問題

**Q: 規則不存在？**  
使用預設：`severity = matchedRule?.severity || alertService.SEVERITIES.WARNING`，message 用 fallback 字串。

**Q: 特定地點不同規則？**  
在 `condition_config` 加上 `source_id`，該規則僅適用該來源。

**Q: 規則匹配類型？**  
用 `Number(r.condition_config.source_id) === Number(sourceId)` 確保型別一致。

**Q: 創建/解決/限天語意？**  
創建＝當天有效；解決＝只解最新一筆，解決時間＝該筆 `updated_at`；限天＝只刪已解決且 `updated_at` 逾保留天數。

---

## 6. 檢查清單

- [ ] 用 `alertRuleService` 查規則、`matchRule()` 匹配、`formatMessage()` 格式化
- [ ] 一律 `alertService.createAlert()` 創建警報
- [ ] 狀態類警報在問題恢復時呼叫 `updateAlertStatus(..., RESOLVED, null)` 或 `resolveAlert()`
- [ ] 需 recordError/clearError 時在 `systemAlertHelper.SYSTEM_CONFIGS` 註冊
- [ ] 顯示忽視者用 API 的 `ignored_by_username`；解決為系統自動無解決者欄位

---

## 7. 參考

- `src/services/alerts/alertService.js`、`alertRuleService.js`
- `src/services/alerts/errorTracker.js`、`systemAlertHelper.js`
- `src/services/backup/backupScheduler.js`（每日結案）、`alertsReportFormat.js`（報表）
- 前端：`ba-frontend-central/docs/ALERT_SYSTEM_REFACTORING.md`
