# ISAPI 設備請求服務文檔

## 概述

本文件描述後端與 ISAPI 設備通訊的 API 規格，所有請求皆使用 **Digest Auth** 進行認證。適用於門禁／人臉設備（如 Hikvision 等支援 ISAPI 的裝置）。

**設備與型號差異**：不同門禁型號（如 AC-02、AC-07）在部分 API 的請求參數上可能略有差異（例如 CaptureFaceData 的 `dataType`：binary vs url）。此類「依型號而異」的參數應由設備系統的**設備型號 (device_models)** 與其 `config` 定義，實作時依設備的 `model_id` 讀取。整體設計請見 [門禁設備與設備系統設計文檔](./ACCESS_CONTROL_DEVICE_ARCHITECTURE.md)。

## 認證方式

- **類型**：Digest Auth（摘要認證）
- **說明**：發送請求時由客戶端依伺服器回傳的 challenge 自動計算並帶上 `Authorization` 標頭，無需在文檔中寫死帳密。
- **實作注意**：需使用支援 Digest 的 HTTP 客戶端（如 `axios` 搭配 `http-digest-client` 或內建 digest 的庫），並設定 `username`、`password`。

---

## 1. 獲取所有人員資料

取得設備上所有人員（UserInfo）列表，建議只解析並儲存所需欄位。

| 項目 | 說明 |
|------|------|
| **方法** | `POST` |
| **路徑** | `/ISAPI/AccessControl/UserInfo/Search?format=json` |
| **Content-Type** | `application/json` |
| **認證** | Digest Auth |

### 請求 Body（搜尋條件）

```json
{
  "UserInfoSearchCond": {
    "searchID": "1",
    "searchResultPosition": 0,
    "maxResults": 50
  }
}
```

- `searchID`：搜尋任務 ID，可自訂字串。
- `searchResultPosition`：從第幾筆開始（0 表示從頭）。
- `maxResults`：單次最多回傳筆數（可依需求調整，如 50、100）。

### 回應結構（節錄）

```json
{
  "UserInfoSearch": {
    "searchID": "1",
    "responseStatusStrg": "OK",
    "numOfMatches": 14,
    "totalMatches": 14,
    "UserInfo": [
      {
        "employeeNo": "2216",
        "name": "Lynn",
        "userType": "normal",
        "Valid": {
          "enable": true,
          "beginTime": "2025-06-02T11:22:29",
          "endTime": "2035-06-02T23:59:59",
          "timeType": "local"
        },
        "doorRight": "1",
        "RightPlan": [
          {
            "doorNo": 1,
            "planTemplateNo": "1"
          }
        ],
        "faceURL": "http://192.168.2.31:80/LOCALS/pic/enrlFace/0/0000000010.jpg@WEB000000000096"
      }
    ]
  }
}
```

### 建議抓取欄位（對應圖二）

僅保留以下欄位即可，其餘可捨棄：

| 欄位 | 說明 |
|------|------|
| `employeeNo` | 員工編號 |
| `name` | 姓名 |
| `userType` | 用戶類型（如 normal） |
| `Valid.enable` | 是否啟用 |
| `Valid.beginTime` | 有效開始時間 |
| `Valid.endTime` | 有效結束時間 |
| `doorRight` | 門權限（字串，如 "1"） |
| `RightPlan` | 權限計畫陣列 |
| `RightPlan[].doorNo` | 門號 |
| `RightPlan[].planTemplateNo` | 計畫範本編號 |
| `faceURL` | 人臉照 URL |

---

## 2. 修改單一人員資料

新增或更新設備上單一筆人員資料。

| 項目 | 說明 |
|------|------|
| **方法** | `PUT` |
| **路徑** | `/ISAPI/AccessControl/UserInfo/SetUp?format=json` |
| **Content-Type** | `application/json` |
| **認證** | Digest Auth |

### 請求 Body 範例（對應圖三）

```json
{
  "UserInfo": {
    "employeeNo": "123456",
    "name": "test",
    "userType": "normal",
    "Valid": {
      "enable": true,
      "beginTime": "2022-08-02T08:54:39",
      "endTime": "2032-08-02T08:54:39"
    },
    "doorRight": "1",
    "RightPlan": [
      {
        "doorNo": 1,
        "planTemplateNo": "1"
      }
    ],
    "userVerifyMode": "faceOrFpOrCardOrPw",
    "password": "123456"
  }
}
```

---

## 3. 刪除單一人員資料

依員工編號刪除設備上單一筆人員資料。

| 項目 | 說明 |
|------|------|
| **方法** | `PUT` |
| **路徑** | `/ISAPI/AccessControl/UserInfoDetail/Delete?format=json` |
| **Content-Type** | `application/json` |
| **認證** | Digest Auth |

### 請求 Body 範例（對應圖四）

```json
{
  "UserInfoDetail": {
    "mode": "byEmployeeNo",
    "EmployeeNoList": [
      {
        "employeeNo": "123456"
      }
    ]
  }
}
```

- `mode`：`"byEmployeeNo"` 表示依員工編號刪除。
- `EmployeeNoList`：要刪除的員工編號清單，可多筆。

---

## 4. 修改單一人臉配對

上傳或更新單一人員的人臉圖片至設備人臉庫。

| 項目 | 說明 |
|------|------|
| **方法** | `PUT` |
| **路徑** | `/ISAPI/Intelligent/FDLib/FDSetUp?format=json` |
| **Content-Type** | `multipart/form-data`（form-data） |
| **認證** | Digest Auth |

### 請求 Body（form-data，對應圖五）

| Key | 類型 | 說明 |
|-----|------|------|
| `faceURL` | Text (JSON 字串) | 人臉庫與人員對應設定 |
| `img` | File | 人臉圖片檔案 |

**faceURL 範例（JSON 字串）：**

```json
{
  "faceLibType": "blackFD",
  "FDID": "1",
  "FPID": "人員編號",
  "faceType": "normalFace"
}
```

- `faceLibType`：人臉庫類型（如 `blackFD`）。
- `FDID`：人臉庫 ID。
- `FPID`：人員編號（與 UserInfo 的 `employeeNo` 對應）。
- `faceType`：人臉類型（如 `normalFace`）。

**img**：選擇實際的人臉圖片檔案上傳。

---

## 5. 呼叫設備截圖（捕獲人臉資料）

觸發設備即時捕獲人臉資料（截圖），用於現場採集人臉。

| 項目 | 說明 |
|------|------|
| **方法** | `POST` |
| **路徑** | `/ISAPI/AccessControl/CaptureFaceData` |
| **Content-Type** | `application/xml` 或 `text/xml` |
| **認證** | Digest Auth |

### 請求 Body（XML，對應圖六）

**依設備型號不同，`dataType` 可能為 `url` 或 `binary`**，實作時應從設備型號的 `config.isapi.captureFaceData` 讀取（見 [門禁設備與設備系統設計文檔](./ACCESS_CONTROL_DEVICE_ARCHITECTURE.md)）。

**範例一（AC-07，回傳 URL）：**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CaptureFaceDataCond xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <captureInfrared>true</captureInfrared>
  <dataType>url</dataType>
  <readerID>1</readerID>
</CaptureFaceDataCond>
```

**範例二（AC-02，回傳二進位）：**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CaptureFaceDataCond xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <captureInfrared>true</captureInfrared>
  <dataType>binary</dataType>
  <readerID>1</readerID>
</CaptureFaceDataCond>
```

- `captureInfrared`：是否啟用紅外捕獲（true/false）。
- `dataType`：**依型號**—`url`（回傳圖片 URL）或 `binary`（回傳二進位資料），需依設備型號設定。
- `readerID`：讀取器 ID（依設備設定）。

---

## 附錄：API 總覽

| 功能 | 方法 | 路徑 | Body 類型 |
|------|------|------|-----------|
| 獲取所有人員資料 | POST | `/ISAPI/AccessControl/UserInfo/Search?format=json` | JSON |
| 修改單一人員資料 | PUT | `/ISAPI/AccessControl/UserInfo/SetUp?format=json` | JSON |
| 刪除單一人員資料 | PUT | `/ISAPI/AccessControl/UserInfoDetail/Delete?format=json` | JSON |
| 修改單一人臉配對 | PUT | `/ISAPI/Intelligent/FDLib/FDSetUp?format=json` | form-data |
| 呼叫設備截圖 | POST | `/ISAPI/AccessControl/CaptureFaceData` | XML |

**Base URL**：依實際設備設定，例如 `http://192.168.2.31:80` 或 `http://192.168.2.34:80`。

---

## 附錄 B：依設備型號的參數差異（摘要）

| API | 參數 | AC-02 | AC-07 | 說明 |
|-----|------|-------|-------|------|
| CaptureFaceData | `dataType` | `binary` | `url` | 回傳格式不同，需依型號組裝 XML。 |

其餘 ISAPI 若也有型號差異，應在 [門禁設備與設備系統設計文檔](./ACCESS_CONTROL_DEVICE_ARCHITECTURE.md) 與本表同步補充，並在實作時從 `device_models.config.isapi` 讀取。
