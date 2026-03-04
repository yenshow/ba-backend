# 警報系統架構釐清與完整解決方案

**文件版本**：1.0  
**更新日期**：2026-03-02  
**狀態**：架構分析與方案說明

---

## 1. 需求分析

### 1.1 業務需求

| 需求                   | 說明                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| 設備離線／連續失敗告警 | 感測器／控制器連續 N 次（如 5 次）無法連接時產生警報，訊息可依規則模板與設備名稱呈現        |
| 恢復時自動解決         | 設備恢復連線後，對應警報應自動標記為已解決，無需手動操作                                    |
| 同一問題不重複顯示     | 同一實體（同一台設備／同一地點）同一天內不應出現多筆「未解決」的相同警報，造成使用者困惑    |
| 可手動忽視             | 使用者可選擇忽視特定來源的警報，後續相同來源同類型不再創建新警報                            |
| 依日結案與限天刪除     | 當天有效、只解最新一筆 active；昨日及更早的 active 由每日排程結案；已解決且逾保留天數可刪除 |

### 1.2 觸發來源（誰會創建／清除警報）

| 來源                          | 創建時機                                                                           | 清除時機                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 環境監控 `environmentMonitor` | 檢查環境地點感測器失敗時呼叫 `recordError("environment", location.system_id, ...)` | 讀取成功時呼叫 `clearError("environment", location.system_id)` |
| 照明監控 `lightingMonitor`    | 檢查照明區域失敗時 `recordError("environment", area.system_id, ...)`               | 成功時 `clearError("lighting", area.system_id)`                |
| Modbus／設備層                | 中間件或路由在設備通訊失敗時 `recordError("device", deviceId, ...)`                | 通訊恢復時 `clearError("device", deviceId)`                    |
| 手動測試 API                  | 如 `environmentRoutes`／`lightingRoutes` 的測試接口                                | 同上，依 system 與 sourceId 呼叫 clearError                    |

### 1.3 資料模型要點

- **alerts**：每筆由 `(source, source_id, alert_type)` 辨識「哪一個實體」；同一天同組合僅一筆 active（閾值類另依 message 參數區分）。
- **error_tracking**：以 `(source, source_id)` 為唯一鍵，記錄連續錯誤次數與是否已創建警報；用於達到閾值時創建警報、恢復時重置並觸發自動解決。

---

## 2. 現有架構與處理流程

### 2.1 創建警報路徑（環境／照明）

```
environmentMonitor 檢查失敗
  → systemAlert.recordError("environment", location.system_id, errorMessage)
  → systemAlertHelper.recordError()
      若為「設備連接錯誤」且 config.getDeviceId(sourceId) 有值：
        → 取得設備資訊 getDeviceInfo(deviceId)
        → errorTracker.recordError("device", deviceId, "offline", ...)
        → 創建/更新 (device, device_id, offline) 警報
        → return（不繼續往下）
      否則：
        → config.getSourceInfo(sourceId) 取得地點名等
        → errorTracker.recordError("environment", sourceId, "offline", ...)
        → 創建/更新 (environment, location_systems.id, offline) 警報
```

要點：

- **一次呼叫只會產生一種來源的警報**：有 device 就只建 device 並 return，沒有 device 才建 environment。因此「同一實體兩筆警報」來自**不同呼叫或不同 source_id**，而非同一次呼叫建兩筆。
- **getDeviceId 目前只讀 `system_config->>'device_id'`（單一）**。若 `location_systems.system_config` 已改為 `device_ids` 陣列，則可能回傳 null，導致一律只建 environment 警報。

### 2.2 清除警報路徑（環境／照明）

```
environmentMonitor 檢查成功
  → systemAlert.clearError("environment", location.system_id)
  → systemAlertHelper.clearError()
      1. deviceId = config.getDeviceId(sourceId)
      2. 若有 deviceId：errorTracker.clearError("device", deviceId, "offline")
      3. errorTracker.clearError("environment", sourceId)
      4. 若為 environment/lighting 且有 deviceId：
           取得 getLocationSystemIdsByDeviceId(deviceId, system)
           對每個 otherId !== sourceId 呼叫 errorTracker.clearError(config.source, otherId)
      5. 可選推送 WebSocket
```

要點：

- 清除時會同時處理 **device** 與 **environment**（以及同設備的其他 location_systems），避免只解一筆、另一筆仍 active。

### 2.3 警報唯一性與解決範圍

- **創建**：`alertService.createAlert` 內透過 `findExistingActiveAlert` 查「當天、同 (source, source_id, alert_type)」是否已有 active；有則更新內容，無則新增。故同一天同一組合只會有一筆 active。
- **解決**：`updateAlertStatus(..., RESOLVED, null)` 呼叫 `resolveLatestActiveAlert(source, sourceId, alertType)`，只解「最新一筆」active（`created_at DESC LIMIT 1`）。

---

## 3. 問題根因分析

### 3.1 現象

- 前端出現兩則「展廳感測器 連續 5 次無法連接，請檢查狀態」：一則已解決（系統自動解決），一則仍為警告／離線且可忽視。
- 使用者感受：「昨天才解決，為何今天又跳出來？」

### 3.2 根因說明

1. **同一實體、兩套 (source, source_id)**
   - 同一台展廳感測器可能對應：
     - **device** 警報：`source=device`, `source_id=devices.id`
     - **environment** 警報：`source=environment`, `source_id=location_systems.id`
   - 前端都顯示同一設備名稱，但後端是兩筆不同鍵值。恢復時若只清到其中一個來源（或只清到其中一個 location_systems.id），另一筆就會一直 active，造成「又跳出來」的觀感。

2. **創建路徑分流導致不一致**
   - 若某次失敗時 `getDeviceId(sourceId)` 有值 → 只建 device 警報並 return。
   - 若某次失敗時 `getDeviceId(sourceId)` 為 null（例如 config 改為 `device_ids` 未相容）→ 只建 environment 警報。
   - 不同呼叫可能走不同分支，同一實體就會有時只有 device、有時只有 environment，或兩者先後出現，自動解決時若只清一邊就會留下另一筆。

3. **一地點多設備與 getDeviceId 單一值**
   - 環境監控已支援一地點多台設備（`device_ids` 陣列），但 `getDeviceIdFromLocation(systemId)` 仍只讀 `system_config->>'device_id'`。
   - 若資料改為僅存 `device_ids`，則 getDeviceId 回傳 null，所有警報都會變成 (environment, system_id)，且 error_tracking 以 system_id 為鍵，無法區分「哪一台設備」失敗或恢復，清除時也無法對應到正確的 device 維度。

4. **「今天又跳出來」的兩種可能**
   - **同一天兩筆**：兩筆皆為同日建立，一筆已解、一筆未解 → 即上述「兩套來源／只解一邊」或「多個 location_systems 只清部分」造成。
   - **隔天新一筆**：設計上「當天有效、隔天再發生為新一筆」，若隔天再次連續失敗，會新建一筆 active，屬預期行為；若產品希望「同一設備不要隔天再出現一次」，需另訂策略（例如依設備合併顯示或限制同一設備一天一筆）。

---

## 4. 完整解決方案

### 4.1 架構原則建議

- **單一責任**：同一「實體」（同一台設備或同一邏輯來源）在「離線／連續失敗」維度上，應盡量對應單一警報來源鍵值，避免同一事件產生多筆不同 source 的警報。
- **創建與清除對稱**：誰創建、誰清除；若以設備為維度創建，則恢復時以設備為維度清除，並可順帶清除該設備關聯的 environment/lighting 警報，避免殘留。

### 4.2 方案 A：以設備為單一維度（建議）

**目標**：同一台設備的離線警報只以 `(device, device_id, offline)` 存在；environment/lighting 僅作為「觸發來源」，不再為同一事件另建 `(environment, system_id, offline)`。

**創建**：

- 環境／照明監控呼叫 `recordError("environment"|"lighting", system_id, ...)` 時，若可解析出 **device_id**（見下方相容性），則**僅**呼叫 `errorTracker.recordError("device", deviceId, "offline", ...)`，不再呼叫 `errorTracker.recordError(config.source, sourceId, ...)`。
- 若無法解析 device_id（例如該地點未綁設備），則降級為 `(environment|lighting, system_id, offline)`。

**清除**：

- `clearError("environment"|"lighting", system_id)` 時：
  - 若有 device_id：只清除 `(device, deviceId)` 與同設備其餘 location_systems 的 `(environment|lighting, otherId)`（維持現有「一併清除同設備其它 location_systems」邏輯）。
  - 若無 device_id：只清除 `(environment|lighting, sourceId)`。

**優點**：前端不會再出現「同一設備兩筆相同訊息」；解決邏輯單純（以 device 為準）。  
**注意**：需相容「一地點多設備」：傳入 device_id 或由 system_config 解析出「當前失敗的設備」（見 4.5）。

### 4.3 方案 B：維持雙來源、強化清除與一致性

**目標**：維持現有「有時建 device、有時建 environment」的設計，但確保恢復時**一定**清掉該實體對應的所有警報。

**創建**：不變（仍可能只建 device 或只建 environment，依 getDeviceId 是否為 null）。

**清除**：

- 在 `clearError("environment"|"lighting", sourceId)` 中，已實作「依 deviceId 查詢所有同設備的 location_systems.id 並逐一 clearError」；確保 `getLocationSystemIdsByDeviceId` 能正確回傳所有關聯的 system_id（含 device_ids 陣列中每個設備對應的 location_systems，若資料模型有做關聯）。
- 若存在「僅有 environment 警報、沒有 device_id」的歷史資料，可考慮在 clearError 時依 message 或其它欄位推斷設備並嘗試清除對應 device 警報（實作複雜度較高）。

**優點**：改動小。  
**缺點**：前端仍可能短暫或偶發出現兩筆相同設備名；需嚴格保證清除邏輯與資料一致。

### 4.4 方案 C：以地點為維度、設備層與系統層分離

**目標**：環境／照明監控**只**建 `(environment|lighting, system_id)`，不建 device 警報；**僅** Modbus／設備層在設備通訊失敗時建 `(device, device_id, offline)`。

**創建**：

- `recordError("environment", system_id, ...)` 時，**不再**嘗試創建 device 警報，一律創建 `(environment, system_id, offline)`（message 仍可帶出設備名稱，由 getSourceInfo 或傳入 metadata 取得）。
- 設備層仍呼叫 `recordError("device", deviceId, ...)`，僅產生 device 警報。

**清除**：

- 環境監控成功時只清除 `(environment, system_id)` 及同設備其它 location_systems（維持現有邏輯）。
- 設備層恢復時只清除 `(device, deviceId)`。

**優點**：職責清楚（監控層＝地點維度，設備層＝設備維度）；同一實體可能仍有兩筆（設備＋地點），但創建路徑明確。  
**缺點**：若環境監控與設備層都會觸發同一台設備，仍可能出現兩筆，需在產品層決定是否接受或在前端合併顯示。

### 4.5 共通實作要點（含 device_ids 相容）

- **getDeviceId 與 system_config 相容**
  - 若 `location_systems.system_config` 支援 `device_ids` 陣列，應提供「依當前失敗設備」解析出單一 device_id 的方式。
  - 建議：環境監控在呼叫 `recordError("environment", system_id, errorMessage)` 時，若已知當前檢查的是哪一台設備（例如從 locationDevicePairs 的 device_id），可傳入選項如 `{ deviceId }`，由 `systemAlertHelper.recordError` 優先使用該 deviceId 創建 device 警報，避免只讀 `system_config->>'device_id'` 為 null 導致只建 environment。

- **一地點多設備**
  - 若同一 system_id 對應多台設備，error_tracking 若仍以 `(environment, system_id)` 為鍵，則無法區分「哪台設備」連續失敗。可考慮：
    - 改為以 `(environment, system_id, device_id)` 或複合鍵追蹤（需評估 schema 與 API 影響），或
    - 維持以 system_id 為鍵，但創建警報時在 message 中帶出設備名，清除時仍以「該 system_id 下任一設備成功即清除」的語意（與現行行為接近）。

- **歷史資料**
  - 既有「同一設備既有 device 又有 environment 警報」的資料，可透過排程或一次性腳本：對已 resolved 的成對警報做標記或合併顯示，不需強制刪除；對仍 active 的，可依 device_id 與 location_systems 關聯，補跑一次 clearError 邏輯以統一狀態。

---

## 5. 建議採用與後續步驟

- **短期**：採用 **方案 B**，確認 `getLocationSystemIdsByDeviceId` 與現有 clearError 邏輯已上線且正確；並檢查 `system_config` 是否仍為 `device_id` 或有 `device_ids`，必要時在 `recordError` 增加選項傳入 `deviceId`，使「有設備時」穩定創建 device 警報並在清除時一併處理。
- **中期**：若希望從根本避免同一設備兩筆警報，採 **方案 A**：環境／照明在可解析 device_id 時僅創建 device 警報，不再創建 environment/lighting 離線警報；clearError 維持以 device 為主、並清除同設備其它 location_systems。
- **文檔與檢查清單**：
  - 在 `ALERT_GUIDE.md` 中補充「創建策略」（何時只建 device、何時只建 environment）與「清除策略」（依 device 一併清除的範圍）。
  - 新增或更新檢查清單：部署後驗證「同一設備僅一筆 active 離線警報」、「恢復後兩筆皆解」的案例。

---

## 6. 參考

- 實作細節：`docs/ALERT_GUIDE.md`
- 服務：`src/services/alerts/alertService.js`、`systemAlertHelper.js`、`errorTracker.js`
- 監控：`src/services/monitoring/environmentMonitor.js`、`lightingMonitor.js`
- 資料模型：`location_systems.system_config`（`device_id` / `device_ids`）、`alerts`、`error_tracking`
