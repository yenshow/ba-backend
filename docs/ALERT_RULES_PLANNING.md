# 警報規則參照表（alert_rules）規劃文檔

## 📋 概述

`alert_rules` 表用於集中管理所有警報規則，先行定義所有可能的警報情況（包含閾值、嚴重程度等），實現規則的可配置化和可維護性。

## 🎯 設計目標

1. **集中管理**：所有警報規則統一在資料庫中管理，無需修改程式碼即可調整規則
2. **可擴展性**：支援不同系統來源、不同警報類型、不同條件的規則定義
3. **靈活性**：使用 JSONB 儲存條件配置，支援複雜的閾值設定
4. **可維護性**：規則可以啟用/停用，便於測試和調試

## 📊 資料庫結構

### alert_rules 表

```sql
CREATE TABLE alert_rules (
    id SERIAL PRIMARY KEY,
    source alert_source NOT NULL,           -- 系統來源（device, environment, lighting, etc）
    alert_type alert_type NOT NULL,         -- 警報類型（offline, error, threshold）
    severity alert_severity NOT NULL,       -- 嚴重程度（warning, error, critical）
    condition_type VARCHAR(50),             -- 條件類型（threshold, error_count, etc）
    condition_config JSONB,                 -- 條件配置（閾值、錯誤次數等）
    message_template TEXT,                  -- 訊息模板（支援變數替換）
    enabled BOOLEAN DEFAULT TRUE,           -- 是否啟用
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 索引

```sql
CREATE INDEX idx_alert_rules_source_type ON alert_rules(source, alert_type);
CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled);
```

## 🔧 欄位說明

### source (alert_source)

- **用途**：指定規則適用的系統來源
- **值**：`device`, `environment`, `lighting`, `hvac`, `fire`, `security`
- **說明**：規則可以針對特定系統定義

### alert_type (alert_type)

- **用途**：指定規則適用的警報類型
- **值**：`offline`, `error`, `threshold`
- **說明**：
  - `offline`：設備離線警報
  - `error`：錯誤警報
  - `threshold`：閾值警報（環境系統使用）

### severity (alert_severity)

- **用途**：定義當符合條件時，創建的警報嚴重程度
- **值**：`warning`, `error`, `critical`
- **說明**：規則定義了符合條件時應使用的嚴重程度

### condition_type (VARCHAR)

- **用途**：條件類型標識，用於識別如何解析 `condition_config`
- **值範例**：`threshold`, `error_count`, `custom`
- **說明**：不同的條件類型有不同的配置格式

### condition_config (JSONB)

- **用途**：儲存具體的條件配置
- **格式**：根據 `condition_type` 不同而有不同結構

**範例 1：閾值條件（threshold）**

```json
{
  "parameter": "co2",
  "operator": ">",
  "value": 1000,
  "unit": "ppm"
}
```

**支援的參數類型**（與前端一致）：

- `pm25`, `pm10`, `tvoc`, `hcho`, `humidity`, `temperature`, `co2`, `noise`, `wind`

**支援的運算符**：

- `>`：大於
- `>=`：大於等於
- `<`：小於
- `<=`：小於等於

**範例 2：多閾值條件**

```json
{
  "parameter": "temperature",
  "conditions": [
    {
      "operator": ">",
      "value": 30,
      "severity": "warning",
      "unit": "°C"
    },
    {
      "operator": ">",
      "value": 35,
      "severity": "critical",
      "unit": "°C"
    }
  ]
}
```

**範例 3：錯誤次數條件（error_count）**

```json
{
  "min_errors": 5,
  "time_window_minutes": 15
}
```

### message_template (TEXT)

- **用途**：警報訊息的模板
- **支援變數**：
  - `{source_name}`：來源名稱（例如：設備名稱、位置名稱）
  - `{parameter}`：參數名稱（例如：CO2、溫度）
  - `{value}`：當前數值
  - `{threshold}`：閾值
  - `{unit}`：單位

**範例**：

- `{source_name} 的 {parameter} 超過 {threshold}{unit}，當前值：{value}{unit}`
- `{source_name} 連續 {error_count} 次無法連接，請檢查狀態`

### enabled (BOOLEAN)

- **用途**：規則是否啟用
- **預設值**：`TRUE`
- **說明**：停用的規則不會被使用，便於測試和調試

## 📝 規則定義範例

> **參考標準**：
>
> - **PM2.5/PM10**: WHO 2021 空氣品質指引
> - **CO₂**: ASHRAE 室內空氣品質標準
> - **溫度**: ASHRAE 55 熱舒適標準
> - **濕度**: ASHRAE 室內環境標準
> - **噪音**: OSHA/WHO 工作場所噪音標準
>
> 前端狀態映射：
>
> - **注意** → `warning` 級別
> - **警報** → `critical` 級別

### 1. 環境系統 - CO2 濃度閾值（ASHRAE 標準）

```sql
-- 注意（warning）：1000.1 - 2000 ppm
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "co2", "operator": ">", "value": 1000, "unit": "ppm"}'::jsonb,
  '{source_name} 的 CO2 濃度超過 1000ppm，當前值：{value}ppm（注意）'
);

-- 警報（critical）：> 2000 ppm
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "co2", "operator": ">", "value": 2000, "unit": "ppm"}'::jsonb,
  '{source_name} 的 CO2 濃度超過 2000ppm，當前值：{value}ppm（警報）'
);
```

### 2. 環境系統 - 溫度閾值（ASHRAE 55 標準）

```sql
-- 注意（warning）：18-20°C 或 26-28°C
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "temperature", "operator": "<=", "value": 20, "unit": "°C"}'::jsonb,
  '{source_name} 的溫度低於 20°C，當前值：{value}°C（注意）'
);

INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "temperature", "operator": ">=", "value": 26, "unit": "°C"}'::jsonb,
  '{source_name} 的溫度超過 26°C，當前值：{value}°C（注意）'
);

-- 警報（critical）：< 18°C 或 > 28°C
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "temperature", "operator": "<", "value": 18, "unit": "°C"}'::jsonb,
  '{source_name} 的溫度低於 18°C，當前值：{value}°C（警報）'
);

INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "temperature", "operator": ">", "value": 28, "unit": "°C"}'::jsonb,
  '{source_name} 的溫度超過 28°C，當前值：{value}°C（警報）'
);
```

### 3. 環境系統 - 濕度閾值（ASHRAE 標準）

```sql
-- 注意（warning）：20-30% 或 60-70%
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "humidity", "operator": "<=", "value": 30, "unit": "%"}'::jsonb,
  '{source_name} 的濕度低於 30%，當前值：{value}%（注意）'
);

INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "humidity", "operator": ">=", "value": 60, "unit": "%"}'::jsonb,
  '{source_name} 的濕度高於 60%，當前值：{value}%（注意）'
);

-- 警報（critical）：< 20% 或 > 70%
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "humidity", "operator": "<", "value": 20, "unit": "%"}'::jsonb,
  '{source_name} 的濕度低於 20%，當前值：{value}%（警報）'
);

INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "humidity", "operator": ">", "value": 70, "unit": "%"}'::jsonb,
  '{source_name} 的濕度高於 70%，當前值：{value}%（警報）'
);
```

### 4. 環境系統 - PM2.5 閾值（WHO 2021 標準）

```sql
-- 注意（warning）：25.1 - 50 µg/m³
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "pm25", "operator": ">", "value": 25, "unit": "µg/m³"}'::jsonb,
  '{source_name} 的 PM2.5 超過 25µg/m³，當前值：{value}µg/m³（注意）'
);

-- 警報（critical）：> 50 µg/m³
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "pm25", "operator": ">", "value": 50, "unit": "µg/m³"}'::jsonb,
  '{source_name} 的 PM2.5 超過 50µg/m³，當前值：{value}µg/m³（警報）'
);
```

### 5. 環境系統 - PM10 閾值（WHO 2021 標準）

```sql
-- 注意（warning）：50.1 - 100 µg/m³
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "pm10", "operator": ">", "value": 50, "unit": "µg/m³"}'::jsonb,
  '{source_name} 的 PM10 超過 50µg/m³，當前值：{value}µg/m³（注意）'
);

-- 警報（critical）：> 100 µg/m³
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "pm10", "operator": ">", "value": 100, "unit": "µg/m³"}'::jsonb,
  '{source_name} 的 PM10 超過 100µg/m³，當前值：{value}µg/m³（警報）'
);
```

### 6. 環境系統 - 噪音值閾值（OSHA/WHO 標準）

```sql
-- 注意（warning）：55.1 - 70 dB
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'warning',
  'threshold',
  '{"parameter": "noise", "operator": ">", "value": 55, "unit": "dB"}'::jsonb,
  '{source_name} 的噪音值超過 55dB，當前值：{value}dB（注意）'
);

-- 警報（critical）：> 70 dB
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment',
  'threshold',
  'critical',
  'threshold',
  '{"parameter": "noise", "operator": ">", "value": 70, "unit": "dB"}'::jsonb,
  '{source_name} 的噪音值超過 70dB，當前值：{value}dB（警報）'
);
```

### 7. 設備系統 - 離線錯誤次數

```sql
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'device',
  'offline',
  'warning',
  'error_count',
  '{"min_errors": 5, "time_window_minutes": 15}'::jsonb,
  '{source_name} 在 15 分鐘內連續 {error_count} 次無法連接，請檢查狀態'
);
```

## 🔄 使用流程

### 1. 創建警報時查詢規則

```javascript
// 在 alertService.createAlert() 或監控服務中
async function getAlertRule(source, alertType, conditionData) {
  // 查詢適用的規則
  const rules = await db.query(
    `
    SELECT * FROM alert_rules
    WHERE source = ?
      AND alert_type = ?
      AND enabled = TRUE
    ORDER BY severity DESC
  `,
    [source, alertType]
  );

  // 根據 condition_data 匹配規則
  for (const rule of rules) {
    if (matchesCondition(rule.condition_config, conditionData)) {
      return rule;
    }
  }

  return null; // 沒有匹配的規則，使用預設嚴重程度
}
```

### 2. 閾值監控流程（環境系統）

```javascript
// 在 environmentMonitor.js 中
async function checkThresholds(locationId, sensorData) {
  // 讀取感測器數據
  const { temperature, humidity, co2 } = sensorData;

  // 查詢所有啟用的閾值規則
  const rules = await db.query(`
    SELECT * FROM alert_rules
    WHERE source = 'environment'
      AND alert_type = 'threshold'
      AND enabled = TRUE
  `);

  // 檢查每個規則
  for (const rule of rules) {
    const config = rule.condition_config;
    const value = sensorData[config.parameter];

    if (evaluateThreshold(config, value)) {
      // 創建警報
      await createAlert({
        source: "environment",
        source_id: locationId,
        alert_type: "threshold",
        severity: rule.severity,
        message: formatMessage(rule.message_template, {
          source_name: location.name,
          parameter: config.parameter,
          value: value,
          threshold: config.value,
          unit: config.unit,
        }),
      });
    }
  }
}
```

### 3. 錯誤次數監控（已實現，需要整合規則）

```javascript
// 在 errorTracker.js 中（需要整合規則查詢）
async function recordError(source, sourceId, alertType, errorMessage) {
  // ... 現有邏輯 ...

  // 查詢錯誤次數規則
  const rule = await getAlertRule(source, alertType, {
    error_count: tracking.error_count,
    time_window_minutes: 15,
  });

  if (rule && tracking.error_count >= rule.condition_config.min_errors) {
    const severity = rule.severity;
    const message = formatMessage(rule.message_template, {
      source_name: metadata.name,
      error_count: tracking.error_count,
    });

    await alertService.createAlert({
      source,
      source_id: sourceId,
      alert_type: alertType,
      severity,
      message,
    });
  }
}
```

## 🚀 實現步驟

### 階段 1：基礎架構（已完成）

- [x] 創建 `alert_rules` 表
- [x] 創建索引
- [x] 創建觸發器

### 階段 2：規則管理服務

- [ ] 創建 `alertRuleService.js`：
  - `getAlertRules(source, alertType, conditionData)`：查詢適用的規則
  - `evaluateCondition(conditionConfig, conditionData)`：評估條件是否匹配
  - `formatMessage(template, variables)`：格式化訊息模板
- [ ] 創建規則管理 API（可選，用於前端管理規則）

### 階段 3：整合到現有系統

- [ ] 整合到 `errorTracker.js`：使用規則決定錯誤次數警報的嚴重程度
- [ ] 整合到環境監控：實現閾值監控邏輯
- [ ] 修改 `alertService.createAlert()`：支援規則查詢（可選，向後兼容）

### 階段 4：初始化預設規則

- [ ] 創建遷移腳本：插入預設的規則資料
- [ ] 定義環境系統的預設閾值規則
- [ ] 定義設備系統的預設錯誤次數規則

## 📋 規則管理 API（可選）

### 查詢規則

```
GET /api/alert-rules
Query Parameters:
  - source: 系統來源（可選）
  - alert_type: 警報類型（可選）
  - enabled: 是否啟用（可選）
```

### 創建規則

```
POST /api/alert-rules
Body: {
  source: "environment",
  alert_type: "threshold",
  severity: "warning",
  condition_type: "threshold",
  condition_config: {...},
  message_template: "...",
  enabled: true
}
```

### 更新規則

```
PUT /api/alert-rules/:id
Body: {
  condition_config: {...},
  message_template: "...",
  enabled: false
}
```

### 刪除規則

```
DELETE /api/alert-rules/:id
```

## ⚠️ 注意事項

1. **向後兼容**：

   - 現有的 `createAlert()` 呼叫不應該因為規則系統而失效
   - 如果沒有匹配的規則，應該使用預設的嚴重程度（例如：warning）

2. **規則優先級**：

   - 當多個規則匹配時，應該選擇嚴重程度最高的
   - 或者按照規則 ID 排序（後創建的優先）

3. **條件評估性能**：

   - 規則查詢應該有適當的索引
   - 條件評估邏輯應該高效，避免複雜的 JSONB 查詢

4. **規則測試**：

   - 規則可以通過 `enabled` 欄位進行測試
   - 建議在生產環境前先在測試環境驗證規則

5. **訊息模板安全性**：
   - 訊息模板應該避免 SQL 注入風險（使用參數化查詢）
   - 變數替換應該進行適當的轉義

## 🔍 未來擴展

1. **規則優先級**：添加 `priority` 欄位，明確規則執行順序
2. **規則分組**：添加 `rule_group` 欄位，支援規則分組管理
3. **規則生效時間**：添加 `start_time` 和 `end_time`，支援定時規則
4. **規則條件組合**：支援 AND/OR 條件組合
5. **規則通知設定**：整合通知機制，不同規則可以有不同的通知方式

## 📚 參考資料

- [分析報告 - 警報等級設計與參照表](./ALERT_SYSTEM_ANALYSIS_AND_RECOMMENDATIONS.md#21-警報等級設計與參照表)
- [資料庫文檔 - alert_rules 表](../DATABASE_DOCUMENTATION.md)
- [前端環境品質設定 - 狀態判斷閾值](../../ba-frontend/docs/ENVIRONMENT_QUALITY_SETTINGS.md#狀態判斷閾值)

## 📊 前端狀態映射

前端使用的狀態等級與後端警報嚴重程度的對應關係：

| 前端狀態 | 後端嚴重程度 | 說明                         |
| -------- | ------------ | ---------------------------- |
| 正常     | -            | 不創建警報                   |
| 注意     | `warning`    | 需要關注，但尚未達到危險程度 |
| 警報     | `critical`   | 需要立即處理的嚴重情況       |

**閾值定義參考前端標準**：

- 前端的「注意」閾值 → `warning` 級別規則
- 前端的「警報」閾值 → `critical` 級別規則

---

**文件版本**：v1.0  
**創建日期**：2025-01-XX  
**最後更新**：2025-01-XX
