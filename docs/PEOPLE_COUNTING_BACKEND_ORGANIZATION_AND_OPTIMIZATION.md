# 後端人流統計整理與優化規劃：YSCP 與 access_control

本文件整理後端**人流統計**的兩種實作方式（**YSCP** 與 **access_control**），說明現況、擇一使用情境，以及如何做到**妥善擴充與分離**，並產出優化規劃供後續實作參考。

相關流程與前後端對照見 [YSCP_AND_ACCESS_CONTROL_FLOW.md](./YSCP_AND_ACCESS_CONTROL_FLOW.md)。

---

## 1. 現況整理：兩種方式與共用邊界

### 1.1 總覽

| 維度 | YSCP | access_control |
|------|------|-----------------|
| **人員／單位來源** | 外部 DB（platform.person、platform.person_group） | 本系統（persons、person_groups、person_location_access） |
| **進出紀錄來源** | 外部 baseacs.slot_card_records（physical_id） | 本系統 isapi_access_events（依入口／出口設備 IP） |
| **地點必填欄位** | personGroupIds、entryDoorId、exitDoorId | entryDeviceId（exitDeviceId 可選） |
| **依賴模組** | externalDb、yscpPersonService、peopleCountingSyncService（YSCP 群組/記錄） | personnelService、deviceService、isapi_access_events |
| **功能旗標** | `config.features.enableYscpPeopleCounting` | `config.features.enableAccessControlPersonnel` |

**共用部分**（不論擇一或並存皆會用到）：

- 區域／地點：zones、locations、location_systems（system_type = people_counting）
- 人流 API：GET /people-counting/sites、getSiteStats、getSiteLogs、getUnitPersonnel 等
- 地點寫入：locationService.buildSystemConfig 依 data_source 寫入不同欄位
- 同一套前端人流統計頁、進出紀錄表格與人員名單 UI

**分流點**：以 `location_systems.system_config.data_source`（`yscp` | `access_control`）決定「人員／單位／進出紀錄」的資料來源與驗證欄位。

### 1.2 後端檔案與職責（依方式歸類）

| 類型 | 檔案／模組 | 職責 |
|------|------------|------|
| **共用** | `locationService.js` | buildSystemConfig / formatSystem；people_counting config 含 data_source、entry_device_id、exit_device_id |
| **共用** | `peopleCountingRoutes.js` | 人流統計 API 路由（locations、sites、stats、logs、unit-personnel） |
| **共用** | `peopleCountingService.js` | 入口層：getSites、getSiteStats、getSiteLogs、getUnitPersonnel；內部依 data_source 分流 |
| **YSCP 專用** | `peopleCountingService.js`（YSCP 分支） | validateLocationData(yscp)、getPersonIdsByGroupIds、getTodayRecordsOnly、getRecordsByPhysicalIdsWithJoin、batchGetSitesData、getUnitsByGroupIds、YSCP 的 getUnitPersonnel |
| **YSCP 專用** | `externalDb.js`、`yscpPersonService.js` | 外部 platform.person / person_group、刷卡記錄、人員照片 |
| **YSCP 專用** | `yscpEventRoutes.js`、`yscpEventService.js` | YSCP 事件接收、轉發 |
| **access_control 專用** | `peopleCountingService.js`（門禁分支） | getAccessControlSiteLogs、門禁版 getSites/getSiteStats/getSiteLogs/getUnitPersonnel |
| **access_control 專用** | `personnelService.js`、`personnelRoutes.js` | 人員主檔、門禁權限、syncable-locations、sync、isapi-events |
| **access_control 專用** | `personSyncJobService.js`、`accessControlService.js` | 設備同步、ISAPI 請求 |
| **設定／路由** | `config.js`（features）、`server.js` | enableYscpPeopleCounting、enableAccessControlPersonnel；personnel 路由依旗標掛載或回傳 403 |

目前**分流邏輯集中在 `peopleCountingService.js`**：同一函數內以 `dataSource === 'access_control'` 與 `dataSource === 'yscp'` 分支，YSCP 另依 `enableYscpPeopleCounting` 決定是否列入地點或回傳空。

---

## 2. 擇一使用情境與影響

### 2.1 為何可能是「擇一」而非「並存」

- **部署環境**：有的場域僅接 YSCP，有的僅接本系統門禁設備，不會同時有兩套人員與進出來源。
- **維運與測試**：單一資料來源可降低設定複雜度與除錯範圍。
- **依賴與啟動**：擇一可避免載入未使用的 DB（external DB）、未使用的路由（/api/yscp 或 /api/personnel）與背景任務。

因此專案可能以「**僅 YSCP**」或「**僅 access_control**」部署，程式碼仍可保留兩套邏輯，以**功能旗標**或**組態**決定啟用哪一套。

### 2.2 擇一使用時的預期行為

| 情境 | 預期行為 |
|------|----------|
| **僅 YSCP** | `ENABLE_YSCP_PEOPLE_COUNTING=true`、`ENABLE_ACCESS_CONTROL_PERSONNEL=false`；僅建立 data_source=yscp 地點；/api/personnel 回傳 403；getSites 只列 YSCP 地點；不需 persons / person_groups / isapi_access_events。 |
| **僅 access_control** | `ENABLE_YSCP_PEOPLE_COUNTING=false`、`ENABLE_ACCESS_CONTROL_PERSONNEL=true`；僅建立 data_source=access_control 地點；getSites 只列門禁地點；getSiteLogs（yscp 分支）回傳空；可不連線 external DB、不掛載 /api/yscp。 |

目前實作已部分支援：

- **access_control 關閉**：server.js 依 `enableAccessControlPersonnel` 決定是否掛載 personnel 路由（否則 403）。
- **YSCP 關閉**：peopleCountingService 在 getSites 時跳過 data_source=yscp 地點；getSiteLogs 對 yscp 回傳空。

尚未完全做到（優化方向）：

- 僅 YSCP 時不載入 personnel 相關模組、不查詢本系統 persons。
- 僅 access_control 時不載入 externalDb / yscpPersonService、不掛載 yscp 路由。
- 啟動時依旗標跳過未使用方的初始化（例如 YSCP 事件接收、門禁同步排程）。

---

## 3. 擴充與分離策略

目標：**同一程式碼庫**可支援三種模式——**僅 YSCP**、**僅 access_control**、**兩者並存**——並利於未來新增第三種資料來源（例如其他門禁或打卡系統）。

### 3.1 策略一：功能旗標（已部分實踐，建議補齊）

- **維持** `config.features.enableYscpPeopleCounting`、`config.features.enableAccessControlPersonnel`。
- **建議**：
  - 在 **getPeopleCountingLocations**（或等同「列出人流地點」的 API）中，依旗標過濾回傳地點的 data_source，使前端只看到啟用中的類型。
  - 在 **建立/更新地點** 時，若某資料來源已關閉，則拒絕寫入對應的 data_source。
  - 文檔明確寫出「僅 YSCP」「僅 access_control」「並存」三種建議的環境變數組合。

這樣無需改路由或拆服務，即可在部署時擇一或並存。

### 3.2 策略二：依 data_source 委派，減少單一檔案分支

- **現況**：`peopleCountingService.js` 內大量 `if (dataSource === 'access_control')` / else（YSCP）。
- **做法**：抽出「依 data_source 選擇實作」的介面，由兩個小模組分別實作：
  - **YSCP**：取得單位列表、進出紀錄、人員名單、統計（依 external DB + slot_card_records）。
  - **access_control**：同上，依 personnelService + isapi_access_events。
- **peopleCountingService** 只負責：取地點與 config、依 `data_source` 呼叫對應實作、組裝回傳格式。
- **好處**：新增第三種來源時只需新增一個實作模組並註冊；YSCP/門禁程式碼互不干擾，易於單獨測試與關閉。

可選的介面命名（概念層）：

- `getSiteUnits(siteId, config)` → units
- `getSiteLogs(siteId, config, options)` → logs
- `getUnitPersonnel(unitId, siteId, config)` → personnel + entryCount/exitCount
- `getSiteStats(siteId, config)` → entryCount, exitCount, currentCount

實作可放在例如：

- `src/services/systems/peopleCounting/providers/yscpProvider.js`
- `src/services/systems/peopleCounting/providers/accessControlProvider.js`
- `src/services/systems/peopleCounting/peopleCountingService.js`（協調層 + 共用地點邏輯）

### 3.3 策略三：條件載入與路由掛載

- **僅 YSCP**：  
  - `enableAccessControlPersonnel === false` 時不掛載 `/api/personnel`（已實踐）。  
  - 可選：不 require personnelService / personSyncJobService，改為在需要時動態 require 或由上層注入，避免載入 isapi 相關程式碼。
- **僅 access_control**：  
  - 新增 `enableYscpPeopleCounting === false` 時不掛載 `/api/yscp`（或改為回傳 403），並在 peopleCountingService 中完全不呼叫 externalDb / yscpPersonService（已透過分支不呼叫，但若希望完全不載入，可改為動態 require 或依旗標 require 不同實作）。
- **並存**：兩旗標皆 true，維持現狀。

這樣可避免未使用方的 DB 連線、路由與背景任務被載入，降低啟動成本與誤用風險。

### 3.4 策略四：資料層邊界

- **YSCP**：所有外部讀寫限於 `externalDb`、`yscpPersonService` 及 YSCP 專用 handler；不寫入本系統 persons / person_groups。
- **access_control**：人員與進出紀錄限於本系統 persons、person_groups、person_location_access、isapi_access_events；不讀寫 external DB。
- **共用**：僅 zones、locations、location_systems 與 people_counting 的 config（含 data_source、entry/exit 設備或門 ID）。

未來若有第三種來源，同樣以「獨立資料層 + 單一 provider」方式接入，不與 YSCP/門禁混用。

---

## 4. 優化規劃與實作建議

### 4.1 短期（不重構結構，只補齊行為與文檔）

| 項目 | 說明 |
|------|------|
| **地點列表依旗標過濾** | getPeopleCountingLocations 或 getSites 回傳時，若 `enableYscpPeopleCounting === false` 則不列 data_source=yscp 地點；若 `enableAccessControlPersonnel === false` 則不列 data_source=access_control 地點。 |
| **地點寫入驗證** | 建立/更新地點時，若傳入的 data_source 對應功能已關閉，回傳 400 並說明需開啟對應功能旗標。 |
| **文檔** | 在 README 或部署文檔中列出三種模式建議的環境變數範例（僅 YSCP、僅 access_control、並存）。 |
| **YSCP 關閉時不掛載 /api/yscp** | 可選：當 `enableYscpPeopleCounting === false` 時，不掛載 yscpEventRoutes 或改為回傳 403，與 personnel 對稱。 |

### 4.2 中期（模組化分流邏輯）

| 項目 | 說明 |
|------|------|
| **抽出 YSCP provider** | 將 getSites/getSiteStats/getSiteLogs/getUnitPersonnel 的 YSCP 分支移到獨立模組（如 yscpPeopleCountingProvider.js），實作上述介面（單位、紀錄、人員、統計）。 |
| **抽出 access_control provider** | 將門禁分支移到獨立模組（如 accessControlPeopleCountingProvider.js），實作相同介面。 |
| **peopleCountingService 改為協調層** | 只做：取地點與 config、依 data_source 選擇 provider、組裝回傳、錯誤與旗標處理。 |
| **單元測試** | 為兩個 provider 分別寫測試；協調層可 mock provider，測分流與旗標。 |

### 4.3 長期（可選：依賴反轉與啟動優化）

| 項目 | 說明 |
|------|------|
| **依旗標載入模組** | 僅在 enableYscpPeopleCounting 時 require yscp 相關模組；僅在 enableAccessControlPersonnel 時 require personnel 與 isapi 相關模組；避免未使用方連線或載入。 |
| **第三資料來源** | 若未來新增其他系統（如另一套門禁或打卡），新增第三個 provider 並在 config 中註冊 data_source 對應即可。 |
| **API 版本或前綴** | 若需對外區分「僅門禁版」與「僅 YSCP 版」，可再考慮 API 版本前綴或不同部署檔，由同一程式碼庫依環境變數組態決定。 |

---

## 5. 與現有文檔的對應

| 文檔 | 對應內容 |
|------|----------|
| [YSCP_AND_ACCESS_CONTROL_FLOW.md](./YSCP_AND_ACCESS_CONTROL_FLOW.md) | 前後端流程、共用與分流對照、access_control 三步驟、後端檔案依流程歸類。 |
| [PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md](./PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md) | 人員與人流資料表、門禁權限與設備同步設計。 |
| [ISAPI_EVENT_LISTENER.md](./ISAPI_EVENT_LISTENER.md) | 門禁事件 POST、isapi_access_events 寫入與推送。 |
| [ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md) | 後端對門禁設備 ISAPI 請求與代理 API。 |

---

## 6. 總結

- **現況**：後端人流統計以 **YSCP** 與 **access_control** 兩種方式實作，共用區域／地點與人流 API，以 `data_source` 分流人員與進出紀錄來源；分流邏輯集中在 `peopleCountingService.js`，並以功能旗標控制 YSCP 是否列入與門禁路由是否掛載。
- **擇一使用**：專案可只啟用其中一種方式；透過 `ENABLE_YSCP_PEOPLE_COUNTING` 與 `ENABLE_ACCESS_CONTROL_PERSONNEL` 即可達成，建議補齊「地點列表/寫入依旗標過濾與驗證」以及「YSCP 關閉時不掛載 /api/yscp」。
- **擴充與分離**：以**功能旗標**、**data_source 委派（provider）**、**條件載入與路由**、**資料層邊界**四項策略，在不改同一程式碼庫的前提下支援僅 YSCP、僅 access_control、並存，並為未來第三種資料來源預留介面。
- **優化規劃**：短期補齊旗標行為與文檔；中期抽出 YSCP/access_control provider 並將 peopleCountingService 改為協調層；長期可選依旗標載入模組與 API 版本策略。

依照上述規劃分階段實作，即可在維持現有 API 與前端不變的前提下，達成「擇一使用」與「易於擴充、分離」的目標。
