# 門禁 ISAPI：佈防模式（訂閱事件）

後端主動向門禁設備訂閱事件（長連線 keep-alive），設備端**不需**設定 HTTP 監聽主機。事件寫入 `isapi_access_events`、附圖存 `uploads/isapi-events/`、推送 WebSocket。

---

## 1. 架構概覽

```
┌─────────────────────────────────────────────────────────────────────────┐
│  後端（ba-backend）                                                       │
│                                                                          │
│  訂閱服務（依門禁設備列表）                                                 │
│    │                                                                     │
│    ├─ 對設備 A (entry_device_id) ──► POST .../subscribeEvent (Digest)     │
│    │       ◄── 長連線，設備推送事件（含 heartbeat）                         │
│    │                                                                     │
│    ├─ 對設備 B (exit_device_id)  ──► POST .../subscribeEvent (Digest)    │
│    │       ◄── 長連線，設備推送事件                                        │
│    │                                                                     │
│    └─ 解析事件 → 寫入 isapi_access_events、存附圖 → 推送 WebSocket       │
└─────────────────────────────────────────────────────────────────────────┘
```

- **設備列表**：由 `location_systems`（people_counting）的 `entry_device_id`、`exit_device_id` 去重取得門禁設備。
- **事件處理**：僅處理 major=5 且 sub ∈ {75,76,2077,2078,2079}，寫入 DB、存附圖、推送 `people-counting:access-control:event`。

---

## 2. 訂閱請求規格（後端 → 設備）

### 2.1 端點與方法

| 項目 | 值 |
|------|-----|
| **URL** | `http://<設備IP>:<port>/ISAPI/Event/notification/subscribeEvent` |
| **Port** | 一般為 80（與設備 config.port 一致） |
| **Method** | **POST** |
| **認證** | **Digest Auth**（與現有 ISAPI 設備請求相同，使用 devices 表 config 的 username、password） |
| **Content-Type** | `application/xml` 或 `text/xml` |

範例：`POST http://192.168.2.34:80/ISAPI/Event/notification/subscribeEvent`

### 2.2 訂閱 XML 範例（eventMode=all）

目前後端使用 **eventMode=all** 訂閱全部事件，設備會推送所有類型；寫入 DB 時仍僅處理 major=5 且 sub ∈ {75,76,2077,2078,2079}。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<SubscribeEvent version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <heartbeat>30</heartbeat>
    <eventMode>all</eventMode>
</SubscribeEvent>
```

| 欄位 | 說明 |
|------|------|
| **heartbeat** | 保活間隔（秒），建議 30。 |
| **eventMode** | `all` 訂閱全部事件；亦可改為 `list` 並指定 EventList 以只收門禁事件。 |

**寫入篩選**：僅 majorEventType=5 且 subEventType ∈ {75,76,2077,2078,2079}（人臉辨識成功/失敗、酒精檢測）會寫入 `isapi_access_events` 並推送 WebSocket。

---

## 3. 長連線與事件串流

- 後端送出 POST 訂閱且設備接受後，**連線保持開啟**；設備在該連線上推送事件（含 heartbeat）。
- 事件格式為 multipart：先 JSON 事件、後附圖；後端依 boundary 切 part，先寫入事件再以下一 part 補圖。
- 連線中斷時後端**自動重連**（延遲後對同一設備再次 POST subscribeEvent）。

---

## 4. 設定步驟

### 4.1 設備端

1. **勿**在設備上設定「事件通知 → HTTP 監聽主機」或「事件推送」的後端 URL。
2. 僅需確保後端能連到設備（IP:port）且 Digest 帳密與 devices.config 一致。

### 4.2 後端

1. **佈防訂閱服務**：在 `ENABLE_ACCESS_CONTROL_PERSONNEL` 不為 false 時，伺服器啟動後自動執行 `isapiSubscribeService.start()`。
2. **訂閱對象**：由 `location_systems`（people_counting）的 entry_device_id、exit_device_id 彙總不重複的門禁設備，對每台發送 `POST /ISAPI/Event/notification/subscribeEvent`（Digest Auth + 上述 XML），長連線接收事件。
3. **原監聽端點**：`POST /api/personnel/isapi-events` 已廢止，回傳 410 Gone。

### 4.3 檢查清單

| 項目 | 說明 |
|------|------|
| 設備不再設定監聽主機 | 確認門禁設備上已移除後端 isapi-events URL |
| 後端可連設備 | 後端伺服器能存取門禁設備 IP:port（如 192.168.2.34:80） |
| 設備帳密 | devices.config 的 username、password 與設備 Digest Auth 一致 |
| 訂閱 XML | heartbeat=30，eventMode=all（寫入時仍僅處理上述五種 subEventType） |
| 事件處理 | 與現有一致：僅上述五種寫入 DB、存附圖、推 WebSocket |

---

## 5. 與現有程式對應

- **寫入與推送**：訂閱收到之事件寫入 `isapi_access_events`、附圖存 `uploads/isapi-events/`、呼叫 `websocketService.emitIsapiAccessEvent()`（與原監聽模式邏輯一致，共用 `isapiEventPersistence`）。
- **設備請求（人員同步）**：不變，仍為後端對設備呼叫 searchUserInfo、updateUserInfo、deleteUserInfo、updateFace、captureFaceData 等（見 [ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md)）。
- **流程文件**：access_control 第三步「ISAPI 設定」已全面改為佈防；完整設備流程見 [ACCESS_CONTROL_DEVICE_FLOW.md](./ACCESS_CONTROL_DEVICE_FLOW.md)。

---

## 6. 日誌

僅輸出兩類：`[ISAPI] 佈防訂閱啟動`（deviceIds、count）、`[ISAPI] 已寫入門禁事件`（經篩選且寫入 DB 時）。非 major=5 或 sub∉{75,76,2077,2078,2079} 的事件靜默略過，不記錄。

---

## 7. 相關文檔

| 文檔 | 說明 |
|------|------|
| [ACCESS_CONTROL_DEVICE_FLOW.md](./ACCESS_CONTROL_DEVICE_FLOW.md) | 門禁設備完整流程（設備建立 → 地點綁定 → 佈防訂閱） |
| [YSCP_AND_ACCESS_CONTROL_FLOW.md](./YSCP_AND_ACCESS_CONTROL_FLOW.md) | 門禁三步驟與 ISAPI 設定（全面佈防） |
| [ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md) | 後端對門禁設備 ISAPI 請求與代理 API（人員同步） |
| [PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md](./PERSONNEL_DATABASE_AND_PEOPLE_COUNTING_PLAN.md) | 人員與人流、設備同步 |
| [ACCESS_CONTROL_DEVICE_DESIGN.md](./ACCESS_CONTROL_DEVICE_DESIGN.md) | 門禁設備設計 |

---

*後端實作：`isapiSubscribeService`、`isapiClient.requestSubscribeStream`、`isapiEventPersistence`；長連線解析與斷線重連已內建。*
