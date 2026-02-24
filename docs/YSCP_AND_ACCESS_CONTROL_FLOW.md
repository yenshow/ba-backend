# YSCP 與 access_control 前後端流程：共通與分流

本文件以 **data_source** 為軸，說明人流統計與人員／門禁的**前後端共通邏輯**與 **YSCP / access_control 分流**，並將 access_control 收斂為三步：**① 設備資料建立 → ② 人員資料建立 → ③ ISAPI 設定**。

**擇一使用與優化規劃**：實務上專案可能只採用其中一種方式（僅 YSCP 或僅 access_control）。後端如何做到妥善擴充與分離、優化步驟與檔案歸類，請見 [PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md](./PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md)。

---

## 1. 概述：雙資料來源與共用邊界

人流統計使用**同一套**區域／地點與 API，差別在「人員與單位從哪來」以及「入口／出口綁定什麼」。兩流程**並存於同一套 API 與 DB**，以 `location_systems.system_config.data_source`（`yscp` | `access_control`）區分，不混合。

| 項目 | 共用 | yscp | access_control |
|------|------|------|----------------|
| **區域／地點** | zones、locations、location_systems（system_type=people_counting） | ✓ | ✓ |
| **人流 API** | GET /people-counting/sites、getSiteStats、getSiteLogs 等 | ✓ | ✓ |
| **人員／單位來源** | — | 外部 YSCP（platform.person、person_group） | 本系統（persons、person_groups、person_location_access） |
| **入口／出口綁定** | — | person_group_ids、entry_door_id、exit_door_id（YSCP 門） | entry_device_id、exit_device_id（本系統門禁設備） |
| **統計／在場人數** | — | 依外部刷卡記錄 | 依今日 isapi_access_events 計算（進場/出場/在場與 YSCP 語意一致） |

**結論**：建立區域與地點、為地點掛載 people_counting、呼叫 getSites／getSiteStats 為共用；`data_source` 決定驗證欄位與單位／進出紀錄的查詢來源。

---

## 2. 前後端共通邏輯

### 2.1 後端

- **區域與地點**：zones、locations、location_systems 共用；people_counting 的 system_config 依 data_source 存不同欄位（見 §1）。
- **地點寫入**：統一地點 API；`locationService.buildSystemConfig` 依 system_type=people_counting 寫入 data_source、person_group_ids、entry_door_id/exit_door_id（yscp）或 entry_device_id/exit_device_id（access_control）。
- **人流 getSites / getSiteStats / getSiteLogs**：同一 API；後端依 `data_source` 決定單位列表、統計與進出紀錄來源。

### 2.2 前端

- **人流統計頁、地點管理**：同一套 UI；getLocations / getSites 等同一套呼叫，後端依 data_source 分流。
- **進出紀錄**：同一表格與欄位（設備截圖、進場單位、工號、姓名、事件、時間）；工號顯示員工編號（employeeId），附圖為 `/uploads/` 時改為後端完整 URL（resolveUploadUrl）。
- **人員名單（單位）**：同一套顯示（姓名、員工編號、進出時間）；access_control 時頭像與進出時間由後端從 isapi_access_events 填寫。

---

## 3. 分流對照：YSCP vs access_control

| 項目 | yscp | access_control |
|------|------|-----------------|
| **人員／單位來源** | 外部 platform.person、person_group | 本系統 persons、person_groups、person_location_access |
| **地點必填** | personGroupIds、entryDoorId、exitDoorId | entryDeviceId（exitDeviceId 可選） |
| **可同步地點** | 不參與 | people_counting 且 entry_device_id 不為空 |
| **設備同步 API** | 不使用 | sync-location、sync-all-locations |
| **ISAPI 事件** | 不涉及 | 門禁設備 POST → isapi-events；寫入後推送 WebSocket |
| **進出紀錄（getSiteLogs）** | 外部刷卡記錄（physical_id） | isapi_access_events（依入口／出口設備 IP），並以工號查 persons/person_groups 回傳 unitName、employeeId、personName |
| **人員名單（getUnitPersonnel）** | 外部人員 + 今日刷卡 | 本系統有權限人員 + isapi_access_events 今日進出時間與統計 |

---

## 4. access_control 三步驟

採用「門禁設備（本系統）」時，需依序完成：

### 4.1 ① 設備資料建立

- **後端**：devices 表新增門禁設備（type_code = `access_control`）；config：host、username、password（Digest Auth）。
- **前端**：設備管理頁新增門禁設備；地點表單（PeopleCountingLocationFields）在 data_source=access_control 時，入口／出口選項來自 accessControlDevices。

### 4.2 ② 人員資料建立

- **後端**：person_groups、persons、person_location_access；可同步地點 = people_counting 且 entry_device_id 不為空；GET `/api/personnel/syncable-locations` 列出這些地點。
- **前端**：人員管理頁（群組、人員、門禁權限＝可進出之地點）；地點管理為該地點選「門禁設備（本系統）」並綁定入口設備（必選）、出口設備（可選）。

### 4.3 ③ ISAPI 設定

| 方向 | 說明 |
|------|------|
| **設備 → 後端** | 門禁設備設定「事件通知 → HTTP 監聽主機」：URL=`/api/personnel/isapi-events`、方法 POST。後端僅處理附圖五種事件，寫入 isapi_access_events 並推送 WebSocket；其餘回 200。 |
| **後端 → 設備** | 人員管理「設備同步」：以有權限人員名單為準，對 entry/exit 設備執行 ISAPI 新增／更新／刪除人員與人臉。 |

門禁事件僅在「人流統計 → 進出紀錄」顯示；人員管理無門禁事件 Tab。

---

## 5. 後端架構與檔案（依流程歸類）

| 類型 | 說明 |
|------|------|
| **共用** | locationService（buildSystemConfig/formatSystem）、locationRoutes；people_counting config 含 data_source、entry_device_id、exit_device_id。 |
| **YSCP** | peopleCountingService（getSites 之 yscp 分支、getRecordsByPhysicalIdsWithJoin、validateLocationData yscp）、externalDb、platform/baseacs；必填 personGroupIds、entryDoorId、exitDoorId。 |
| **access_control** | personnelService、personSyncJobService、personnelRoutes（POST isapi-events、personnel CRUD、sync）、accessControlService、peopleCountingService（getAccessControlSiteLogs、getUnitPersonnel 門禁分支、getSites 分流）。 |
| **人流 API** | peopleCountingRoutes、peopleCountingService（getSites、getSiteStats、getSiteLogs 依 data_source 分流）。 |

---

## 6. 前端對照與檔案

| 情境 | 前端 |
|------|------|
| **共用** | 人流統計頁、地點管理、getLocations/getSites；EntryExitLogTable（工號=employeeId、/uploads/ 用 resolveUploadUrl）；人員名單顯示員工編號與進出時間。 |
| **access_control ① 設備** | 設備管理頁新增門禁設備；地點表單選「門禁設備（本系統）」時，入口/出口來自 accessControlDevices。 |
| **access_control ② 人員** | 人員管理頁：群組、人員、門禁權限；地點綁定入口/出口在「地點管理」。 |
| **access_control ③ ISAPI** | 設備端設定監聽主機（前端不參與）；人員管理「設備同步」呼叫 sync-location / sync-all-locations。WebSocket 監聽 `people-counting:access-control:event` 與 `yscp:event:acs`，觸發重新載入。 |

典型檔案：personnel.vue、usePersonnelApi.ts、PeopleCountingLocationFields.vue、usePeopleCountingApi.ts、useAccessControlApi.ts、usePeopleCountingWebSocket.ts（YSCP + 門禁事件）。

---

## 7. ISAPI 細部（供查閱）

- **事件監聽（設備 → 後端）**：POST `/api/personnel/isapi-events`（不需認證）；僅 major=5 且 sub ∈ {75,76,2077,2078,2079} 寫入 isapi_access_events 並存附圖；寫入後推送 `people-counting:access-control:event`。詳見 [ISAPI_EVENT_LISTENER.md](./ISAPI_EVENT_LISTENER.md)。
- **設備請求（後端 → 設備）**：Digest Auth；searchUserInfo、updateUserInfo、deleteUserInfo、updateFace、captureFaceData；代理 API 見 [ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md)。

---

## 8. 功能旗標與分版本

- **已實踐**：`config.features.enableYscpPeopleCounting`、`enableAccessControlPersonnel`（環境變數 `ENABLE_YSCP_PEOPLE_COUNTING`、`ENABLE_ACCESS_CONTROL_PERSONNEL`，預設 true）。關閉時：personnel 路由可回傳 403；getSites 不列入 yscp 地點、getSiteLogs 對 yscp 回傳空。
- **分版本**：同一程式碼庫依旗標切換；可選延伸為 API 版本前綴或分離部署，見原規劃（已收斂至本文件）。

---

## 9. 尚未實踐與可選擴充

| 項目 | 狀態 |
|------|------|
| people_counting_logs.internal_person_id | 不實作 |
| 同步佇列（person_sync_jobs） | 後續擴充 |
| 錯誤碼／錯誤訊息 | 可加強 |

---

## 10. 擇一使用與分離策略（摘要）

兩套流程**可並存**於同一 API 與 DB，但實務上專案常**擇一使用**（只接 YSCP 或只接本系統門禁）。做法要點：

- **功能旗標**：`ENABLE_YSCP_PEOPLE_COUNTING`、`ENABLE_ACCESS_CONTROL_PERSONNEL`；關閉時可不列對應地點、不掛載對應路由。
- **擴充與分離**：以「依 data_source 委派實作」（provider）、條件載入與路由掛載、資料層邊界區分，讓同一程式碼庫支援僅 YSCP、僅 access_control、或並存，並利於未來新增第三種資料來源。

完整現況整理、擇一情境、四項策略與短中長期優化規劃見 **[PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md](./PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md)**。

---

## 11. 相關文檔

| 文檔 | 說明 |
|------|------|
| [PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md](./PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md) | 後端人流統計整理、擇一使用、擴充與分離策略、優化規劃 |
| [ISAPI_EVENT_LISTENER.md](./ISAPI_EVENT_LISTENER.md) | 門禁事件 POST 接收、寫入、即時推送 |
| [ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md) | 後端對門禁設備 ISAPI 請求與代理 API |
| [PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md](./PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md) | 人員與人流資料表與規劃 |
| [ACCESS_CONTROL_DEVICE_DESIGN.md](./ACCESS_CONTROL_DEVICE_DESIGN.md) | 門禁設備設計 |

---

**總結**：YSCP 與 access_control 共用區域／地點與人流 API 與前端頁面；差異由 `data_source` 與對應欄位、單位與進出紀錄來源決定。access_control 需三步：**① 設備資料建立 → ② 人員資料建立（含地點綁定與門禁權限）→ ③ ISAPI 設定（事件監聽 + 設備同步）**。若專案僅擇一使用，可依功能旗標與 [PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md](./PEOPLE_COUNTING_BACKEND_ORGANIZATION_AND_OPTIMIZATION.md) 進行擴充與分離。
