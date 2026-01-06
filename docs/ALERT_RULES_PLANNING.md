# 警報規則參照表（alert_rules）規劃文檔

## 📋 概述

`alert_rules` 表用於集中管理所有警報規則，先行定義所有可能的警報情況（包含閾值、嚴重程度等），實現規則的可配置化和可維護性。

## ✅ 實現狀態

**當前狀態**：所有預設規則已實現並插入到資料庫中

- ✅ **環境系統閾值規則**：14 條（CO2、溫度、濕度、PM2.5、PM10、噪音）
- ✅ **設備系統離線規則**：1 條
- ✅ **環境系統離線規則**：1 條
- ✅ **照明系統離線規則**：1 條
- ✅ **總計**：17 條規則已啟用並正在使用

所有規則已整合到監控系統中，系統會自動根據規則創建和解決警報。

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

## 📝 已實現的規則

以下規則已經插入到資料庫中並正在使用：

### 規則統計

| 系統來源      | 警報類型    | 規則數量 | 狀態      |
| ------------- | ----------- | -------- | --------- |
| `environment` | `threshold` | 14       | ✅ 已實現 |
| `device`      | `offline`   | 1        | ✅ 已實現 |
| `environment` | `offline`   | 1        | ✅ 已實現 |
| `lighting`    | `offline`   | 1        | ✅ 已實現 |
| **總計**      | -           | **17**   | ✅ 已實現 |

### 規則列表

#### 環境系統 - 閾值規則（14 條）

1. **CO2 濃度**（2 條）

   - `warning`：> 1000 ppm
   - `critical`：> 2000 ppm

2. **溫度**（4 條）

   - `warning`：≤ 20°C 或 ≥ 26°C
   - `critical`：< 18°C 或 > 28°C

3. **濕度**（4 條）

   - `warning`：≤ 30% 或 ≥ 60%
   - `critical`：< 20% 或 > 70%

4. **PM2.5**（2 條）

   - `warning`：> 25 µg/m³
   - `critical`：> 50 µg/m³

5. **PM10**（2 條）

   - `warning`：> 50 µg/m³
   - `critical`：> 100 µg/m³

6. **噪音**（2 條）
   - `warning`：> 55 dB
   - `critical`：> 70 dB

#### 設備系統 - 離線規則（1 條）

- `device` + `offline` + `warning`：連續 5 次錯誤

#### 環境系統 - 離線規則（1 條）

- `environment` + `offline` + `warning`：連續 5 次錯誤

#### 照明系統 - 離線規則（1 條）

- `lighting` + `offline` + `warning`：連續 5 次錯誤

---

## 📝 規則定義範例

> **參考標準**：PM2.5/PM10 (WHO 2021)、CO₂/溫度/濕度 (ASHRAE)、噪音 (OSHA/WHO)  
> **狀態映射**：注意 → `warning`、警報 → `critical`  
> **注意**：所有規則已實現並插入到資料庫中

### 環境系統閾值規則（14 條）

| 參數  | Warning 閾值 | Critical 閾值 | 單位  |
| ----- | ------------ | ------------- | ----- |
| CO2   | > 1000       | > 2000        | ppm   |
| 溫度  | ≤ 20 或 ≥ 26 | < 18 或 > 28  | °C    |
| 濕度  | ≤ 30 或 ≥ 60 | < 20 或 > 70  | %     |
| PM2.5 | > 25         | > 50          | µg/m³ |
| PM10  | > 50         | > 100         | µg/m³ |
| 噪音  | > 55         | > 70          | dB    |

### 離線規則（3 條）

- **設備/環境/照明系統**：連續 5 次連接失敗觸發 `warning` 級別警報

### 規則格式範例

```sql
-- 閾值規則
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'environment', 'threshold', 'warning', 'threshold',
  '{"parameter": "pm25", "operator": ">", "value": 25, "unit": "µg/m³"}'::jsonb,
  '{source_name} 的 PM2.5 超過 25µg/m³，當前值：{value}µg/m³（注意）'
);

-- 離線規則
INSERT INTO alert_rules (source, alert_type, severity, condition_type, condition_config, message_template)
VALUES (
  'device', 'offline', 'warning', 'error_count',
  '{"min_errors": 5, "time_window_minutes": 15}'::jsonb,
  '{source_name} 在 15 分鐘內連續 {error_count} 次無法連接，請檢查狀態'
);
```

## 🔄 使用流程

系統會自動查詢 `alert_rules` 表並根據規則創建警報。主要流程：

1. **閾值監控**（`environmentMonitor.js`）：查詢啟用的閾值規則 → 評估感測器數值 → 創建/更新警報
2. **錯誤追蹤**（`errorTracker.js`）：查詢錯誤次數規則 → 達到閾值時創建離線警報
3. **規則服務**（`alertRuleService.js`）：提供規則查詢、閾值評估、訊息格式化等功能

詳細實現請參考相關源代碼文件。

## 🚀 實現步驟

### 階段 1：基礎架構（已完成）

- [x] 創建 `alert_rules` 表
- [x] 創建索引
- [x] 創建觸發器

### 階段 2：規則管理服務（已完成）

- [x] 創建 `alertRuleService.js`：
  - `getAlertRules(source, alertType, conditionData)`：查詢適用的規則
  - `getErrorCountRule(source, alertType)`：查詢錯誤次數規則
  - `getThresholdRules(source)`：查詢閾值規則
  - `evaluateThreshold(conditionConfig, value)`：評估閾值條件
  - `formatMessage(template, variables)`：格式化訊息模板
- [ ] 創建規則管理 API（可選，用於前端管理規則）

### 階段 3：整合到現有系統（已完成）

- [x] 整合到 `errorTracker.js`：使用規則決定錯誤次數警報的嚴重程度
- [x] 整合到環境監控：實現閾值監控邏輯
- [x] 性能優化：
  - 使用 UPSERT 操作減少資料庫查詢
  - 只在 severity 需要升級時才更新警報
  - 一次性查詢所有 active 警報和規則
  - 優化警報匹配邏輯，使用 `findAlertByParameter` 輔助函數

### 階段 4：初始化預設規則（已完成）

- [x] 創建遷移腳本：插入預設的規則資料
- [x] 定義環境系統的預設閾值規則（CO2、溫度、濕度、PM2.5、PM10、噪音）- **14 條規則**
- [x] 定義設備系統的預設錯誤次數規則 - **1 條規則**
- [x] 定義環境系統的預設離線規則 - **1 條規則**
- [x] 定義照明系統的預設離線規則 - **1 條規則**
- [x] **總計 17 條規則已插入資料庫並啟用**

## 🔍 查詢資料庫規則

```sql
-- 查看所有規則
SELECT * FROM alert_rules ORDER BY source, alert_type, severity;

-- 查看特定系統規則
SELECT * FROM alert_rules WHERE source = 'environment' AND enabled = TRUE;

-- 統計規則數量
SELECT source, alert_type, COUNT(*) as rule_count,
       COUNT(CASE WHEN enabled = TRUE THEN 1 END) as enabled_count
FROM alert_rules GROUP BY source, alert_type;

-- 更新規則狀態
UPDATE alert_rules SET enabled = FALSE WHERE id = ?;
```

## 📋 規則管理

目前規則通過資料庫直接管理。未來可考慮添加 REST API 進行規則管理（可選功能）。

## ⚠️ 注意事項

1. **向後兼容**：如果沒有匹配的規則，使用預設嚴重程度（`warning`）
2. **規則優先級**：多個規則匹配時，選擇嚴重程度最高的
3. **性能優化**：
   - 規則查詢使用索引優化
   - 只在 severity 需要升級時才更新警報
   - 一次性查詢所有 active 警報和規則
4. **規則測試**：通過 `enabled` 欄位測試規則，建議先在測試環境驗證
5. **安全性**：使用參數化查詢，避免 SQL 注入風險

## 🔍 未來擴展

- 規則優先級：添加 `priority` 欄位
- 規則分組：支援規則分組管理
- 定時規則：支援生效時間設定
- 條件組合：支援 AND/OR 邏輯
- 通知設定：整合通知機制

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

## 🔄 前端與後端閾值對照表

### 完整閾值對照

以下表格詳細列出前端顯示邏輯和後端警報規則的對應關係：

#### PM2.5

| 前端數值範圍 | 前端狀態 | 前端顯示 | 後端規則 | 後端嚴重程度 | 警報訊息模板                                                        |
| ------------ | -------- | -------- | -------- | ------------ | ------------------------------------------------------------------- |
| ≤ 25 µg/m³   | 正常     | 綠色     | -        | -            | 不創建警報                                                          |
| 25.1-50      | 注意     | 黃色     | > 25     | `warning`    | `{source_name} 的 PM2.5 超過 25µg/m³，當前值：{value}µg/m³（注意）` |
| > 50         | 警報     | 紅色     | > 50     | `critical`   | `{source_name} 的 PM2.5 超過 50µg/m³，當前值：{value}µg/m³（警報）` |

#### PM10

| 前端數值範圍 | 前端狀態 | 前端顯示 | 後端規則 | 後端嚴重程度 | 警報訊息模板                                                        |
| ------------ | -------- | -------- | -------- | ------------ | ------------------------------------------------------------------- |
| ≤ 50 µg/m³   | 正常     | 綠色     | -        | -            | 不創建警報                                                          |
| 50.1-100     | 注意     | 黃色     | > 50     | `warning`    | `{source_name} 的 PM10 超過 50µg/m³，當前值：{value}µg/m³（注意）`  |
| > 100        | 警報     | 紅色     | > 100    | `critical`   | `{source_name} 的 PM10 超過 100µg/m³，當前值：{value}µg/m³（警報）` |

#### CO2

| 前端數值範圍 | 前端狀態 | 前端顯示 | 後端規則 | 後端嚴重程度 | 警報訊息模板                                                        |
| ------------ | -------- | -------- | -------- | ------------ | ------------------------------------------------------------------- |
| ≤ 1000 ppm   | 正常     | 綠色     | -        | -            | 不創建警報                                                          |
| 1000.1-2000  | 注意     | 黃色     | > 1000   | `warning`    | `{source_name} 的 CO2 濃度超過 1000ppm，當前值：{value}ppm（注意）` |
| > 2000       | 警報     | 紅色     | > 2000   | `critical`   | `{source_name} 的 CO2 濃度超過 2000ppm，當前值：{value}ppm（警報）` |

#### 溫度

| 前端數值範圍      | 前端狀態 | 前端顯示 | 後端規則     | 後端嚴重程度 | 警報訊息模板                                                                                                             |
| ----------------- | -------- | -------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 20-26 °C          | 正常     | 綠色     | -            | -            | 不創建警報                                                                                                               |
| 18-20 或 26-28 °C | 注意     | 黃色     | ≤ 20 或 ≥ 26 | `warning`    | `{source_name} 的溫度低於 20°C，當前值：{value}°C（注意）` 或 `{source_name} 的溫度超過 26°C，當前值：{value}°C（注意）` |
| < 18 或 > 28 °C   | 警報     | 紅色     | < 18 或 > 28 | `critical`   | `{source_name} 的溫度低於 18°C，當前值：{value}°C（警報）` 或 `{source_name} 的溫度超過 28°C，當前值：{value}°C（警報）` |

#### 濕度

| 前端數值範圍     | 前端狀態 | 前端顯示 | 後端規則     | 後端嚴重程度 | 警報訊息模板                                                                                                         |
| ---------------- | -------- | -------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 30-60 %          | 正常     | 綠色     | -            | -            | 不創建警報                                                                                                           |
| 20-30 或 60-70 % | 注意     | 黃色     | ≤ 30 或 ≥ 60 | `warning`    | `{source_name} 的濕度低於 30%，當前值：{value}%（注意）` 或 `{source_name} 的濕度高於 60%，當前值：{value}%（注意）` |
| < 20 或 > 70 %   | 警報     | 紅色     | < 20 或 > 70 | `critical`   | `{source_name} 的濕度低於 20%，當前值：{value}%（警報）` 或 `{source_name} 的濕度高於 70%，當前值：{value}%（警報）` |

#### 噪音

| 前端數值範圍 | 前端狀態 | 前端顯示 | 後端規則 | 後端嚴重程度 | 警報訊息模板                                                 |
| ------------ | -------- | -------- | -------- | ------------ | ------------------------------------------------------------ |
| ≤ 55 dB      | 正常     | 綠色     | -        | -            | 不創建警報                                                   |
| 55.1-70      | 注意     | 黃色     | > 55     | `warning`    | `{source_name} 的噪音值超過 55dB，當前值：{value}dB（注意）` |
| > 70         | 警報     | 紅色     | > 70     | `critical`   | `{source_name} 的噪音值超過 70dB，當前值：{value}dB（警報）` |

**重要**：前端狀態判斷（`environment.vue`）僅用於 UI 顯示，不影響後端警報的創建和解決。

## 🚨 警報處理流程

### 創建流程

感測器讀數 → 環境監控任務（每 15 秒）→ 檢查連接狀態 → 查詢閾值規則 → 評估參數 → 創建/更新警報 → WebSocket 推送

**優化**：只在 severity 需要升級時才更新，避免不必要的資料庫操作

### 解決流程

環境監控任務 → 檢查閾值規則 → 數值恢復正常 → 匹配警報 → 更新狀態為 resolved → WebSocket 推送

### 前端監聽

WebSocket 模式（優先）→ 監聽 `alert:new`、`alert:updated`、`alert:count`  
輪詢模式（備用）→ 每 30 秒增量查詢

### 已實施的優化

✅ **重複更新優化**：只在 severity 需要升級時才更新警報，避免不必要的資料庫操作和 WebSocket 推送  
✅ **警報匹配優化**：使用 `findAlertByParameter` 統一處理，提高匹配準確性  
✅ **調試日誌**：添加結構化日誌，記錄關鍵操作便於追蹤問題  
⚠️ **前端一致性**：前端狀態判斷（UI 顯示）與後端規則基本一致，建議定期對照確保完全一致

---

**文件版本**：v1.2  
**創建日期**：2025-01-XX  
**最後更新**：2025-01-06
