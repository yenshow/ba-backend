# 門禁設備與設備系統設計文檔

## 一、目前設備系統設計摘要

### 1.1 資料模型關係

```
device_types (設備類型)
    │
    ├── 一對多 ──► device_models (設備型號)
    │                  │
    │                  └── 每個型號可有 type_id、config (型號專用設定)
    │
    └── 一對多 ──► devices (實體設備)
                       │
                       ├── type_id → 所屬設備類型
                       ├── model_id → 所屬設備型號（可選，LEFT JOIN）
                       └── config → 單一設備的連線/參數設定（依類型驗證）
```

- **設備類型 (device_types)**：抽象分類，例如攝影機、感測器、控制器。欄位：`id`, `name`, `code`, `description`。  
  **目前預設類型**：`camera`、`sensor`、`controller`、`tablet`、`network`。  
  **尚無**「門禁設備」類型。

- **設備型號 (device_models)**：隸屬於某一設備類型，代表「某一款產品」的規格。欄位：`id`, `name`, `type_id`, `port`, `description`, `config`(JSONB)。  
  - `config` 依類型有不同用途（例如感測器類型存 `sensorParameters`、`logging`）。  
  - 門禁設備可在此存放 **依型號而異的 ISAPI 參數**（例如 CaptureFaceData 的 `dataType`：binary / url）。

- **實體設備 (devices)**：實際的一台設備，必屬某類型、可選屬某型號。欄位：`id`, `name`, `model_id`, `type_id`, `location`, `description`, `status`, `config`(JSONB) 等。  
  - `config` 由 `deviceHelpers.validateDeviceConfig(config, typeCode)` 依 **類型** 驗證（如 controller 要 host/port、camera 要 ip_address、network 要 device_type）。

### 1.2 設計要點

| 層級 | 用途 |
|------|------|
| **設備類型** | 決定「這種設備」的 config 驗證規則與業務邏輯（如是否走 ISAPI、Modbus）。 |
| **設備型號** | 同一類型下不同型號的差異（如 AC-02 與 AC-07 的 API 參數差異），可放在 `device_models.config`。 |
| **實體設備** | 單一設備的連線資訊與營運參數（IP、port、Digest 帳密等），放在 `devices.config`。 |

因此：**是否要支援門禁設備** → 應新增「門禁設備」**設備類型**；**不同型號的 ISAPI 差異** → 應由**設備型號**與其 `config` 表達，並在呼叫 ISAPI 時依設備的 `model_id` 取得對應參數。

---

## 二、建議：新增「門禁設備」設備類型

### 2.1 新增類型

在 `device_types` 中新增一筆：

| name     | code            | description |
|----------|-----------------|-------------|
| 門禁設備 | `access_control` | ISAPI 門禁／人臉設備（如 Hikvision），使用 Digest Auth 通訊 |

- **code** 建議固定為 `access_control`，以便程式依 `type_code === 'access_control'` 走 ISAPI 與 Digest Auth 流程。
- 實作方式可與現有類型一致：在 DB 新增一筆（或透過既有「新增設備類型」API），並在 `deviceHelpers.validateDeviceConfig` 中為 `access_control` 新增 case。

### 2.2 門禁設備的 devices.config 建議欄位

單一門禁設備的連線與認證資訊建議放在 **devices.config**，並依類型驗證，例如：

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `type` | string | 是 | 固定 `"access_control"`（與 type_code 一致，供驗證用） |
| `base_url` 或 `host` + `port` | string / number | 是 | 設備 Base URL（如 `http://192.168.2.31:80`）或 host + port |
| `username` | string | 是 | Digest Auth 使用者名稱 |
| `password` | string | 是 | Digest Auth 密碼（儲存與傳輸需依安全規範處理） |

其餘欄位（如 `readerID` 預設值）可選，或由型號預設覆寫。

---

## 三、不同型號的 ISAPI 差異設計（以 CaptureFaceData 為例）

### 3.1 問題說明

同一 ISAPI 介面在不同型號上參數可能不同，例如：

- **CaptureFaceData**（呼叫設備截圖）  
  - **AC-02**：`dataType` = `binary`  
  - **AC-07**：`dataType` = `url`  

若只寫死單一 payload，會導致部分設備行為錯誤，因此需**依型號**決定請求內容。

### 3.2 建議：型號層級存放 ISAPI 參數

將「依型號而異」的 ISAPI 參數放在 **device_models.config**，不放在設備類型或單一設備。理由：

- 同一類型下可有多個型號（AC-02、AC-07、未來其他機種）。
- 實體設備透過 `model_id` 關聯到型號，呼叫 ISAPI 時可先取 `device.model_id` → `device_models.config`，再組裝請求。

### 3.3 device_models.config 建議結構（門禁類型）

門禁類型（`type_id` 對應 `access_control`）的型號，可在 `config` 中定義 ISAPI 專用區塊，例如：

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

- **AC-02** 型號：`dataType` 設為 `"binary"`。  
- **AC-07** 型號：`dataType` 設為 `"url"`。  

後端在發送 `POST /ISAPI/AccessControl/CaptureFaceData` 時：

1. 取得設備的 `model_id`。
2. 若存在，從 `device_models.config.isapi.captureFaceData` 讀取參數（若無則使用系統預設）。
3. 組裝 XML Body（如 `<dataType>url</dataType>` 或 `<dataType>binary</dataType>`），再發送請求。

其他 ISAPI 若有依型號差異的參數，也可在 `config.isapi` 下擴充，例如：

```json
{
  "isapi": {
    "captureFaceData": { "dataType": "url", "captureInfrared": true, "readerID": 1 },
    "userInfoSearch": { "maxResults": 50 }
  }
}
```

---

## 四、新增設備類型 / 型號 / 設備的流程

### 4.1 新增「門禁設備」類型（一次性）

- **方式一**：在 DB 初始化或 migration 中對 `device_types` 執行 INSERT（與現有 camera、sensor 等一致）。  
- **方式二**：透過既有 API「新增設備類型」寫入一筆  
  - name：`門禁設備`  
  - code：`access_control`  
  - description：自訂。

之後在 `validateDeviceConfig` 與 ISAPI 服務中，對 `type_code === 'access_control'` 做分支處理。

### 4.2 新增門禁「設備型號」（例如 AC-02、AC-07）

- 使用既有「新增設備型號」API（或直接寫入 `device_models`）。
- 必填：`name`（如 "AC-02"、"AC-07"）、`type_id`（門禁設備類型的 id）。
- `config` 填寫該型號的 ISAPI 參數，例如：
  - AC-02：`{ "isapi": { "captureFaceData": { "dataType": "binary", "captureInfrared": true, "readerID": 1 } } }`
  - AC-07：`{ "isapi": { "captureFaceData": { "dataType": "url", "captureInfrared": true, "readerID": 1 } } }`

若系統有「型號代碼」需求，可在 `config` 中加 `modelCode: "AC-02"` 方便識別，或未來在 `device_models` 加欄位。

### 4.3 新增「門禁實體設備」

- 使用既有「新增設備」API（或寫入 `devices`）。
- 必填：`name`、`type_id`（門禁類型）、`model_id`（對應 AC-02 或 AC-07 等）、`config`。
- `config` 須通過 `validateDeviceConfig(config, 'access_control')`，至少包含：
  - 連線資訊：`base_url` 或 `host`+`port`
  - Digest Auth：`username`、`password`
  - `type: "access_control"`

建立後，該設備即具備類型=門禁、型號=某型號；呼叫 ISAPI 時可依 `model_id` 讀取對應型號的 `config.isapi` 組裝請求。

---

## 五、流程總覽

```
1. 新增設備類型「門禁設備」(code: access_control)
        │
2. 新增設備型號（AC-02、AC-07…），每個型號的 config 內含 isapi.captureFaceData 等參數
        │
3. 新增實體設備：選擇類型=門禁、型號=AC-02 或 AC-07，並填 base_url、username、password
        │
4. 呼叫 ISAPI 時：
   - 從 device 取得 type_id / model_id、config（連線與帳密）
   - 若 model_id 存在，從 device_models.config 取得 isapi.* 參數
   - 依型號參數組裝請求（如 CaptureFaceData 的 dataType）
   - 使用 Digest Auth 發送請求
```

---

## 六、與既有文檔的對應

- **ISAPI 介面規格**（方法、路徑、認證、通用 Body 結構）：見 [ISAPI_DEVICE_REQUEST_SERVICES.md](./ISAPI_DEVICE_REQUEST_SERVICES.md)。
- **依型號的參數差異**（如 CaptureFaceData 的 dataType）：以本文件的「設備型號 + config.isapi」設計實作，並在 ISAPI 文檔中註明「依設備型號可能不同，以 device_models.config 為準」。

---

## 七、總結

| 項目 | 結論 |
|------|------|
| 是否新增門禁設備類型？ | **是**，建議新增設備類型「門禁設備」、code `access_control`。 |
| 不同型號的 ISAPI 差異如何處理？ | 在 **設備型號** 的 `device_models.config` 中定義 `isapi.*`（如 `captureFaceData.dataType`），呼叫時依設備的 `model_id` 讀取。 |
| 如何新增設備？ | 沿用現有「設備類型 → 設備型號 → 實體設備」流程：先有門禁類型與各型號，再新增門禁設備並選擇型號、填寫 config（base_url、username、password）。 |

此設計可讓同一套 ISAPI 服務支援多種門禁型號，且新增型號時只需新增 `device_models` 與對應 `config`，無須改動設備類型或既有設備資料結構。
