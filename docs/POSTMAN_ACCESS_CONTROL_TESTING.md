# 門禁設備 API — Postman 測試說明

## 前置條件

1. **後端已啟動**：`npm run dev` 或 `npm start`，預設 `http://localhost:3000`（依 `config.server.port`）。
2. **資料庫已初始化**：`npm run db:init`，且至少有一筆「門禁設備」類型 + 對應型號 + 一筆門禁設備（config 含 `host`、`username`、`password`）。
3. **取得 JWT**：所有門禁 API 需在 Header 帶 `Authorization: Bearer <token>`；修改／刪除／上傳人臉／截圖需管理員或操作員帳號。

---

## 步驟一：取得 Token

**POST** `http://localhost:3000/api/users/login`

- **Body**（raw JSON）：

```json
{
  "username": "admin",
  "password": "你的密碼"
}
```

- 回應中的 `token` 複製起來，後續每個請求在 **Headers** 加上：
  - Key：`Authorization`
  - Value：`Bearer <貼上 token>`

---

## 步驟二：查出門禁設備 ID

**GET** `http://localhost:3000/api/devices?type_code=access_control`

- Header：`Authorization: Bearer <token>`
- 從回應的 `devices` 陣列中任選一筆，記下 `id`，作為後續的 `deviceId`（例如 `5`）。

---

## 步驟三：門禁 API 測試

以下將 `deviceId` 替換為實際 ID，Base URL 依你的環境替換（例如 `http://localhost:3000`）。

### 1. 取得人員列表

- **Method**：`POST`
- **URL**：`{{baseUrl}}/api/access-control/devices/{{deviceId}}/user-info`
- **Headers**：`Authorization: Bearer <token>`、`Content-Type: application/json`
- **Body**（raw JSON，可選）：

```json
{
  "searchResultPosition": 0,
  "maxResults": 50
}
```

- 成功時回傳 `list`、`totalMatches`、`numOfMatches`。

---

### 2. 修改單一人員資料

- **Method**：`PUT`
- **URL**：`{{baseUrl}}/api/access-control/devices/{{deviceId}}/user-info`
- **Headers**：`Authorization: Bearer <token>`、`Content-Type: application/json`
- **Body**（raw JSON）：

```json
{
  "UserInfo": {
    "employeeNo": "123456",
    "name": "測試人員",
    "userType": "normal",
    "Valid": {
      "enable": true,
      "beginTime": "2022-08-02T08:54:39",
      "endTime": "2032-08-02T08:54:39"
    },
    "doorRight": "1",
    "RightPlan": [{ "doorNo": 1, "planTemplateNo": "1" }],
    "userVerifyMode": "faceOrFpOrCardOrPw",
    "password": "123456"
  }
}
```

- 也可直接傳 `UserInfo` 內容不包一層 `UserInfo`（後端會接受 `req.body.UserInfo || req.body`）。

---

### 3. 刪除人員

- **Method**：`DELETE`
- **URL**：`{{baseUrl}}/api/access-control/devices/{{deviceId}}/user-info`
- **Headers**：`Authorization: Bearer <token>`、`Content-Type: application/json`
- **Body**（二擇一）：

刪除單筆：

```json
{
  "employeeNo": "123456"
}
```

刪除多筆：

```json
{
  "employeeNoList": ["123456", "123457"]
}
```

---

### 4. 上傳人臉圖（修改人臉配對）

- **Method**：`PUT`
- **URL**：`{{baseUrl}}/api/access-control/devices/{{deviceId}}/user-info/{{employeeNo}}/face`
- **Headers**：`Authorization: Bearer <token>`（**不要**設 Content-Type，由 Postman 自動帶 multipart boundary）
- **Body**：選 **form-data**
  - Key：`img`，Type：**File**，Value：選一張人臉圖片（JPEG/PNG，建議 < 5MB）
  - 可選 Key：`faceLibType`（Text）、`FDID`（Text）、`faceType`（Text）

例如 `employeeNo` 為 `123456` 時，URL 為：  
`http://localhost:3000/api/access-control/devices/5/user-info/123456/face`

---

### 5. 呼叫設備截圖（捕獲人臉資料）

- **Method**：`POST`
- **URL**：`{{baseUrl}}/api/access-control/devices/{{deviceId}}/capture-face`
- **Headers**：`Authorization: Bearer <token>`、`Content-Type: application/json`
- **Body**（raw JSON，可選，用於覆寫型號預設）：

```json
{
  "dataType": "url",
  "captureInfrared": true,
  "readerID": 1
}
```

- 成功時回傳內容依設備與 `dataType`（如 XML 字串或 binary）而異。

---

## Postman 環境變數建議

在 Postman 建立 Environment，設定：

| 變數名     | 範例值                  | 說明                    |
| ---------- | ----------------------- | ----------------------- |
| `baseUrl`  | `http://localhost:3000` | 後端 Base URL           |
| `token`    | （登入後貼上）          | JWT，用於 Authorization |
| `deviceId` | `5`                     | 門禁設備 ID             |

- URL 填：`{{baseUrl}}/api/access-control/devices/{{deviceId}}/user-info`
- Authorization 選 Bearer Token，Value 填 `{{token}}`

---

## 常見錯誤

| 狀態碼          | 可能原因                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------- |
| 401             | 未帶 Token 或 Token 過期，重新登入取得 token                                              |
| 403             | 帳號非 admin/operator，刪除／修改／上傳／截圖需管理員或操作員                             |
| 400             | 該設備不是門禁設備、config 缺少 host/username/password、或 Body 缺少必填（如 employeeNo） |
| 404             | 設備不存在，檢查 deviceId 是否正確                                                        |
| 503 或 連線錯誤 | 門禁設備離線或 host/port 錯誤，檢查 devices.config 與設備網路                             |
