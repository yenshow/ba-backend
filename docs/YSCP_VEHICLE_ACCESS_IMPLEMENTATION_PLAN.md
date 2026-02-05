# YSCP 車輛進出後端實作規劃

## 一、現況與對照

### 1.1 YSCP 與外部資料現況

- **事件**：`POST /api/yscp/event-receiver` → `yscpEventService.handleEvent()`，依 `params.ability` 分流推送 `yscp:event:vehicle`（event_veh）或 `yscp:event:acs`（event_acs）。回傳 `{ code: "0", msg: "Success", data: {} }` 收訖。
- **外部資料**：單一連線 `config.externalDatabase`（見 `externalDb.js`），多 schema 共用（如 `platform`、`baseacs`、`deviceaccess`）。**vehiclebiz** 視為同一連線下的 schema；若實際為不同資料庫實例，需另設連線。
- **location_systems**：目前支援 `environment`、`lighting`、`people_counting`、`vehicle_access`。

### 1.2 與人流統計對照

| 項目       | 人流統計                                           | 車輛進出（本規劃）                                       |
| ---------- | -------------------------------------------------- | -------------------------------------------------------- |
| 資料來源   | 外部 DB `baseacs.slot_card_records`                | 外部 DB `vehiclebiz.passageway_log_data`                 |
| 寫入主庫   | 否                                                 | 否                                                       |
| 事件觸發   | YSCP 事件可觸發刷新                                | YSCP `event_veh` 推送 WebSocket 刷新                     |
| 列表 API   | `GET /api/external-data/baseacs/slot_card_records` | `GET /api/external-data/vehiclebiz/passageway_log_data`  |
| 架構       | Handler + 白名單 + systemMapping                   | 同上                                                     |
| 地點綁定   | `entry_door_id` / `exit_door_id`（physical_id）    | `entry_lane_id` / `exit_lane_id`（vehiclebiz.lane_info） |
| 後處理標記 | `is_registered`（person_id !== -1）                | `is_blacklist`（vehicle_category === 5）                 |

車輛進出與人流統計一致：**資料只讀自外部 DB，不寫入主庫；事件僅用於通知前端刷新。**

---

## 二、資料來源：vehiclebiz.passageway_log_data

- **表**：外部 DB 之 `vehiclebiz.passageway_log_data`（出入口過車日誌）。
- **欄位與用途**（對齊 [EXTERNAL_DATA_ARCHITECTURE.md](./EXTERNAL_DATA_ARCHITECTURE.md) 的關鍵欄位寫法）：

| 欄位                                | 用途                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| lane_name                           | 車道名稱（前端顯示）                                                      |
| trigger_time                        | 過車時間（前端顯示，UTC）                                                 |
| owner_id / owner_name / owner_phone | 車主資訊（前端顯示；大頭照可參考人流由 platform 依 owner_id 取得）        |
| license_plate                       | 車牌（前端顯示）                                                          |
| plate_license_image_url             | 車牌圖片 URL（由 DB 欄位 license_plate_image_url 對應輸出）               |
| vehicle_list_id                     | 群組 ID（DB 直接欄位；**-1 或 0 = 沒有群組**）                            |
| vehicle_list_name                   | 群組名稱（DB 直接欄位）                                                   |
| vehicle_category                    | 車輛類別（由 vehicle_type 對應；**5 = 黑名單**，後處理加 `is_blacklist`） |
| passageway_id / lane_id             | 地點綁定、篩選                                                            |

- **YSCP event_veh**：只觸發 WebSocket `yscp:event:vehicle`，不寫入主庫；列表與詳情一律由查詢 `vehiclebiz.passageway_log_data` 取得。
  19

---

## 三、實作規劃

### 3.1 外部資料：Handler + 註冊 + 白名單 + systemMapping

依 [EXTERNAL_DATA_ARCHITECTURE.md](./EXTERNAL_DATA_ARCHITECTURE.md) 擴展指南，與人流統計相同流程：

1. **處理器** `src/services/externalData/handlers/passagewayLogDataHandler.js`
   - 繼承 `BaseExternalDataService`，schema `vehiclebiz`，table `passageway_log_data`。
   - 預設排序：`trigger_time` DESC；可搜尋：`lane_name`、`license_plate`、`owner_name`、`vehicle_list_name`、`passageway_name`。
   - 時間範圍：`timeRange=today` 或 `startTime` / `endTime`（對應 `trigger_time`）；未指定時預設今天。
   - 篩選：支援 `passageway_id`、`lane_id`、`vehicle_list_id`（如 `vehicle_list_id=-1` 查無群組）、`vehicle_category`（如 `5` 查黑名單）。
   - 後處理：每筆加上 `plate_license_image_url`（來自 `license_plate_image_url`）；`vehicle_list_id`/`vehicle_list_name` 為 DB 直接欄位（無則補 -1/空字串）；`vehicle_category`（來自 `vehicle_type`）、`is_blacklist`（`vehicle_type === 5`）。

2. **註冊**：`handlerFactory.js` 內 `register("vehiclebiz", "passageway_log_data", new PassagewayLogDataHandler())`。

3. **白名單**：`externalDataRoutes.js` 之 `ALLOWED_TABLES` 含 `{ schema: "vehiclebiz", table: "passageway_log_data" }`。

4. **系統對應**：`systemMapping.js` 之 `vehicle_access` 含 `passageway_log_data` 與 `lane_info`。

完成後使用既有 API：`GET /api/external-data/vehiclebiz/passageway_log_data`、`/count`、`/:id`；`GET /api/external-data/vehiclebiz/lane_info`（車道列表，供地點設定），無需另建 `/api/vehicle-access/records`。

### 3.2 地點系統：vehicle_access（location_systems）與 lane_info

- 新增 `system_type`：`vehicle_access`；CHECK 擴充為含 `vehicle_access`。
- **車道來源**：外部 DB **vehiclebiz.lane_info**（`deleted=0`），欄位：`id`、`lane_name`（車道名稱）、`lane_type`（1 進、2 出）。前端地點設定參考人流統計設計，以「入口設備／出口設備」方式選定車道（即 lane_info 的車道）。
- **system_config**：地點設定後儲存 `entry_lane_id`、`exit_lane_id`（vehiclebiz.lane_info）；列表與筆數 API 傳 `lane_id`（可多筆，逗號分隔）只抓取對應 passageway_log_data。
- **locationService**：`formatSystem`、`buildSystemConfig`、`createSystem`、`updateSystem` 及 getZones/getZoneById 篩選均支援 `vehicle_access`（與 people_counting 同模式）。

前端依地點查過車時，從 location 的 vehicle_access config 取車道 ID（`laneIds`），呼叫 `GET /api/external-data/vehiclebiz/passageway_log_data?lane_id=1,2,3` 等參數；`lane_type` 供前端判定車輛紀錄的進／出顯示。

### 3.3 事件與 WebSocket

- **yscpEventService.handleEvent()**：依 `params.ability` 查表推送對應 WebSocket（`ABILITY_WS_MAP`：event_veh → `yscp:event:vehicle`，event_acs → `yscp:event:acs`）。不寫入主庫；未對應的 ability 僅收訖不推送。
- 回傳維持 `{ code: "0", msg: "Success", data: {} }`。

前端監聽 `yscp:event:vehicle` 後重新呼叫 `GET /api/external-data/vehiclebiz/passageway_log_data` 取得最新資料。

### 3.4 錯誤與實作順序

- 事件/WebSocket 失敗：記錄 log，仍回傳 200 + `code: "0"`，避免 YSCP 重試。
- 外部查詢失敗：依既有外部資料 API 錯誤處理。

**建議實作順序**：  
1）外部資料（Handler → 註冊 → 白名單 → systemMapping）  
2）location_systems 支援 vehicle_access  
3）yscpEventService 依 ability 分流並推送 `yscp:event:vehicle`  
4）前端接 WebSocket 並呼叫外部資料 API、依 vehicle_category / is_blacklist 標示黑名單。

---

## 四、摘要

| 項目     | 內容                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 資料來源 | 外部 DB **vehiclebiz.passageway_log_data**（不新增主庫表）                                                                                               |
| 連接方式 | 與人流統計相同：單一 externalDb 連線，vehiclebiz 為 schema                                                                                               |
| 前端顯示 | lane_name, trigger_time, owner_id/owner_name, license_plate, plate_license_image_url, vehicle_list_id/vehicle_list_name, vehicle_category / is_blacklist |
| API      | `GET /api/external-data/vehiclebiz/passageway_log_data`（含 timeRange、lane_id、vehicle_list_id、vehicle_category 等）                                   |
| 事件     | event_veh → `yscp:event:vehicle`；event_acs → `yscp:event:acs`。不寫入主庫                                                                               |
| 地點綁定 | system_type = vehicle_access，config：entry_lane_id／exit_lane_id（vehiclebiz.lane_info）                                                                |

以上規劃已與人流統計及 [EXTERNAL_DATA_ARCHITECTURE.md](./EXTERNAL_DATA_ARCHITECTURE.md) 對齊，並經精簡與重構。

---

## 五、後端實作進度（已完成）

| 項目                                                    | 狀態 | 說明                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **3.1 外部資料**                                        |      |                                                                                                                                                                                                                                                                                                                                                                          |
| Handler `passagewayLogDataHandler.js`                   | ✅   | 繼承 BaseExternalDataService，schema `vehiclebiz`、table `passageway_log_data`；預設排序 `trigger_time` DESC；可搜尋 lane_name、license_plate、owner_name、vehicle_list_name、passageway_name；時間預設今天；後處理 plate_license_image_url；vehicle_list_id/vehicle_list_name 為 DB 直接欄位；vehicle_category、is_blacklist（5=黑名單）；支援多筆 `lane_id`（IN 條件） |
| Handler `laneInfoHandler.js`                            | ✅   | 繼承 BaseExternalDataService，schema `vehiclebiz`、table `lane_info`；預設 `deleted=0`；可搜尋 lane_name；供前端地點設定取得車道列表（lane_name、lane_type 1 進 2 出）                                                                                                                                                                                                   |
| handlerFactory 註冊                                     | ✅   | `register("vehiclebiz", "passageway_log_data", ...)`、`register("vehiclebiz", "lane_info", new LaneInfoHandler())`                                                                                                                                                                                                                                                       |
| 白名單 ALLOWED_TABLES                                   | ✅   | `externalDataRoutes.js` 已含 `passageway_log_data`、`lane_info`                                                                                                                                                                                                                                                                                                          |
| systemMapping                                           | ✅   | `vehicle_access: [passageway_log_data, lane_info]`                                                                                                                                                                                                                                                                                                                       |
| **3.2 地點系統 vehicle_access**                         |      |                                                                                                                                                                                                                                                                                                                                                                          |
| location_systems CHECK                                  | ✅   | `initSchema.js` 含 `vehicle_access`                                                                                                                                                                                                                                                                                                                                      |
| formatSystem / buildSystemConfig                        | ✅   | `locationService.js`：`entryLaneId`、`exitLaneId`（對應 `entry_lane_id`、`exit_lane_id`）                                                                                                                                                                                                                                                                                |
| createSystem / updateSystem / createLocationWithSystems | ✅   | 均支援 `vehicle_access`                                                                                                                                                                                                                                                                                                                                                  |
| **3.3 事件與 WebSocket**                                |      |                                                                                                                                                                                                                                                                                                                                                                          |
| yscpEventService.handleEvent                            | ✅   | `ABILITY_WS_MAP`：`event_veh` → `yscp:event:vehicle`（type: `vehicle_access`）                                                                                                                                                                                                                                                                                           |
| 回傳 200 + code "0"                                     | ✅   | 失敗時仍回傳 200，避免 YSCP 重試（`yscpEventRoutes.js`）                                                                                                                                                                                                                                                                                                                 |

**可用 API（需登入）**

- 列表：`GET /api/external-data/vehiclebiz/passageway_log_data`  
  查詢參數：`timeRange=today` 或 `startTime`、`endTime`（ISO）；`lane_id`（可多筆逗號分隔，IN 條件）、`vehicle_list_id`（如 `-1` 為無群組）、`vehicle_category`（如 `5` 為黑名單）；`search`、`limit`、`offset`、`orderBy`、`orderDirection`
- 筆數：`GET /api/external-data/vehiclebiz/passageway_log_data/count`（同上篩選）
- 單筆：`GET /api/external-data/vehiclebiz/passageway_log_data/:id`（表有主鍵時）
- 車道列表（地點設定用）：`GET /api/external-data/vehiclebiz/lane_info`（預設 `deleted=0`；可搜尋 lane_name、篩選 lane_type 1 進／2 出）

**地點綁定**：前端從 `GET /api/external-data/vehiclebiz/lane_info` 取得車道列表（lane_name、lane_type），地點設定後儲存選定的車道 ID（如 config.laneIds）；查過車時帶 `lane_id=1,2,3` 只抓取對應 passageway_log_data。`lane_type`（1 進 2 出）供前端判定車輛紀錄的進出顯示。

---

## 六、前端規劃（待實作）

### 6.1 資料來源與 API

- **列表與筆數**：呼叫 `GET /api/external-data/vehiclebiz/passageway_log_data`、`/count`（需帶入 auth token）。
- **篩選**：依地點時使用該地點 `vehicle_access` 的 `config.entryLaneId`、`exitLaneId` 傳 API `lane_id`；可選 `vehicle_list_id=-1` 僅顯示「無群組」、`vehicle_category=5` 僅顯示黑名單；時間用 `timeRange=today` 或 `startTime` / `endTime`。
- **即時更新**：監聽 WebSocket 事件 `yscp:event:vehicle`，收到後重新呼叫列表（及可選 count）API 取得最新資料。

### 6.2 WebSocket 整合

- 連線既有 WebSocket 服務（與人流等共用）。
- 訂閱事件名稱：`yscp:event:vehicle`。
- 收到 `{ type: "vehicle_access", timestamp }` 後，依目前頁面篩選條件重新請求 `passageway_log_data` 列表（可選一併刷新 count）。

### 6.3 頁面與元件建議

| 項目       | 建議                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 路由       | 例如 `/vehicle-access` 或依既有選單結構（如「車輛進出」）                                                                                                                                                                |
| 列表頁     | 表格欄位：過車時間（trigger_time）、車道名稱（lane_name）、車牌（license_plate）、車主（owner_name）、群組（vehicle_list_name）、車輛類別/黑名單（vehicle_category / is_blacklist）、車牌圖片（plate_license_image_url） |
| 篩選列     | 地點（下拉，依 location 的 vehicle_access 篩選，傳 lane_id）、時間範圍（今日 / 自訂）、「僅顯示無群組」核取（vehicle_list_id=-1）、「僅顯示黑名單」核取（vehicle_category=5）、關鍵字搜尋（對應 API `search`）           |
| 詳情／彈窗 | 單筆資料可從列表點擊，以 `GET /api/external-data/vehiclebiz/passageway_log_data/:id` 取得詳情並顯示；可顯示車牌圖片、車主資訊、is_blacklist 標示                                                                         |
| 地點管理   | 地點編輯時若系統類型含 `vehicle_access`，顯示入口車道／出口車道下拉（vehiclebiz.lane_info，與人流「入口／出口設備」類似）                                                                                                |

### 6.4 顯示與標示

- **顯示欄位**：lane_name、trigger_time、owner_id/owner_name、license_plate、plate_license_image_url、vehicle_list_id/vehicle_list_name、vehicle_category。
- **黑名單**：以 `is_blacklist` 或 `vehicle_category === 5` 標示黑名單（例如徽章或顏色）；可提供篩選「僅顯示黑名單」對應 API `vehicle_category=5`。車主大頭照可參考人流統計，依 `owner_id` 向 platform 取得人員頭像。

### 6.5 錯誤與權限

- API 錯誤：依既有後端錯誤格式處理（如 403 白名單、404 無處理器、500）。
- 未登入時導向登入；列表與 count 皆需通過 `authenticate` 中間件。

### 6.6 前端實作順序建議

1. **API 與 WebSocket**：建立車輛進出專用 API 封裝（列表、count、單筆）；訂閱 `yscp:event:vehicle` 並在收到時觸發重新拉取。
2. **列表頁**：路由與列表表格（欄位如上）；篩選列（地點、時間、僅不在名單、搜尋）。
3. **詳情／彈窗**：點擊單筆呼叫 `getById`，顯示詳情與車牌圖片、is_in_list 標示。
4. **地點管理**：若尚未支援，在地點編輯表單中為 `vehicle_access` 系統類型加入入口車道／出口車道（entry_lane_id／exit_lane_id）設定欄位。
