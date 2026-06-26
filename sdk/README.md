# ba-backend HCNetSDK 梯控整合

海康 HCNetSDK 梯控整合：卡片 CRUD、樓層名稱（門參數）、遠端呼梯、佈防事件。Node.js 透過 **HcNetSdkBridge.exe**（stdin/stdout JSON）呼叫原生 SDK；佈防以 `--arming` 常駐子程序運行。

> **平台**：Windows x64 + .NET 8 Runtime（開發改碼另需 .NET 8 SDK）

---

## 功能一覽

| 功能                 | Bridge action                         | HTTP API                            | 本機測試                   |
| -------------------- | ------------------------------------- | ----------------------------------- | -------------------------- |
| 卡片列表／查詢       | `card.list` / `card.get`              | `GET .../cards`                     | `test:sdk-ladder-card-get` |
| 卡片下發／更新／刪除 | `card.create` / `update` / `delete`   | `POST` / `PUT` / `DELETE .../cards` | `test:sdk-ladder-card` 等  |
| 樓層名稱讀寫         | `door.list` / `door.get` / `door.set` | 併入地點儲存（區域管理）            | `test:sdk-ladder-door-*`   |
| 遠端呼梯／開關門     | `control.gateway`                     | `POST .../control`                  | `test:sdk-ladder-control`  |
| 佈防事件監聽         | `--arming` 常駐                       | 事件查詢 + 自動佈防                 | `test:sdk-ladder-events`   |

**卡片 vs 樓層名稱（門參數）**

|                    | 卡片 `NET_DVR_CARD_CFG_V50` | 門參數 `NET_DVR_DOOR_CFG`    |
| ------------------ | --------------------------- | ---------------------------- |
| 管理對象           | 持卡人（卡號、樓層權限）    | 設備硬體接點（樓層繼電器）   |
| 關鍵欄位           | `byDoorRight`（誰能去哪層） | `byDoorName`（樓層顯示名稱） |
| SDK 常數           | GET/SET `CARD_CFG_V50`      | GET `2108` / SET `2109`      |
| 附圖「樓層名稱」欄 | ✗ 不相關                    | ✓ 用 `door.*`                |

梯控 SDK 中 **樓層（Floor）≡ 門（Door）**，`doorIndex` 從 1 起算。

---

## 架構

```
ba-backend (Node.js)
  src/services/ladderSdk/
    sdkBridgeClient.js      spawn bridge（單次 JSON 請求）
    sdkArmingService.js     佈防常駐（server 啟動時自動連線）
    sdkCardService.js       卡片 CRUD → bridge
    sdkDoorService.js       樓層名稱（door.set）→ bridge
    sdkControlService.js    呼梯 → bridge
    sdkEventService.js      事件查詢（DB）
    sdkEventPersistence.js  寫入 ladder_sdk_events + WebSocket
  src/routes/ladderSdkRoutes.js

sdk/
  dotnet/bridge/            HcNetSdkBridge.exe
  dotnet/common/            P/Invoke 與服務層
  hcnet-sdk/lib/            HCNetSDK.dll + HCNetSDKCom/
  scripts/run-bridge.ps1    建置、複製 DLL、-Arming 測試
```

**單次請求**：Node → stdin JSON → bridge 登入設備 → stdout JSON。

**佈防**：`sdkArmingService` spawn `HcNetSdkBridge.exe --arming`，讀取 stdout NDJSON；`sdkEventPersistence` 白名單過濾後寫入 `ladder_sdk_events`，推送 WebSocket `ladder-sdk:event`。

---

## 前置需求與環境變數

| 項目     | 說明                                               |
| -------- | -------------------------------------------------- |
| 作業系統 | Windows 10/11 x64                                  |
| .NET     | 8.0 Runtime；改碼時需 SDK                          |
| HCNetSDK | 預設 `sdk/hcnet-sdk/`；可設 `HCNETSDK_ROOT`        |
| Bridge   | 改碼後 `npm run sdk:build`；正式打包已附 exe + DLL |

| 變數（可選）            | 說明                 |
| ----------------------- | -------------------- |
| `HCNETSDK_ROOT`         | SDK 根目錄           |
| `LADDER_SDK_BRIDGE_EXE` | 自訂 bridge exe 路徑 |

---

## Bridge JSON 協定

### 請求（stdin，單行）

```json
{
  "action": "card.list",
  "device": {
    "host": "192.168.6.100",
    "port": 8000,
    "username": "admin",
    "password": "密碼"
  },
  "payload": {}
}
```

### 回應（stdout）

```json
{ "ok": true, "code": null, "message": null, "data": {} }
```

失敗時 `ok: false`，`code` / `message` 說明原因。

### Action 參考

**卡片**

| action                        | payload  | 說明                    |
| ----------------------------- | -------- | ----------------------- |
| `card.list`                   | —        | 列出所有卡片            |
| `card.get`                    | `cardNo` | 查詢單張                |
| `card.create` / `card.update` | 見下表   | 下發／更新              |
| `card.delete`                 | `cardNo` | 刪除（`byCardValid=0`） |

| 欄位                                       | 必填            | 說明                      |
| ------------------------------------------ | --------------- | ------------------------- |
| `cardNo`                                   | ✓               | 卡號                      |
| `floors`                                   | create/update ✓ | 授權樓層，如 `[1,2,3]`    |
| `homeFloor`                                |                 | 歸屬樓層，預設 1          |
| `name` / `employeeNo` / `password`         |                 | 持卡人資訊；部分梯控機不寫入 `byName`，API 會以人員主檔補齊 |
| `cardType`                                 |                 | 1=普通卡（預設）          |
| `validEnabled` / `validBegin` / `validEnd` |                 | 有效期                    |
| `floorMode`                                |                 | `byte`（預設）或 `bitmap` |

**樓層名稱（門參數）**

| action      | payload             | 說明                                                                |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| `door.list` | `limit?`            | 列出樓層名稱；`limit` 限制筆數，省略則依 ACS 能力集上限（可能 128） |
| `door.get`  | `doorIndex`         | 讀取單層（≥1）                                                      |
| `door.set`  | `doorIndex`, `name`, `openDuration?` | 修改名稱與／或繼電器動作時間；內部先 Get 再 Set，避免覆蓋其他門參數 |

底層：`NET_DVR_GetDVRConfig` / `SetDVRConfig`，command `2108` / `2109`，欄位 `byDoorName[32]`、`byOpenDuration`（1–255 秒）。

**呼梯／門控（`control.gateway`）**

| action            | payload                   | 說明                                                                                                               |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `control.gateway` | `gatewayIndex`, `command` | `gatewayIndex`：-1 全部，≥1 指定樓層；`command` 見下表 |

Node `sdkControlService` 字串對照：

| command 字串 | SDK 值 | 用途 |
|--------------|--------|------|
| `open` / `manual` | 1 | 梯控手動開門 |
| `normally_open` | 2 | 梯控常開 |
| `normally_closed` | 3 | 梯控常閉 |
| `visitor_call` | 5 | 呼梯（訪客） |

電梯監控：梯控操作走 `ladder_device` + `ladder_gateway`；呼梯走 `call_device` + `call_gateway`；僅 `visitor_call` 會觸發平台運行態動畫。

### 佈防（`HcNetSdkBridge.exe --arming`）

stdout 逐行 NDJSON，由 `sdkArmingService` 注入 `SDK_DEVICE_*` 環境變數：

| type      | 說明                   |
| --------- | ---------------------- |
| `ready`   | 佈防成功               |
| `event`   | ACS 事件（全部 major/minor） |
| `error`   | 連線或佈防失敗         |
| `stopped` | 程序結束               |

---

## 佈防事件白名單

Bridge 佈防輸出**全部** ACS 事件；後端 `sdkEventPersistence` 寫入 DB／WebSocket 前套用白名單：

| Major | Minor | 說明           |
| ----- | ----- | -------------- |
| 0x3   | 0x400 | 遠端開門       |
| 0x3   | 0x401 | 遠端關門       |
| 0x3   | 0x402 | 遠端常開       |
| 0x3   | 0x403 | 遠端常閉       |
| 0x5   | 0x01  | 合法卡通行     |
| 0x5   | 0x5f  | 呼梯繼電器斷開 |
| 0x5   | 0x60  | 呼梯繼電器閉合 |
| 0x5   | 0x63  | 關門           |
| 0x5   | 0x64  | 開門           |

---

## 本機測試

在 `ba-backend` 目錄執行。改碼後先 `npm run sdk:build`（若 exe 被佈防程序占用，需先停後端）。

**參數設定**：直接編輯 `scripts/testLadderSdk.js` 頂部 `CONFIG`（設備 IP、密碼、doorLimit 等），無需設定環境變數。

```powershell
cd ba-backend
npm run sdk:build

# 編輯 scripts/testLadderSdk.js → CONFIG.device.password、CONFIG.doorLimit 等

# 卡片
npm run test:sdk-ladder-card-get
npm run test:sdk-ladder-card          # create
npm run test:sdk-ladder-card-update
npm run test:sdk-ladder-card-delete

# 樓層名稱
npm run test:sdk-ladder-door-list     # CONFIG.doorLimit，預設 10
npm run test:sdk-ladder-door-get      # CONFIG.doorIndex
npm run test:sdk-ladder-door-set      # CONFIG.doorIndex、CONFIG.doorName

# 呼梯
npm run test:sdk-ladder-control

# 佈防（Ctrl+C 結束；輸出全部 ACS 事件；會先結束既有 HcNetSdkBridge 程序）
npm run test:sdk-ladder-events
```

腳本：`scripts/testLadderSdk.js`（卡片／門／呼梯）；佈防走 `sdk/scripts/run-bridge.ps1 -Arming`。

| CONFIG 欄位 | 預設 | 用途 |
| ----------- | ---- | ---- |
| `device.host` / `port` / `username` / `password` | 見腳本 | 梯控設備連線 |
| `cardNo` | `1234567890` | 卡號 |
| `cardFloors` | `[1,2,3]` | 授權樓層 |
| `cardHomeFloor` | `3` | 歸屬樓層 |
| `cardFloorMode` | `byte` | 樓層編碼 |
| `gatewayIndex` | `1` | 呼梯樓層 |
| `controlCommand` | `1` | 呼梯指令 0~6 |
| `doorIndex` | `1` | 門／樓層編號 |
| `doorName` | `Floor 01` | 樓層名稱 |
| `doorLimit` | `10` | door.list 上限（0=全部） |

---

## HTTP API

前綴 `/api/ladder-sdk`（需登入）。設備連線資訊取自 `devices` 表（見下方設備設定）。

### 卡片

| 方法   | 路徑                               | 權限                                             |
| ------ | ---------------------------------- | ------------------------------------------------ |
| GET    | `/devices/:deviceId/cards`         | `system.equipment_management`                    |
| GET    | `/devices/:deviceId/cards/:cardNo` | 同上                                             |
| POST   | `/devices/:deviceId/cards`         | `...device.update`（body：`cardNo`、`floors[]`） |
| PUT    | `/devices/:deviceId/cards/:cardNo` | 同上（body：`floors[]`）                         |
| DELETE | `/devices/:deviceId/cards/:cardNo` | 同上                                             |

### 呼梯

| 方法 | 路徑                         | Body                                                                                              |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| POST | `/devices/:deviceId/control` | `{ gatewayIndex?, command }`，`command` 為 `open` / `close` / `normally_open` / `normally_closed` |

### 事件與佈防

| 方法 | 路徑              | 說明                                                      |
| ---- | ----------------- | --------------------------------------------------------- |
| GET  | `/events`         | 分頁查詢（`deviceId`、`cardNo`、時間、`limit`、`offset`） |
| GET  | `/events/latest`  | 最新事件（預設 20 筆）                                    |
| GET  | `/arming/status`  | 佈防程序狀態                                              |
| POST | `/arming/refresh` | 重啟佈防連線                                              |

事件寫入 `ladder_sdk_events`，推送 WebSocket **`ladder-sdk:event`**。

**樓層名稱（併入地點儲存）**

區域管理 → 電梯地點儲存時，平台寫入 `location_systems.system_config.floors[]`（含 `label`、`ladder_gateway` 等），並以 `door.set` 同步梯控門名至設備。詳見 `docs/40-systems/elevator.md`。

下發失敗時 API 回傳 `ELEVATOR_FLOOR_SYNC_FAILED`（DB 已寫入，需重試同步）。

---

## 設備設定

需在 `devices` 表建立可連線設備：

**controller + hcnet_sdk**

```json
{
  "type_code": "controller",
  "config": {
    "protocol": "hcnet_sdk",
    "host": "192.168.6.100",
    "port": 8000,
    "username": "admin",
    "password": "密碼"
  }
}
```

`port` 為 SDK 埠（預設 8000，非 ISAPI 80/443）。

**access_control**（含 `sdk_port`）

```json
{
  "type_code": "access_control",
  "config": {
    "host": "192.168.6.100",
    "sdk_port": 8000,
    "username": "admin",
    "password": "密碼"
  }
}
```

**佈防自動啟動**：`server.js` 啟動時 `sdkArmingService.start()`，掃描 `location_systems`（`system_type = 'elevator'`）的 `ladder_device.device_id`，每台梯控設備建立佈防子程序；斷線 10 秒後重連。

---

## 人員梯控卡

平台主檔 `person_ladder_cards`，與設備下發分離：

| 項目 | 說明                                                                      |
| ---- | ------------------------------------------------------------------------- |
| API  | `PUT /api/personnel/persons/:id/ladder-card`                              |
| 權限 | `system.personnel.person.update`                                          |
| Body | `{ cardNo, floors, homeFloor?, ... }`；`clear: true` 或空 `cardNo` 可清除 |
| 同步 | `elevatorFloorSyncJobService` 排程下發至設備                              |

---

## 常見錯誤

| 情況                       | 處理                                        |
| -------------------------- | ------------------------------------------- |
| 找不到 HcNetSdkBridge.exe  | `npm run sdk:build` 或確認打包目錄          |
| exe 建置失敗（檔案被占用） | 停止後端佈防子程序後再建置                  |
| 找不到 HCNetSDK.dll        | 確認 `sdk/hcnet-sdk/lib/` 含 `HCNetSDKCom/` |
| SDK 錯誤碼 1               | 帳密錯誤                                    |
| SDK 錯誤碼 7               | 設備離線或網路不通                          |
| SDK 錯誤碼 109             | 缺少 `HCNetSDKCom/HCAlarm.dll`              |
| SDK 錯誤碼 1924            | 佈防資源已滿                                |
| Bridge 逾時                | 預設 90 秒；大量卡片查詢可能需調整          |

---

## 部署

打包應包含：

- `sdk/dotnet/bridge/bin/Release/net8.0/win-x64/HcNetSdkBridge.exe`
- `sdk/hcnet-sdk/lib/*.dll` 與 `HCNetSDKCom/`（與 exe 同目錄，`run-bridge.ps1` 建置時會複製）

目標機器只需 .NET 8 Runtime，無需現場 `dotnet publish`。後端啟動後佈防與 API 即可使用。
