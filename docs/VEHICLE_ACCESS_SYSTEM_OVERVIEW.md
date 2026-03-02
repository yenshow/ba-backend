# 車輛進出系統現況說明

> 本文描述 **車輛進出系統（vehicle_access）** 的整體架構、資料來源、後端與前端實作現況。對應專案：**ba-backend**、**ba-frontend-construction**。

---

## 一、系統概述

車輛進出系統用於監控指定地點的車輛進出紀錄，並以「車輛群組」維度顯示在場／未在場統計。資料**僅從外部資料庫唯讀**，不寫入主庫；YSCP 事件僅觸發前端即時刷新，不寫入任何表。

| 項目 | 說明 |
|------|------|
| **前端路由** | `/construction-monitoring/vehicle-access` |
| **系統類型** | `vehicle_access`（location_systems 之一） |
| **事件能力** | YSCP `event_veh` → WebSocket `yscp:event:vehicle` |
| **資料寫入** | 無（唯讀外部 DB） |

---

## 二、架構與資料流

```
┌─────────────────────────────────────────────────────────────────────────┐
│  YSCP (event_veh)                                                       │
│       │                                                                  │
│       ▼                                                                  │
│  POST /api/yscp/event-receiver  ──►  yscpEventService  ──►  WebSocket   │
│       │                                    │                    │        │
│       └── 回傳 200 + code "0"              └────────────────────┼────────┘
│                                                                  │        │
│  前端訂閱 yscp:event:vehicle (type: vehicle_access) ◄────────────┘        │
│       │                                                                  │
│       ▼                                                                  │
│  防抖後重新載入：過車列表、進出場數量、總覽、車輛群組                        │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  外部資料庫（單一連線 config.externalDatabase，多 schema）                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │ vehiclebiz  │  │ anpr        │  │ platform    │  │ (其他)      │      │
│  │ passageway_ │  │ vehicle_    │  │ vehicle_    │  │             │      │
│  │ log_data    │  │ custom_list │  │ list        │  │             │      │
│  │ lane_info   │  │ vehicle_    │  │             │  │             │      │
│  │             │  │ and_list_   │  │             │  │             │      │
│  │             │  │ relation    │  │             │  │             │      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────────────┘      │
│         │                │                │                              │
│         ▼                ▼                ▼                              │
│  過車日誌、車道列表      車輛群組名單      群組內車輛                        │
│  (左側表格、進出統計)    (右側群組區塊)   (plate_license, owner_name)      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 三、資料來源

### 3.1 過車日誌（左側表格、進場／出場／在場數量）

| 項目 | 內容 |
|------|------|
| **表** | 外部 DB **vehiclebiz.passageway_log_data** |
| **用途** | 左側「車輛進出紀錄」表格、進場／出場／在場數字、總覽各地點統計 |
| **關鍵欄位** | lane_name、trigger_time、license_plate、owner_name、plate_license_image_url、allow_result（1=放行）、lane_type（1 進 2 出）、vehicle_list_id、vehicle_list_name、vehicle_category / is_blacklist（5=黑名單） |
| **lane_type** | 由 **vehiclebiz.lane_info** 依 lane_id JOIN 帶入 |

### 3.2 車道列表（地點設定用）

| 項目 | 內容 |
|------|------|
| **表** | 外部 DB **vehiclebiz.lane_info**（deleted=0） |
| **用途** | 地點管理「入口車道／出口車道」下拉選單 |
| **欄位** | id、lane_name、lane_type（1 進、2 出） |

### 3.3 車輛群組（右側「車輛群組」區塊）

| 項目 | 內容 |
|------|------|
| **群組名稱** | **anpr.vehicle_custom_list**，篩選 `list_type = 0`，取得 id、list_name、list_sequence |
| **群組內車輛 ID** | **anpr.vehicle_and_list_relation**，依 vehicle_list_id（= 群組 id）取得 vehicle_id |
| **車輛／車主** | **platform.vehicle_list**，依 id = vehicle_id 取得 plate_license、owner_name |
| **未分類** | relation 中 vehicle_list_id = 0 的車輛歸為「未分類」群組 |

**不使用**：platform.person_group、platform.person、人員大頭照。

---

## 四、後端現況

### 4.1 外部資料 Handler 與白名單

| Schema | Table | Handler | 說明 |
|--------|--------|--------|------|
| vehiclebiz | passageway_log_data | PassagewayLogDataHandler | 過車日誌，預設今日、trigger_time DESC，支援 lane_id、timeRange、vehicle_list_id、vehicle_category、search |
| vehiclebiz | lane_info | LaneInfoHandler | 車道列表，預設 deleted=0 |
| anpr | vehicle_custom_list | VehicleCustomListHandler | 車輛群組名單，預設 list_type=0 |
| anpr | vehicle_and_list_relation | VehicleAndListRelationHandler | 群組與車輛關聯 |
| platform | vehicle_list | PlatformVehicleListHandler | 車輛名單（彙總服務內部使用） |

以上表均已列入 **externalDataRoutes** 的 ALLOWED_TABLES；**systemMapping** 的 vehicle_access 對應上述 vehiclebiz / anpr / platform 表。

### 4.2 地點系統（location_systems）

- **system_type**：`vehicle_access`
- **設定欄位**：`entry_lane_id`、`exit_lane_id`（對應 vehiclebiz.lane_info 的 id）
- **locationService**：formatSystem、buildSystemConfig、createSystem、updateSystem、getZones / getZoneById 均支援 vehicle_access

### 4.3 事件與 WebSocket

- **YSCP**：`POST /api/yscp/event-receiver`，ability = `event_veh` 時推送 WebSocket `yscp:event:vehicle`（type: vehicle_access）
- **回傳**：一律 200 + `{ code: "0", msg: "Success", data: {} }`（失敗也回傳，避免 YSCP 重試）

### 4.4 對外 API（均需登入）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/external-data/vehiclebiz/passageway_log_data` | 過車記錄列表；參數：timeRange / startTime / endTime、lane_id、vehicle_list_id、vehicle_category、search、limit、offset、orderBy、orderDirection |
| GET | `/api/external-data/vehiclebiz/passageway_log_data/count` | 過車筆數（同上篩選） |
| GET | `/api/external-data/vehiclebiz/passageway_log_data/:id` | 單筆過車記錄 |
| GET | `/api/external-data/vehiclebiz/lane_info` | 車道列表（地點設定用）；參數：lane_type、search、limit |
| GET | `/api/external-data/vehicle-access/vehicle-groups` | 車輛群組彙總；回傳 `{ groups: [{ id, list_name, list_sequence, vehicles: [{ vehicle_id, plate_license, owner_name }] }] }` |

---

## 五、前端現況

### 5.1 頁面與路由

- **路徑**：`/construction-monitoring/vehicle-access`
- **選單**：system-modules 之「車輛進出管理」

### 5.2 API 封裝（useVehicleAccessApi）

| 方法 | 說明 |
|------|------|
| getVehicleDataLogList | 過車記錄列表 |
| getVehicleDataLogCount | 過車筆數（用於進場／出場／在場與總覽） |
| getVehicleDataLogById | 單筆過車記錄（可選詳情彈窗用） |
| getLaneInfoList | 車道列表（地點設定） |
| getVehicleGroups | 車輛群組彙總（右側群組 + 彈窗名單） |

### 5.3 狀態與資料載入（useVehicleAccessState）

- **地點**：從 location API 取得含 vehicle_access 的 zones，選定地點後取 entryLaneId、exitLaneId 組 lane_id 傳 API
- **過車列表**：loadLogs()，依 timeRange（今日／昨日／最近一週）與 lane_id 查 passageway_log_data
- **進場／出場／在場**：loadEntryExitOnSiteCounts()，僅計 allow_result=1 且 lane_type=1 或 2
- **車輛群組**：loadVehicleGroups() 取得彙總；organizationGroups 由 API 的 groups + 當前地點 logs 計算各群組進／出／在場
- **總覽**：loadOverviewSummaries()，各地點今日過車筆數與進／出／在場

### 5.4 主要元件

| 元件 | 用途 |
|------|------|
| VehicleStatsPanel | 進場／出場／在場數量 |
| VehicleDataLogTable | 過車記錄表（車牌圖片、車牌、車道、車主、放行結果、時間） |
| VehicleOrganizationGroupPanel | 右側車輛群組（群組名稱、在場 x/y）；點選開彈窗 |
| VehicleGroupDetailDialog | 群組內車輛名單（車主-車牌、進出場時間；無圖片欄位） |
| VehicleOverviewCard | 右側總覽卡片（各地點今日筆數與進／出／在場） |
| VehicleAccessLocationFields | 地點表單：入口／出口車道下拉 |
| VehicleAccessLocationManagement | 地點管理列表（vehicle_access） |

### 5.5 WebSocket

- **useVehicleAccessWebSocket**：訂閱 `yscp:event:vehicle`，type === "vehicle_access" 時防抖後重新載入：loadLogs、loadEntryExitOnSiteCounts、loadOverviewSummaries、loadVehicleGroups

---

## 六、顯示與業務規則

- **放行結果**：allow_result=1 且 lane_type=1 →「進入」；lane_type=2 →「離開」；allow_result=0 →「拒絕」
- **進／出／在場**：僅計 allow_result=1；在場 = 進場數 − 出場數（不小於 0）
- **車輛群組**：群組來自 anpr（list_type=0）+ 未分類；各群組在場數由當前地點、當前時間範圍內的 passageway_log_data 依車牌計算
- **黑名單**：vehicle_category=5 或 is_blacklist；API 支援篩選，列表與篩選 UI 可選顯示

---

## 七、可選／待補項目

| 項目 | 說明 |
|------|------|
| 篩選：僅無群組／僅黑名單 | State 已有 onlyNoGroup、onlyBlacklist；可補篩選列核取框並在 loadLogs 傳 vehicle_list_id=-1、vehicle_category=5 |
| 關鍵字搜尋 | loadLogs 已支援 search 參數；可於列表頁加搜尋框 |
| 列表欄位：群組、黑名單 | 可選在表格顯示 vehicle_list_name、is_blacklist |
| 單筆詳情彈窗 | 可選點擊列呼叫 getVehicleDataLogById 顯示完整詳情 |

---

## 八、相關文件

| 文件 | 說明 |
|------|------|
| [YSCP_VEHICLE_ACCESS_IMPLEMENTATION_PLAN.md](./YSCP_VEHICLE_ACCESS_IMPLEMENTATION_PLAN.md) | 實作規劃與後端／前端實作進度表 |
| [VEHICLE_ACCESS_DATA_AND_GROUP_SOURCE.md](./VEHICLE_ACCESS_DATA_AND_GROUP_SOURCE.md) | 車輛群組資料來源與關聯（anpr + platform） |
| [EXTERNAL_DATA_ARCHITECTURE.md](./EXTERNAL_DATA_ARCHITECTURE.md) | 外部資料 Handler／白名單／systemMapping 架構 |

---

*最後更新：依目前程式碼與既有文件整理。*
