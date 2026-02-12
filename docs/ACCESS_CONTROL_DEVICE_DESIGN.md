# 門禁設備類型與型號設計說明

## 1. 概述

不同 ISAPI 門禁／人臉設備（如 AC-02、AC-07）在**同一支 API** 上可能會有**參數或行為差異**。例如「呼叫設備截圖」`POST /ISAPI/AccessControl/CaptureFaceData`：

- **AC-02**：`dataType` 需為 `binary`
- **AC-07**：`dataType` 需為 `url`

若後端只寫死一種參數，會導致部分設備無法正常運作。本設計說明如何依現有**設備類型 → 設備型號 → 設備實例**架構，支援門禁設備的型號差異與新增流程。

---

## 2. 現有設備系統架構摘要

系統已具備三層結構，無須新增表，只需**補齊門禁類型與型號的約定**即可。

| 層級 | 表 | 說明 |
|------|-----|------|
| **設備類型** | `device_types` | 如：攝影機、感測器、控制器、**門禁設備** |
| **設備型號** | `device_models` | 隸屬於某類型，可存型號專用設定（如 ISAPI 參數差異） |
| **設備實例** | `devices` | 實際一台設備，綁定型號 + 連線／認證等 config |

### 2.1 門禁設備類型（已存在）

在 `initSchema.js` 中已預設建立：

| name | code | description |
|------|------|-------------|
| 門禁設備 | `access_control` | ISAPI 門禁／人臉設備 |

因此**不需要再新增設備類型**，只需確保後端在「新增／編輯設備」時，對 `type_code === 'access_control'` 做 config 驗證與型號差異處理。

### 2.2 設備型號（device_models）

- **type_id**：關聯到 `device_types`（門禁設備的 type_id）。
- **config (JSONB)**：可存放**該型號**的 ISAPI 差異（例如 CaptureFaceData 的 `dataType`、`readerID` 預設值等）。
- **port**：預設 502 多為 Modbus 用；門禁設備可沿用欄位存 HTTP 埠，或一律在 `devices.config` 指定。

### 2.3 設備實例（devices）

- **model_id**：指向某一個設備型號（如 AC-02、AC-07）。
- **type_id**：與 device_types 一致（門禁即 `access_control`）。
- **config (JSONB)**：該**單一設備**的連線與認證資訊（host、port、Digest 帳密等）。

---

## 3. 為何需要「設備型號」？

- **型號**代表一類硬體／韌體行為，例如：
  - **AC-02**：CaptureFaceData 使用 `dataType: "binary"`
  - **AC-07**：CaptureFaceData 使用 `dataType: "url"`
- 若只存「設備類型 = 門禁」，無法區分 AC-02 與 AC-07，後端呼叫 CaptureFaceData 時就無法選對參數。
- 將差異放在 **device_models.config**，新增多台同型號設備時可共用同一套參數，避免每台設備重複設定。

---

## 4. 設計建議

### 4.1 設備類型：門禁設備（access_control）

- 使用既有 `device_types` 記錄，`code = 'access_control'`。
- 後端需在 `deviceHelpers.validateDeviceConfig` 中新增 `case 'access_control'`，驗證 `devices.config` 必填欄位（見 4.3）。

### 4.2 設備型號（device_models）— 依型號儲存 ISAPI 差異

門禁設備型號的 **config** 建議結構（可依實作擴充）：

```json
{
  "isapi": {
    "captureFaceData": {
      "dataType": "url",
      "captureInfrared": true,
      "readerID": 1
    }
  }
}
```

- **captureFaceData**：對應 `POST /ISAPI/AccessControl/CaptureFaceData` 的 Request Body 參數。
  - **AC-02**：`"dataType": "binary"`
  - **AC-07**：`"dataType": "url"`
- 其他 ISAPI 若有因型號而異的參數，可同樣放在 `isapi.<apiName>` 下。
- 後端呼叫設備時：先取 `devices.model_id` → 查 `device_models.config` → 依型號組出對應的 XML/JSON。

**型號範例**（僅概念，實際以 API 新增為準）：

| 型號名稱 | type_id（門禁） | config.isapi.captureFaceData.dataType |
|----------|------------------|----------------------------------------|
| AC-02    | 門禁設備 id      | `binary`                               |
| AC-07    | 門禁設備 id      | `url`                                  |

### 4.3 設備實例（devices）— 連線與認證

門禁設備的 **devices.config** 建議結構：

```json
{
  "type": "access_control",
  "host": "192.168.2.34",
  "port": 80,
  "username": "admin",
  "password": "****"
}
```

- **host**（必填）：設備 IP 或 hostname。
- **port**（選填）：預設 80；若設備型號有預設 port 也可從 `device_models.port` 讀取。
- **username / password**（必填）：Digest Auth 用。
- **type**（必填）：固定 `"access_control"`，與 `device_types.code` 一致，供驗證用。

後端發送 ISAPI 請求時：以 `devices.config` 組成 Base URL（`http://{host}:{port}`）並使用 Digest Auth，再依 `device_models.config` 組出該型號正確的 Body。

### 4.4 資料庫與現有文檔

- **device_types**：已有「門禁設備」`access_control`，無需改表。
- **device_models**：已有 `config` JSONB，用於存放 `isapi.captureFaceData` 等型號差異。
- **devices**：已有 `config` JSONB，用於存放 host、port、username、password。
- 建議在 **DATABASE_DOCUMENTATION.md** 的「devices.config 依類型」中補上一列：
  - **access_control**：`type`, `host`(必), `port`(選, 預設 80), `username`(必), `password`(必)

---

## 5. 流程總結：不同型號與新增設備

1. **設備類型**  
   - 使用既有「門禁設備」（code: `access_control`）。

2. **新增設備型號**（例如 AC-02、AC-07）  
   - 在後台選擇類型「門禁設備」。
   - 填寫型號名稱、描述。
   - 在型號的 **config** 中設定該型號的 ISAPI 參數（如 `isapi.captureFaceData.dataType`）。

3. **新增設備**  
   - 選擇類型「門禁設備」、型號「AC-02」或「AC-07」。
   - 填寫設備名稱、位置等。
   - 在設備 **config** 中填寫 `host`、`port`、`username`、`password`。
   - 後端依 `model_id` 讀取型號 config，發送 ISAPI 時使用對應參數（如 CaptureFaceData 的 dataType）。

4. **後端實作要點**  
   - 實作 ISAPI 客戶端（Digest Auth）時，以 **devices.config** 建連線。
   - 呼叫各 ISAPI 前，依 **device_models.config**（或型號 + 預設值）組裝 Request Body，以支援 AC-02 / AC-07 等差異。

---

## 6. 與 ISAPI 文檔的對應

- 共通 API 清單、路徑、認證方式見 **[ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md)**。
- 其中「呼叫設備截圖」等會因型號而異的參數，以本文件的 **device_models.config.isapi** 為準；文檔中可註明「依型號可能為 binary 或 url，請由設備型號 config 決定」。

---

## 7. 建議實作順序

1. 在 **deviceHelpers.js** 的 `validateDeviceConfig` 中新增 `access_control` 的 case，驗證 `host`、`username`、`password`（及可選 `port`）。
2. 更新 **DATABASE_DOCUMENTATION.md**，補上 `access_control` 的 config 說明。
3. 建立門禁設備型號（如 AC-02、AC-07）的預設或種子資料，寫入 `device_models.config.isapi.captureFaceData`。
4. 實作 ISAPI 服務層：讀取 device + model config，組裝 Base URL、Digest Auth、以及依型號變動的 Body（如 CaptureFaceData XML）。

以上完成後，即可依「設備類型 → 設備型號 → 設備實例」擴充更多門禁型號與設備，無須改表結構。

---

## 7.1 人流統計地點設定（後端已支援門禁資料來源）

人流統計地點的 `location_systems.system_config`（system_type = `people_counting`）已擴充，前端可共用同一頁面與元件：

- **dataSource**（存 DB 為 `data_source`）：`'yscp'`（預設）或 `'access_control'`。
- **entryDeviceId** / **exitDeviceId**（存 DB 為 `entry_device_id` / `exit_device_id`）：本系統門禁設備 ID（`devices.id`），當資料來源為門禁時使用。
- 當 `dataSource === 'yscp'`：沿用 `entryDoorId`、`exitDoorId`、`personGroupIds`（YSCP）。
- 當 `dataSource === 'access_control'`：必填 `entryDeviceId`；`exitDeviceId` 選填；`personGroupIds` 可為空（門禁人員由 ISAPI 管理）。

建立／更新人流地點時傳入 `dataSource`、`entryDeviceId`、`exitDeviceId` 即可。見 [DATABASE_DOCUMENTATION.md](./DATABASE_DOCUMENTATION.md) 地點一節。

---

## 8. 後端實作完成（API 端點）

以下 REST API 已實作，需登入認證；寫入類需管理員或操作員。

| 功能 | 方法 | 路徑 | 說明 |
|------|------|------|------|
| 取得人員列表 | POST | `/api/access-control/devices/:deviceId/user-info` | Body 可選：`searchResultPosition`, `maxResults` |
| 修改單一人員 | PUT | `/api/access-control/devices/:deviceId/user-info` | Body：`UserInfo` 或 `{ UserInfo }` |
| 刪除人員 | DELETE | `/api/access-control/devices/:deviceId/user-info` | Body：`{ employeeNo }` 或 `{ employeeNoList: string[] }` |
| 上傳人臉圖 | PUT | `/api/access-control/devices/:deviceId/user-info/:employeeNo/face` | multipart 欄位 `img`；可選 `faceLibType`, `FDID`, `faceType` |
| 呼叫設備截圖 | POST | `/api/access-control/devices/:deviceId/capture-face` | Body 可選：`dataType`, `captureInfrared`, `readerID`（覆寫型號預設） |

- **設備**：`deviceId` 必須為類型「門禁設備」且 `config` 含 `host`、`username`、`password`。
- **型號差異**：截圖的 `dataType` 等由 `device_models.config.isapi.captureFaceData` 讀取；前端新增 AC-02／AC-07 型號時可設定該 config。
- **實作檔案**：`src/utils/deviceHelpers.js`（驗證）、`src/services/accessControl/isapiClient.js`（Digest 客戶端）、`src/services/accessControl/accessControlService.js`（五支 ISAPI）、`src/routes/accessControlRoutes.js`。
- **Postman 測試**：見 [POSTMAN_ACCESS_CONTROL_TESTING.md](./POSTMAN_ACCESS_CONTROL_TESTING.md)。
