# BA 系統 - 登入、用戶權限與授權（精簡總結）

一份文檔涵蓋：**① 登入**、**② 用戶權限（admin/operator/viewer）**、**③ 系統授權（授權碼）**。實作順序：**登入 → 角色權限 → 系統授權**。

---

## 1. 登入

### 設計原則

- **未登入**：僅可訪問登入頁；其餘路由需認證，否則導向 `/login?redirect=原路徑`。
- **已登入**：所有 API 請求帶 `Authorization: Bearer <token>`；401 時前端登出並導回登入頁。

### 前端實作（已完成）

| 項目 | 實作 |
|------|------|
| 公開路由 | 僅 `/login`（`app/middleware/auth.global.ts`） |
| 登入後跳轉 | `login.vue` 依 `route.query.redirect` 或 `/` |
| API 帶 Token | `useApiBase()` 從 cookie `auth_token` 帶入 Header |
| 401 處理 | `useApiBase` 內 `logout()` + `navigateTo('/login', { query: { redirect } })` |

### 後端實作（已完成）

| 項目 | 實作 |
|------|------|
| 公開 API | `POST /api/users/register`、`POST /api/users/login`、`POST /api/yscp/event-receiver`、`GET /api/yscp/health` |
| 其餘 API | 皆加 `authenticate`（設備、警報、Modbus、地點、環境、照明、人流等已改為 `router.use(authenticate)` 或各路由 `authenticate`） |

---

## 2. 用戶權限（admin / operator / viewer）

### 角色定義

| 角色 | 說明 |
|------|------|
| **admin** | 系統管理員：用戶管理、設備類型/型號、系統設定、授權。 |
| **operator** | 操作員：日常運維寫入（區域/地點/環境/照明/人流、設備 CRUD、警報忽略、Modbus 寫入等）。 |
| **viewer** | 檢視者：僅檢視，不可新增/編輯/刪除；可改自己帳戶與密碼。 |

### 後端

- **requireAdmin**：用戶管理、設備類型/型號、系統設定寫入。
- **requireOperator**（或 requireAdminOrOperator）：寫入類 API（zones、locations、設備 CRUD、警報操作、Modbus 寫入等）。  
- 查詢類多為 `authenticate` 即可。

### 前端（已完成）

- **判斷「可編輯」**：使用 `isOperator`（`useAuth()`），即 admin 或 operator。
- **判斷「僅檢視」**：`user?.role === "viewer"`（勿用 `isViewer`，其定義含 operator）。
- **viewer 隱藏**：  
  - 下方導覽列：**不顯示「更多功能」**（設備管理、全區點位圖、人員管理）。  
  - 首頁：跑馬燈、專案圖片、首頁影片的「編輯」按鈕與對話框（`SafetyBanner`、`HomeHeader`、`HomeVideoPlayer`）。  
  - 環境／人流／車輛：「地點管理」按鈕與 `ZoneManagementDialog`。  
  - 照明：「樓層管理」「編輯定位」、右側狀態中心開關（`StatusCenter` 的 `canToggle`）。  
  - 設備管理、警示紀錄、全區點位圖、人員管理：管理/編輯/刪除/忽視等按鈕皆以 `isOperator` 控制，viewer 看不到。

---

## 3. 系統授權（授權碼解鎖模組）

### 目的

客戶可能只購買部分模組；以**授權碼**解鎖，未授權模組前端不顯示或不可用，後端回傳 403（如 `FEATURE_NOT_LICENSED`）。

### 設計要點（尚未實作）

| 項目 | 說明 |
|------|------|
| 授權維度 | 以 **Feature Key** 對應系統（與前端 `system-modules` 對齊），如 `core`、`environment`、`people_counting`、`lighting`、`access_control` 等。 |
| 後端 | 儲存已啟用 features、到期日；**GET /api/license**（回傳狀態）、**POST /api/license/activate**（admin 輸入授權碼）；路由加 **requireFeature("key")**（在 authenticate／角色之後）。 |
| 前端 | 登入後取 GET /api/license，以 `features` 過濾導航與頁面；僅 admin 可輸入授權碼；403 且為未授權時提示並導向授權頁。 |
| 檢查順序 | authenticate → 角色（requireAdmin/requireOperator）→ requireFeature。 |

授權碼驗證（離線簽章或線上授權伺服器）於實作階段再訂。

### Feature Key 與前端對照（建議）

與前端的 `app/config/system-modules.ts` 及路由對齊，一個 feature 可對應一個或多個模組：

| Feature Key | 說明 | 前端路由／模組 | 後端 API 前綴 |
|-------------|------|----------------|---------------|
| `core` | 核心（設備、使用者、警示、全區點位圖、人員管理） | `/core/*` | `/api/devices`、`/api/users`、`/api/alerts`、`/api/locations`（zones）、`/api/personnel` |
| `environment` | 環境品質 | `/construction-monitoring/environment` | `/api/environment` |
| `people_counting` | 人流統計 | `/construction-monitoring/people-counting` | `/api/people-counting` |
| `vehicle_access` | 車輛進出 | `/construction-monitoring/vehicle-access` | （若獨立 API 則對應；目前可能走 external-data／yscp） |
| `surveillance` | 影像監視 | `/construction-monitoring/surveillance` | 設備預覽等 |
| `lighting` | 照明 | `/infrastructure/lighting` | `/api/lighting` |
| `hvac` | 空調 | `/infrastructure/hvac` | （待實作） |
| `power` | 電力 | `/infrastructure/power` | （待實作） |
| `elevator` | 電梯 | `/infrastructure/elevator` | （待實作） |
| `drainage` | 衛生排水 | `/infrastructure/drainage` | （待實作） |
| `fire` | 消防 | `/security/fire` | （待實作） |
| `access_control` | 門禁保全 | `/security/access-control` | `/api/access-control` |
| `emergency` | 緊急求救 | `/security/emergency` | （待實作） |
| `maintenance` | 設備維護 | `/maintenance/equipment` | （待實作） |
| `visitor` | 訪客 | `/business/visitor` | （待實作） |
| `locker` | 寄物 | `/business/locker-management` | （待實作） |
| `multimedia` | 多媒體資訊 | `/multimedia/info` | （待實作） |

可選策略：**粗粒度**（如只做 `core`、`construction-monitoring`、`infrastructure`、`security` 等大類）或**細粒度**（上表每個 key 獨立授權）。實作時再定。

### 授權 API 規格（草案）

- **GET /api/license**  
  - 需 `authenticate`。  
  - 回傳：`{ features: string[], expiresAt: string | null, canActivate: boolean }`  
  - `features`：已啟用 feature key 陣列。  
  - `expiresAt`：整體或最早日到期時間，無則 `null`。  
  - `canActivate`：是否允許當前用戶執行啟用（僅 admin 為 true）。

- **POST /api/license/activate**  
  - 需 `authenticate` + `requireAdmin`。  
  - Body：`{ code: string }`（授權碼）。  
  - 成功：200，可一併回傳更新後的 license 狀態。  
  - 失敗：400（格式錯誤）或 403（無效／過期／已使用），body 可含 `code: "INVALID_LICENSE"` 或 `"FEATURE_NOT_LICENSED"` 等。

### 後端儲存與中介層

- **儲存**：可存於 DB（例如 `license` 表：id, feature_key, expires_at, activated_at）或系統設定表（settings key 如 `license_features`、`license_expires_at`）。依現有架構擇一。
- **requireFeature(featureKey)**：中介層在 `authenticate`、角色檢查之後執行；若當前 request 所需 feature 不在已啟用列表或已過期，回傳 `403` 且 `code: "FEATURE_NOT_LICENSED"`。
- **檢查順序**：`authenticate` → 角色（requireAdmin／requireAdminOrOperator）→ **requireFeature("key")**。

### 前端行為（待實作）

- 登入成功後呼叫 **GET /api/license**，將回傳的 `features` 存到全域狀態（如 Pinia 或 composable）。
- **導航／選單**：只顯示 `features` 內有對應 feature key 的模組（可寫成 `system-modules` 的 filter，依 route 或 id 對應到 feature key）。
- **路由守衛**：進入某頁前檢查該頁所需 feature 是否在 `features` 內；若否，導向「未授權」說明頁或首頁，並可提示聯絡管理員。
- **僅 admin**：授權碼輸入 UI（啟用按鈕、輸入框）僅在 `user.role === "admin"` 時顯示。
- **API 403**：若 response 為 403 且 `code === "FEATURE_NOT_LICENSED"`，前端可 toast 提示並導向授權說明或首頁，避免卡在空白頁。

### 授權碼驗證策略（實作時擇一或組合）

| 方式 | 說明 |
|------|------|
| 離線簽章 | 授權碼為簽過名的 JWT 或自訂格式，後端用固定公鑰驗簽；內含 features、expires_at 等。無需外網。 |
| 線上授權伺服器 | 後端拿 code 向授權伺服器查詢，回傳可啟用 features 與到期日。需網路與授權服務。 |
| 混合 | 離線驗簽為主，可選線上「心跳」回報使用狀況或延長。 |

### 實作檢查清單（授權）

- [ ] 後端：license 儲存（DB 或 settings）、讀寫 helper
- [ ] 後端：GET /api/license、POST /api/license/activate 實作
- [ ] 後端：requireFeature(featureKey) 中介層，並掛到各 feature 對應路由
- [ ] 後端：授權碼驗證邏輯（離線／線上）
- [ ] 前端：登入後取 GET /api/license 並寫入狀態
- [ ] 前端：依 features 過濾導航／system-modules
- [ ] 前端：路由守衛檢查 feature
- [ ] 前端：僅 admin 顯示授權碼輸入與啟用
- [ ] 前端：403 + FEATURE_NOT_LICENSED 的提示與導向

---

## 總結

| 項目 | 狀態 |
|------|------|
| **1. 登入** | 前端公開路由僅 `/login`、帶 Token、401 導回登入；後端公開僅登入/註冊/YSCP，其餘已加 authenticate。 |
| **2. 用戶權限** | 後端以 requireAdmin/requireOperator 區分；前端 viewer 已隱藏所有寫入入口（含導覽列「更多功能」、首頁編輯、各地點管理、照明控制等）。 |
| **3. 授權** | 設計已定（Feature Key、GET/POST 授權 API、requireFeature）；尚未實作。 |
