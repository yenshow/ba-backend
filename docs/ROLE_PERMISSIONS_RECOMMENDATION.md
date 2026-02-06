# BA 系統 - 三種用戶角色權限定義與建議

本文檔分析目前系統所有模組的使用情境，提出 admin、operator、viewer 三種角色的權限定義與實作建議。

---

## 一、系統模組與 API 現況分析

### 1.1 模組總覽

| 模組 | 路由前綴 | 功能摘要 | 操作類型 |
|------|----------|----------|----------|
| 用戶 | `/api/users` | 註冊、登入、個人資料、用戶管理 | 帳號/權限管理 |
| 設備 | `/api/devices` | 設備類型、型號、設備 CRUD | 基礎設施 |
| Modbus | `/api/modbus` | 讀寫 Modbus 暫存器 | 設備控制 |
| RTSP | `/api/rtsp` | 串流啟動/停止/狀態 | 設備控制 |
| 地點 | `/api/locations` | 區域、地點 CRUD | 場域配置 |
| 環境 | `/api/environment` | 環境區域、感測器讀數、錯誤追蹤 | 環境監控 |
| 照明 | `/api/lighting` | 照明區域、錯誤追蹤 | 照明監控 |
| 人流 | `/api/people-counting` | 工地、地點、統計、進出紀錄 | 人流統計 |
| 警報 | `/api/alerts` | 警報查詢、忽略、未解決 | 警報管理 |
| 系統設定 | `/api/settings` | 鍵值設定、檔案上傳 | 系統配置 |
| 外部資料 | `/api/external-data` | CMS 等外部資料查詢 | 資料查詢 |
| YSCP | `/api/yscp` | 事件接收、人員/車輛查詢 | 整合介面 |

### 1.2 目前權限現況（問題整理）

| 問題 | 說明 |
|------|------|
| **operator 未區分** | `operator` 與 `viewer` 目前權限相同，`requireAdminOrOperator` 未使用 |
| **viewer 可寫入** | 照目前設計，viewer 登入後可建立/更新/刪除 zones、locations、照明、環境、人流地點等，與「僅檢視」不符 |
| **公開 API 過多** | 設備查詢、警報查詢、Modbus、RTSP 皆無認證，任何人可存取 |
| **寫入權限過於寬鬆** | 區域/地點/照明/環境 CRUD 僅需 `authenticate`，未區分 admin/operator/viewer |

---

## 二、三種角色權限建議定義

### 2.1 角色定位

| 角色 | 定位 | 典型使用情境 |
|------|------|--------------|
| **admin** | 系統管理員 | 帳號管理、設備與類型維護、系統設定、警報處理決策 |
| **operator** | 操作員 | 日常運維：區域/地點配置、Modbus 寫入、串流控制、警報日常處理 |
| **viewer** | 檢視者 | 監看儀表板、查詢報表、不可修改任何業務資料 |

### 2.2 權限矩陣（建議）

#### 用戶與帳號

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 註冊 | - | - | - |
| 登入 | ✓ | ✓ | ✓ |
| 取得當前用戶 (GET /me) | ✓ | ✓ | ✓ |
| 修改自己 username/email | ✓ | ✓ | ✓ |
| 修改自己密碼 | ✓ | ✓ | ✓ |
| 取得用戶列表 | ✓ | ✗ | ✗ |
| 取得單一用戶 | ✓ | ✗ | ✗ |
| 修改他人（含 role/status） | ✓ | ✗ | ✗ |
| 刪除用戶 | ✓ | ✗ | ✗ |

#### 設備與 Modbus

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 查詢設備/類型/型號 | ✓ | ✓ | ✓ |
| 建立/更新/刪除設備類型 | ✓ | ✗ | ✗ |
| 建立/更新/刪除設備型號 | ✓ | ✗ | ✗ |
| 建立/更新/刪除設備 | ✓ | ✓* | ✗ |
| Modbus 讀取 | ✓ | ✓ | ✓ |
| Modbus 寫入 | ✓ | ✓ | ✗ |

\* 可依需求調整：設備 CRUD 僅 admin，或 operator 可建立/更新（不刪除）。

#### RTSP 串流

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 啟動串流 | ✓ | ✓ | ✗ |
| 停止串流 | ✓ | ✓ | ✗ |
| 查詢串流狀態 | ✓ | ✓ | ✓ |

#### 區域與地點

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 查詢 zones/locations | ✓ | ✓ | ✓ |
| 建立/更新/刪除 zones | ✓ | ✓ | ✗ |
| 建立/更新/刪除 locations | ✓ | ✓ | ✗ |
| 環境/照明區域 CRUD | ✓ | ✓ | ✗ |
| 人流地點 CRUD | ✓ | ✓ | ✗ |

#### 警報

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 查詢警報/規則/未解決數量 | ✓ | ✓ | ✓ |
| 標記為未解決 | ✓ | ✓* | ✗ |
| 忽視警報 | ✓ | ✓* | ✗ |
| 取消忽視 | ✓ | ✓* | ✗ |

\* 可依需求調整：警報操作僅 admin，或 operator 可進行日常忽略/恢復。

#### 系統設定

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 取得設定 | ✓ | ✓ | ✓ |
| 建立/更新/刪除設定 | ✓ | ✗ | ✗ |
| 上傳設定檔案 | ✓ | ✗ | ✗ |

#### 外部資料與 YSCP

| 功能 | admin | operator | viewer |
|------|:-----:|:--------:|:------:|
| 查詢外部資料 | ✓ | ✓ | ✓ |
| YSCP 人員/車輛查詢 | ✓ | ✓ | ✓ |
| YSCP 事件接收 (webhook) | 公開（外部系統推送） | 公開 | 公開 |

---

## 三、實作建議

### 3.1 新增中間件

在 `authMiddleware.js` 中補充：

```javascript
// 檢查是否為操作員以上（admin 或 operator）
function requireOperator(req, res, next) {
  return authorize("admin", "operator")(req, res, next);
}

// 檢查是否為檢視者以上（任何已登入用戶）
// 使用現有 authenticate 即可
```

`requireAdminOrOperator` 可保留並作為 `requireOperator` 的別名，或統一改用 `requireOperator`。

### 3.2 路由權限調整建議

#### 需要新增 `requireOperator` 的寫入類 API

| 路由 | 目前 | 建議 |
|------|------|------|
| `POST/PUT/DELETE /api/locations/zones` | authenticate | authenticate + requireOperator |
| `POST/PUT/DELETE /api/locations` | authenticate | authenticate + requireOperator |
| `POST/PUT/DELETE /api/environment/zones` | authenticate | authenticate + requireOperator |
| `POST/PUT/DELETE /api/lighting/zones` | authenticate | authenticate + requireOperator |
| `POST/PUT/DELETE /api/people-counting/locations` | authenticate | authenticate + requireOperator |
| `POST/PUT /api/devices`（建立/更新設備） | authenticate + requireAdmin | authenticate + requireOperator |
| `PUT /api/alerts/:id/unresolve` | authenticate + requireAdmin | authenticate + requireOperator |
| `POST /api/alerts/:deviceId/:alertType/ignore` | authenticate + requireAdmin | authenticate + requireOperator |
| `POST /api/alerts/:deviceId/:alertType/unignore` | authenticate + requireAdmin | authenticate + requireOperator |

#### 需要限制 viewer 不可寫入的 API

| 路由 | 建議 |
|------|------|
| `PUT /api/modbus/coils` | authenticate + requireOperator |
| `POST /api/rtsp/start` | authenticate + requireOperator |
| `POST /api/rtsp/stop/:streamId` | authenticate + requireOperator |

#### 維持 admin only 的 API

- 用戶列表/取得/刪除
- 設備類型、型號 CRUD（或改為 operator 可更新，依需求）
- 設備刪除（若設備 CRUD 開放給 operator）
- 系統設定建立/更新/刪除/上傳

#### 公開 vs 需認證

| API | 目前 | 建議 | 說明 |
|-----|------|------|------|
| 設備查詢 | 公開 | authenticate | 避免未授權存取設備清單 |
| 警報查詢 | 公開 | authenticate | 避免未授權存取警報內容 |
| Modbus 讀取 | 公開 | authenticate | 避免未授權讀取設備資料 |
| YSCP event-receiver | 公開 | 維持公開 | 外部系統 webhook，無法帶 Token |
| 環境/照明 錯誤記錄/清除 | 公開 | 維持公開或改為內部呼叫 | 多為監控服務呼叫 |

### 3.3 userService 調整

- `updateUser`：已有限制，僅 admin 可改 role/status，無需變更。
- 若未來需要 operator 可查看用戶列表（不可修改），可新增 `requireAdminOrOperator` 於 GET `/api/users`，並在 service 層依角色決定回傳欄位（如 operator 不顯示 email 等敏感資訊）。

### 3.4 實作順序建議

1. **Phase 1**：區分 viewer 與 operator  
   - 為 zones/locations/環境/照明/人流 的寫入 API 加上 `requireOperator`  
   - viewer 將無法建立/更新/刪除，僅能讀取  

2. **Phase 2**：Modbus、RTSP 加認證  
   - Modbus 全部、RTSP 全部加上 `authenticate`  
   - Modbus 寫入、RTSP 啟動/停止 加上 `requireOperator`  

3. **Phase 3**：設備與警報  
   - 視需求決定設備 CRUD 是否開放給 operator  
   - 警報忽略/未解決 改為 `requireOperator` 或維持 `requireAdmin`  

4. **Phase 4**：查詢類 API 加認證  
   - 設備查詢、警報查詢 改為需 `authenticate`  
   - 評估環境讀數、錯誤記錄等是否改為內部呼叫或加認證  

---

## 四、前端配合事項

1. **依角色顯示/隱藏 UI**  
   - 登入後從 `GET /me` 取得 `role`，用於控制按鈕、選單可見性  
   - viewer：隱藏「新增/編輯/刪除」按鈕  

2. **錯誤處理**  
   - 403 時顯示「權限不足」並導向適當頁面  

3. **路由守衛**  
   - 依角色限制可訪問的頁面，避免 viewer 直接輸入 URL 進入管理頁面  

---

## 五、總結

| 項目 | 建議 |
|------|------|
| **viewer** | 純讀取，僅可修改自己的帳戶資料 |
| **operator** | 讀取 + 日常運維寫入（區域/地點/設備/警報處理/Modbus/RTSP） |
| **admin** | 完整權限（含用戶管理、系統設定、設備類型型號） |
| **公開 API** | 僅保留註冊、登入、YSCP webhook；其餘查詢與控制建議改為需認證 |
| **實作** | 分階段進行，先完成 Phase 1 區分 viewer/operator，再逐步收緊公開 API 與 Modbus/RTSP |
