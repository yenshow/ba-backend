# Modbus Telemetry 重構計畫（整合設備 / 區域 / 地點 / 系統 / 監控 / 警報 / 多前端）

> 目標：把「前端輪詢 + 監控輪詢 + 多人同時開頁」造成的 Modbus/HTTP 放大效應，重構為「後端集中 Telemetry（輪詢/快取/去重/廣播）」的單一資料來源（Single Source of Truth），並同步統一 `index` 與 `environment` 取得感測器資料的方法。

---

## 1. 背景與問題定義

### 1.1 現象（已觀察到的行為）
- 後端日誌會看到大量重複的請求：`GET /api/modbus/holding-registers?host=...&port=...&unitId=...&address=...&length=1`
- 同一個前端頁面（例如首頁 `index`）每 5 秒輪詢一次，並針對每個參數逐一呼叫 `holding-registers length=1`（序列 await），造成：
  - HTTP 次數 = 啟用參數數量
  - Modbus FC03 次數 = 啟用參數數量（或更多，視頁面/邏輯而定）
- `construction-monitoring/environment.vue` 已經有「連續地址批量讀取」邏輯，但 `index.vue` 仍使用逐筆讀取，兩者方法不一致。

### 1.2 風險（為什麼一定要改）
- **同時間不同前端抓取**：同一台設備若被多個使用者同時打開，請求數會接近倍增 \(N 個前端 ≈ N 倍輪詢與 Modbus 讀取\)。
- **背景監控與警報需求**：後端 `backgroundMonitor` 會每 15 秒並行跑 `environmentMonitor` / `lightingMonitor`，它們目前也會直接讀 Modbus；若前端同時輪詢，會形成「前端輪詢 + 後端監控輪詢」的疊加。
- **效能與穩定性**：Modbus 設備通常對高頻/多連線/多 FC 呼叫較敏感；在壓力下更容易觸發 timeout / ECONNRESET，進而造成大量離線/警報抖動。

---

## 2. 現況架構盤點（多層關聯）

本段以「資料模型 → API → 監控/警報 → 前端」串出全鏈路，確保重構不漏層級。

### 2.1 DB 關聯（核心）

#### 2.1.1 區域 / 地點 / 系統（新架構）
- **`zones`**：區域（前端也稱 zone）
- **`locations`**：地點（隸屬 zone）
- **`location_systems`**：地點上的系統（多系統架構）
  - `system_type`: `'environment' | 'lighting' | 'people_counting' | ...`
  - `system_config`（JSONB）：
    - environment：`{ device_id, parameters }`
    - lighting：`{ device_id, location_x, location_y, modbus_config }`
    - people_counting：`{ person_group_ids, entry_door_id, exit_door_id }`

#### 2.1.2 設備（通用）
- **`device_types`**：設備類型（例如 `sensor`、`controller`…）
- **`device_models`**：型號（含 `config`、`port` 等）
- **`devices`**：設備實體
  - `config`（JSONB）對 Modbus 相關常見欄位：`protocol/host/port/unitId/logging/...`

#### 2.1.3 設備資料記錄（監控/歷史趨勢）
- **`device_data_logs`**
  - 由後端 `deviceDataLogger` 批次寫入（flush interval 5s）
  - 監控（environment/lighting）會讀 Modbus 後組裝值再寫入
  - `environmentService.getReadings()` 會從 `device_data_logs` 聚合回傳歷史讀數

---

## 3. 現有關聯檔案清單（需要納入重構評估）

> 這裡列的是「會被重構直接影響」或「要整合/改用 Telemetry 的」檔案；後續落地時建議以此清單做 PR 檢核。

### 3.1 後端（ba-backend）

#### 3.1.1 Modbus 通訊與 API
- `src/services/devices/modbusClient.js`
  - 目前以 `host:port:unitId` 管理連線池、提供 `readHoldingRegisters/readCoils/...`
- `src/routes/modbusRoutes.js`
  - 目前提供 `GET /api/modbus/holding-registers`（`length` 上限 125，預設 1）

#### 3.1.2 多層關聯（zone/location/system）
- `src/services/systems/locationService.js`
  - 統一 `zones/locations/location_systems` CRUD
  - `formatSystem()` 把 `system_config` 轉成前端期待的 `systems[]` 結構
- `src/routes/locationRoutes.js`（統一地點管理 API）
- `src/services/systems/environmentService.js`、`src/routes/environmentRoutes.js`
  - 以統一 locationService 實作環境系統的區域/地點管理（向後兼容 endpoints）
  - `getReadings()` 依 `location_systems.system_config.device_id` 查 `device_data_logs`
  - **重要命名差異**：`/environment/locations/:locationId/errors` 的 `locationId` 參數實際上是 `systemId (location_systems.id)`（向後兼容造成的命名混淆）
- `src/services/systems/lightingService.js`、`src/routes/lightingRoutes.js`
  - 同上，照明系統以 `areas` 術語包裝統一 locationService
  - **重要命名差異**：`/lighting/areas/:areaId/errors` 的 `areaId` 參數實際上是 `systemId (location_systems.id)`（向後兼容）

#### 3.1.3 背景監控（輪詢）與資料記錄
- `src/services/monitoring/backgroundMonitor.js`
  - 每 15 秒並行執行各監控任務
- `src/services/monitoring/environmentMonitor.js`
  - 目前直接呼叫 `modbusClient.readHoldingRegisters()` 驗證連線/讀值
  - 會依 `deviceDataLogger.getDeviceLoggingConfig()` 計算 `minAddress/maxAddress` 做一次區間讀取（這是「局部批量」）
  - 會觸發 `systemAlertHelper.clearError/recordError`（多為 `skipWebSocket: true` 批次模式）
  - 最後用 `websocketService.emitBatchDeviceStatus()` 推送狀態變更
- `src/services/monitoring/lightingMonitor.js`
  - 目前對每個 valueConfig 仍可能逐筆讀（coils/discrete/holding/input）
  - 同樣會 record/clear error 與推送 batch status
- `src/services/devices/deviceDataLogger.js`
  - 批次寫入 `device_data_logs`，且有 5 分鐘 config cache

#### 3.1.4 警報/錯誤追蹤/WS
- `src/services/alerts/systemAlertHelper.js`
  - 依錯誤訊息判斷連線錯誤並落到 device/offline 或 system/offline
- `src/services/alerts/alertService.js`
  - 建立/更新/解決/忽視警報，推送 `alert:new`、`alert:updated`、`alert:count`
- `src/services/websocket/websocketService.js`
  - 目前所有事件都是 **broadcast 給所有客戶端**
  - 設備狀態事件：`monitoring:device:status` / `monitoring:device:status:batch`

#### 3.1.5 設備管理（device/type/model）
- `src/routes/deviceRoutes.js`
- `src/services/devices/deviceService.js`
  - `sensor (modbus)` / `controller` 會自動生成 `unitId` 並檢查唯一性（host/port/unitId）
  - 會推送 `device:created/updated/deleted` 與 `device:status:changed`

#### 3.1.6 Schema（用來確認資料表/欄位）
- `src/database/initSchema.js`
- `docs/DATABASE_SCHEMA_INIT.md`

---

### 3.2 前端（ba-frontend-construction / Nuxt）

#### 3.2.1 多系統地點 adapter（關聯層的核心）
- `app/utils/locationAdapter.ts`
  - 把後端 `zones -> locations -> systems[]` 轉成各系統頁面可用的 `EnvironmentZone/LightingZone/...`
  - 特別重要：前端對 environment/lighting 都依賴 `systemId`（也就是 `location_systems.id`）

#### 3.2.2 API 層（區域/地點/錯誤追蹤）
- `app/composables/systems/useEnvironmentApi.ts`
- `app/composables/systems/useLightingApi.ts`
  - 透過通用 factory `useSystemLocationApiFactory` 呼叫後端（目前仍是 REST）

#### 3.2.3 WebSocket
- `app/composables/websocket/useWebSocket.ts`
  - 前端是單例連線；能監聽後端 broadcast 的事件

#### 3.2.4 現場造成 Modbus 讀取放大的頁面
- `app/pages/index.vue`
  - 5 秒輪詢 + 逐參數單筆讀取 `holding-registers length=1`
- `app/pages/construction-monitoring/environment.vue`
  - 有連續地址分組批量讀取（但只在該頁）
- `app/pages/infrastructure/lighting.vue`
  - 目前照明點位也會打 `/modbus/*`（讀 DI/DO、寫 DO）

---

## 4. 重構目標（最理想狀態）

### 4.1 功能目標
- `index` 與 `environment` 使用 **同一種資料取得方法**（同一 composable / 同一資料來源）。
- 背景監控與警報需求不但要保留，還要更穩定：
  - 離線/恢復判定一致
  - 閾值警報不抖動、不狂刷
- 同時間多個前端抓取時，後端必須做到：
  - **同一台設備任意時間只會有一個 in-flight 的讀取**
  - 多個請求/訂閱共用同一份快取資料

### 4.2 非功能目標（性能/可維運）
- HTTP/Modbus 次數降到「與設備數、監控頻率」同階，而非「與前端數、頁面數、參數數」同階。
- 提供可觀測性：每台設備輪詢頻率、inFlight 次數、cache hit ratio、錯誤率、連線狀態。
- 逐步遷移，保留 `/api/modbus/*` 作為診斷/工具，不再作為業務頁面主要資料來源。

---

## 5. 目標架構：後端集中 Telemetry（Single Source of Truth）

### 5.1 新增後端模組：`ModbusTelemetryService`（核心）

#### 職責
- 以 **設備** 為單位建立輪詢器（poller）與快取（cache）。
- 合併需求：
  - 來自背景監控（environmentMonitor/lightingMonitor）
  - 來自前端訂閱（index/environment/lighting UI）
- 將地址集合合併成「最少的 Modbus FC 呼叫」：
  - holding/input：FC03/FC04，單次 `length <= 125`
  - coils/discrete：FC01/FC02，單次 `length <= 2000`（可依實際庫限制調整）
- 去重：
  - Promise coalescing（同一 deviceKey 同時只允許一個讀取）
  - per-device rate limit（最小刷新間隔）
- 快取：
  - in-memory 快取最新快照（含 timestamp、quality、錯誤）
  - 可選：短 TTL（例如 500–1500ms）提升多人同時開頁的命中率
- 廣播：
  - 透過 Socket.IO 推送增量更新給所有訂閱者

#### deviceKey（關鍵識別）

本專案同時存在「以 deviceId 管理」與「以 host/port/unitId 管理」兩種語意來源。為避免重構後關聯混亂，建議採用以下規則：

- **主要鍵（推薦）**：`deviceId`
  - 來源：`location_systems.system_config.device_id`（environment/lighting）
  - 優點：與設備管理/警報/資料記錄（`device_data_logs`）天然對齊
- **次要鍵（連線鍵）**：`connectionKey = host:port:unitId`
  - 來源：從 `devices.config` 解析 `host/port/unitId`（或由 `device_models.port` 補齊）
  - 用途：底層 `modbusClient` 仍以此維護連線池與重連狀態

> 結論：Telemetry 的上層 API（給監控/前端）以 `deviceId` 為主；底層與 `modbusClient` 的互動以 `connectionKey` 為主。

---

## 6. Telemetry 介面設計（REST + WebSocket）

### 6.1 Telemetry Snapshot（統一回傳格式）
建議定義以下資料結構（概念）：

- **TelemetrySnapshot**
  - `deviceId: number`
  - `ts: string`（ISO）
  - `quality: "online" | "offline" | "stale"`（stale 表示用快取且已過期/設備暫時不可達）
  - `values`（依 register type 分層）
    - `holding: Record<string, number>`（key = address 字串）
    - `input: Record<string, number>`
    - `coil: Record<string, boolean>`
    - `discrete: Record<string, boolean>`
  - `meta`
    - `source: "poller" | "refresh" | "cache"`
    - `readRanges`（診斷用：實際讀取的區間列表）
    - `latencyMs`
    - `error?: { message, code? }`

> 為什麼 values 的 key 用 string：前端/JSON 傳輸避免 number key 被隱性轉換，且便於 diff/merge。

### 6.2 REST（只作 fallback / 管理 / 首次載入）
新增（或規劃新增）端點：

- `GET /api/telemetry/modbus/snapshot?deviceId=123`
  - 回傳最新快照（允許快取）
- `POST /api/telemetry/modbus/refresh`
  - body：`{ deviceId: number, priority?: "high" | "normal" }`
  - 行為：觸發一次讀取（但會做 coalescing 與 per-device rate limit）
- `GET /api/telemetry/modbus/status?deviceId=123`
  - 回傳 poller 狀態（輪詢頻率、最後成功時間、錯誤次數、訂閱數等）

保留既有：
- `/api/modbus/*`：定位為 **診斷/工具 API**（不再由業務頁面直接使用）

### 6.3 WebSocket（主路徑）
目前後端 `websocketService` 對所有事件採 broadcast。Telemetry 最理想應改為「房間（rooms）訂閱」，降低無關事件噪音與 client side 計算。

#### 建議事件
- `telemetry:subscribe`
  - payload：`{ deviceId, registers?: ("holding"|"input"|"coil"|"discrete")[], addresses?: { holding?: number[], input?: number[], coil?: number[], discrete?: number[] }, intervalMs?: number }`
  - 行為：socket 加入 room `telemetry:device:{deviceId}`；後端記錄訂閱需求（addresses/interval）
- `telemetry:unsubscribe`
  - payload：`{ deviceId }`
- `telemetry:update`
  - payload：TelemetrySnapshot（可做增量：只送變更 key）
  - 推送目標：room `telemetry:device:{deviceId}`
- `telemetry:status`
  - payload：`{ deviceId, status: "online"|"offline", reason?: string, ts: string }`

> 若暫時不想大改 socket server，可先維持 broadcast，但 payload 必須帶 `deviceId`，前端自行 filter；待後續再改 rooms。

---

## 7. Telemetry 讀取策略（合併/去重/快取）

### 7.1 需求合併（多來源）
Telemetry 必須能合併以下三種需求：

- **前端即時看板**（index / environment）
  - 需要：感測器參數對應的 holding registers（通常多個 address）
  - 頻率：5s（可調）
- **背景監控（environmentMonitor）**
  - 需要：用地址 0 做健康檢查 + 若啟用 logging，讀取 logging config 對應地址
  - 頻率：15s（由 backgroundMonitor）
- **背景監控（lightingMonitor）**
  - 需要：DI/DO 點位狀態（discrete/coils），以及 logging config（可能跨多 register type）
  - 頻率：15s（由 backgroundMonitor）

最理想做法：Telemetry 以 `deviceId` 聚合所有 subscriber 的 addresses，再由「地址規劃器」產生最少 readRanges。

### 7.2 地址規劃器（Address Planner）
提供兩種策略（可用設定切換）：

- **策略 A（保守）**：只合併完全連續的地址（等同目前 `environment.vue` 的 group）
  - 優點：不會讀到未使用的寄存器，風險最低
  - 缺點：若地址分散，FC 次數仍偏多
- **策略 B（理想）**：允許補洞（over-read），以更少 FC 次數換取少量多讀
  - 例如需要 `0,1,4,5,6,11,13` → 直接讀 `0..13`（length=14）
  - 需設定：
    - `maxOverReadLength`（上限）
    - `maxGap`（允許洞的大小）
    - `maxOverReadRatio`（多讀比例）

### 7.3 去重（Promise Coalescing）
同一台設備同一時間只允許一個 in-flight 讀取：
- 任何來源（前端 subscribe、REST refresh、monitoring tick）都先查 `inFlightMap.get(deviceId)`
- 若存在：直接 await 同一個 Promise（避免並發 Modbus FC）

### 7.4 快取（短 TTL + Stale）
推薦：
- `SOFT_TTL_MS = 800~1500ms`：多人同時打開頁面/同一時間多來源觸發時可直接命中
- `HARD_STALE_MS = 5000~15000ms`：超過後仍可回傳 stale 快照（避免 UI 閃爍），同時背景觸發 refresh

---

## 8. 監控/警報整合方案（重構的關鍵）

### 8.1 現況問題（為什麼監控一定要接 Telemetry）
目前 `environmentMonitor` / `lightingMonitor` 直接呼叫 `modbusClient`，同時前端也在讀取 `/api/modbus/*`，造成同一設備同一時間被重複讀取。

### 8.2 目標：監控改為消費 Telemetry（讀快取/觸發 refresh）
重構後：
- `environmentMonitor` 不再直接 `modbusClient.readHoldingRegisters()`
  - 改為 `telemetry.refresh(deviceId, { reason: "monitoring.environment" })` 或 `telemetry.getSnapshot(deviceId)`
- `lightingMonitor` 同理（含 coils/discrete）
- `systemAlertHelper.recordError/clearError` 的觸發點改由 Telemetry 的狀態機統一管理（monitor 只消費結果）

### 8.3 離線/恢復判定（建議規則）
避免抖動（flapping）：
- **offline**：連續 `N` 次失敗才判定 offline（例如 N=3）
- **online**：成功 `M` 次才判定恢復（例如 M=1 或 2）
- **cooldown**：同一設備離線警報在短時間內避免重複建立/更新（可沿用 `errorTracker` 的去重能力）

### 8.4 閾值警報（environment）
建議改為「以 Telemetry snapshot 直接判斷」，並把寫入 `device_data_logs` 作為非阻塞副作用：
- Snapshot 產生 → threshold evaluate → `systemAlertHelper.createAlert(...)`
- Snapshot 產生 → `deviceDataLogger.logDeviceValues(...)`（歷史趨勢）

---

## 9. 前端整合方案（index 與 environment 方法一致）

### 9.1 最理想：新增共用 composable（改用 WS 訂閱 Telemetry）
新增：
- `app/composables/telemetry/useModbusTelemetry.ts`（名稱可調）

行為：
- `subscribe(deviceId, addresses/registers, intervalMs)`
- 收到 `telemetry:update` 後套用 transform（目前各頁分散實作）並更新 UI state
- 斷線 fallback：低頻 `snapshot` REST（例如 15s）補洞

> index/environment 只保留「顯示哪些參數」差異，資料取得流程完全一致。

### 9.2 照明（lighting）前端
- **寫入 DO**（控制）維持 REST：`PUT /api/modbus/coils`（或既有 lighting API）
- **讀取 DI/DO 狀態**改用 Telemetry（避免每個點位各打一個 `/modbus/*`）

---

## 10. 分階段落地計畫（可大改，但要可控）

### Phase 0：盤點與開關（1–2 天）
- 新增 feature flags（環境變數）：
  - `TELEMETRY_ENABLED=true|false`
  - `TELEMETRY_WS_ROOMS=true|false`
  - `TELEMETRY_SOFT_TTL_MS=1000`
  - `TELEMETRY_MIN_REFRESH_GAP_MS=800`
- 加入 Telemetry 指標日誌（每分鐘輸出一次彙總）

### Phase 1：前端止血（立刻降低 HTTP 次數）
- 把 `index.vue` 改成和 `environment.vue` 相同的「連續地址批量讀取」策略
- 抽出共用 util / composable（先讓 index/environment 一致）
- 後端不必改（利用 `/api/modbus/holding-registers` 已支援 `length`）

### Phase 2：後端 Telemetry（去重 + 快取 + 合併）
- 新增 `src/services/telemetry/modbusTelemetryService.js`（或類似路徑）
- 先讓 monitoring 改用 Telemetry（避免前端 + 監控疊加）
- 新增 REST snapshot/refresh（給前端/管理用途）

### Phase 3：WebSocket 訂閱式 Telemetry（多人同時開頁的終極解）
- 後端 socket 加 rooms / subscribe/unsubscribe
- 前端新增 `useModbusTelemetry`，index/environment 轉用 WS 訂閱
- 後端依訂閱數動態調整輪詢頻率（refCount=0 時降頻；仍保留背景監控頻率）

### Phase 4：照明讀取整合 + logging 讀取合併
- `lightingMonitor` 的 logging 讀取目前可能逐筆（不同 register type），改由 Telemetry address planner 合併
- 前端 lighting 狀態讀取改 Telemetry（寫入仍維持既有）

---

## 11. 預期改動清單（按檔案/模組）

### 11.1 後端新增（預計）
- `src/services/telemetry/modbusTelemetryService.js`
- `src/routes/telemetryRoutes.js`（或併入既有 routes）
- （可選）`src/services/telemetry/addressPlanner.js`
- （可選）`src/services/telemetry/telemetryTypes.js`（集中定義 payload shape）

### 11.2 後端修改（預計）
- `src/services/monitoring/environmentMonitor.js`：改為讀 Telemetry
- `src/services/monitoring/lightingMonitor.js`：改為讀 Telemetry + 合併讀取
- `src/services/websocket/websocketService.js`：新增 telemetry events/rooms（若採 rooms）
- `src/server.js`：註冊 telemetryRoutes / 初始化 Telemetry

### 11.3 前端新增/修改（預計）
- 新增 `app/composables/telemetry/useModbusTelemetry.ts`
- 修改 `app/pages/index.vue`、`app/pages/construction-monitoring/environment.vue`：改用同一 composable
- 修改 `app/pages/infrastructure/lighting.vue`：讀取狀態改 Telemetry（寫入不動）

---

## 12. 相容性、回滾與風險控管

### 12.1 相容策略
- `/api/modbus/*` 保留（診斷/工具 + WS fallback）
- 現有 WS 事件（alert/device status）保留不動；Telemetry 新事件並行上線

### 12.2 回滾策略
- `TELEMETRY_ENABLED=false` 一鍵切回既有行為（監控走原本 modbusClient、前端走原本 REST）
- `TELEMETRY_WS_ROOMS=false` 退回 broadcast（前端 filter）

### 12.3 主要風險
- **補洞（over-read）**：部分設備對某些地址段讀取可能回錯或 timeout
  - 對策：先上策略 A（只合併連續），穩定後再逐步開策略 B
- **快取延遲**：soft TTL 造成 UI 稍舊
  - 對策：soft TTL 控制在 0.8–1.5s，payload 帶 `ts/quality`
- **訂閱管理複雜**：rooms/refCount/動態輪詢容易 memory leak
  - 對策：socket disconnect cleanup + 定期掃描過期訂閱

---

## 13. 驗收指標（Done Definition）

### 13.1 效能指標
- 同一台設備在同一個 polling interval 內的 Modbus FC 次數不隨前端數倍增
- 後端 log 中 `/api/modbus/holding-registers length=1` 大幅下降（僅剩診斷/工具或例外）

### 13.2 功能指標
- `index` 與 `environment` 取得資料流程一致（同 composable）
- 背景監控、離線/恢復、閾值警報正常且更穩定

---

## 14. 立即可執行的下一步（建議順序）

1. **Phase 1**：先讓 `index.vue` 改成與 `environment.vue` 同樣的批量讀取（立刻止血）
2. **Phase 2**：導入後端 Telemetry（先接管 monitoring，解除疊加）
3. **Phase 3**：前端改 WS 訂閱（解決多人同時開頁的根本問題）

