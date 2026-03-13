# BA 系統 - 登入、用戶權限與授權（精簡總結）

一份文檔涵蓋：**① 登入**、**② 用戶權限（admin/operator/viewer）**、**③ 系統授權（授權碼）**。實作順序：**登入 → 角色權限 → 系統授權**。

---

## 目前授權狀況（實作摘要）

### 授權控管 vs 基本功能

| 類型 | 說明 | 控管方式 |
|------|------|----------|
| **授權控管（5 個模組）** | 人流統計、照明、環境品質、影像監控、車輛進出 | 依 **授權 feature**：未授權時前端顯示鎖頭、不載入資料（首頁顯示「尚無資料」）、後端 API 回傳 403。 |
| **基本功能** | 警示紀錄、人員管理、設備管理、全區點位圖、權限管理、首頁、系統設定等 | 僅依 **角色**（admin/operator/viewer）控管，不做授權檢查。 |

### 授權 Feature Key（僅此 5 項）

| Feature Key | 模組 | 後端 API 控管 | 前端路由 |
|-------------|------|---------------|----------|
| `people_counting` | 人流統計管理 | `/api/people-counting` 整段 | `/construction-monitoring/people-counting` |
| `lighting` | 照明系統 | `/api/lighting` 整段 | `/infrastructure/lighting` |
| `environment` | 環境品質系統 | `/api/environment` 整段 | `/construction-monitoring/environment` |
| `surveillance` | 影像監視系統 | `/api/devices` 下 `/:id/stream/*`（start/stop/status） | `/construction-monitoring/surveillance` |
| `vehicle_access` | 車輛進出管理 | `/api/external-data/vehicle-access/vehicle-groups` 及車輛相關表讀取 | `/construction-monitoring/vehicle-access` |

### 後端實作狀態

- **儲存**：`system_settings` 表，key `license_features`（JSON 陣列）、`license_expires_at`（ISO 字串）。
- **API**：`GET /api/license`（需認證）、`POST /api/license/activate`（需 admin，body `{ features: string[], expiresAt? }`，僅儲存合法 key）。
- **中介層**：`requireFeature(featureKey)`，未授權或過期回傳 403、`code: "FEATURE_NOT_LICENSED"`。
- **環境變數**：`LICENSE_OPEN_ALL_FEATURES=true` 時後端視為全部授權，不讀 DB。

### 前端實作狀態

- **授權狀態**：登入後呼叫 `GET /api/license`，存於 `useLicense()` 的 `license` 狀態（一律依後端回傳，不因 openAll 跳過 API）。
- **hasFeature(key)**：用於**鎖頭、路由守衛**。當 `NUXT_PUBLIC_LICENSE_OPEN_ALL_FEATURES=true` 時恆為 true（不顯示鎖、不擋路由）；否則依 `license.features`。
- **canLoadFeature(key)**：用於**是否載入資料**（如首頁環境／人流區塊）。一律依後端 `license.features`，不套用 openAll，確保前後端一致。
- **首頁**：環境區塊、人流區塊依 `canLoadFeature("environment")` / `canLoadFeature("people_counting")` 決定是否打 API 與顯示；未授權顯示「尚無資料」。
- **導航**：未授權模組顯示鎖頭 SVG，點擊 toast 提示「此功能尚未授權」；路由守衛未授權時導回首頁並提示。
- **環境變數**：`NUXT_PUBLIC_LICENSE_OPEN_ALL_FEATURES=true` 時僅影響「不顯示鎖頭、不擋路由」，不影響「是否載入資料」。

### 授權碼驗證（尚未接上）

- **POST /api/license/activate** 目前為 MVP：admin 直接傳入 `{ features, expiresAt }` 寫入 `system_settings`。
- 後續可改為 body `{ code }`，由後端依 [LICENSE_OFFLINE_AND_ONLINE.md](./LICENSE_OFFLINE_AND_ONLINE.md) 做離線簽章或線上授權伺服器驗證後再寫入。

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

客戶可能只購買部分模組；以**授權**解鎖，未授權模組前端顯示鎖頭、不載入資料，後端回傳 403（`code: "FEATURE_NOT_LICENSED"`）。僅 **5 個模組**做授權控管，其餘為基本功能（僅角色控管）。

### 設計要點（已實作）

| 項目 | 說明 |
|------|------|
| 授權維度 | 僅 5 個 Feature Key：`people_counting`、`lighting`、`environment`、`surveillance`、`vehicle_access`。 |
| 後端 | 儲存於 `system_settings`（`license_features`、`license_expires_at`）；**GET /api/license**、**POST /api/license/activate**（admin 傳入 features 陣列）；對應路由加 **requireFeature("key")**。 |
| 前端 | 登入後取 GET /api/license；**hasFeature** 用於鎖頭與路由守衛，**canLoadFeature** 用於是否載入資料（首頁等），確保與後端一致。 |
| 檢查順序 | authenticate → 角色（若有）→ requireFeature。 |

授權碼驗證的**離線版**與**線上版**設計與流程，請見 [LICENSE_OFFLINE_AND_ONLINE.md](./LICENSE_OFFLINE_AND_ONLINE.md)。

### Feature Key 與前端對照（目前實作）

目前僅下列 5 個 key 做授權控管；其餘功能（`/core/*`、首頁等）為基本功能，僅由角色管理。

| Feature Key | 說明 | 前端路由 | 後端 API 控管 |
|-------------|------|----------|---------------|
| `people_counting` | 人流統計管理 | `/construction-monitoring/people-counting` | `/api/people-counting` 整段 |
| `lighting` | 照明系統 | `/infrastructure/lighting` | `/api/lighting` 整段 |
| `environment` | 環境品質系統 | `/construction-monitoring/environment` | `/api/environment` 整段 |
| `surveillance` | 影像監視系統 | `/construction-monitoring/surveillance` | `/api/devices/:id/stream/*`（start/stop/status） |
| `vehicle_access` | 車輛進出管理 | `/construction-monitoring/vehicle-access` | `/api/external-data/vehicle-access/vehicle-groups` 及車輛相關表 |

### 授權 API 規格（已實作）

- **GET /api/license**  
  - 需 `authenticate`。  
  - 回傳：`{ features: string[], expiresAt: string | null, expired: boolean, canActivate: boolean }`  
  - `features`：已啟用 feature key 陣列（僅上述 5 個 key）。  
  - `expiresAt`：到期時間（ISO），無則 `null`。  
  - `canActivate`：僅 admin 為 true。

- **POST /api/license/activate**（MVP）  
  - 需 `authenticate` + `requireAdmin`。  
  - Body：`{ features: string[], expiresAt?: string | null }`（直接寫入，僅儲存合法 key）。  
  - 後續可改為 body `{ code: string }`，由離線／線上授權驗證後寫入。

### 後端儲存與中介層

- **儲存**：已採用 `system_settings` 表，key `license_features`（JSON 陣列）、`license_expires_at`、`license_updated_at`。
- **requireFeature(featureKey)**：在 `authenticate`、角色之後執行；未授權或過期回傳 403、`code: "FEATURE_NOT_LICENSED"`。
- **檢查順序**：`authenticate` → 角色（若有）→ **requireFeature("key")**。

### 暫時開放所有功能（環境變數）

開發或展示時可透過環境變數略過授權檢查，預設為關閉。

| 端 | 變數 | 說明 |
|----|------|------|
| 後端 | `LICENSE_OPEN_ALL_FEATURES=true` | 後端視為已授權所有 feature，不讀 system_settings，API 正常放行。 |
| 前端 | `NUXT_PUBLIC_LICENSE_OPEN_ALL_FEATURES=true` | 前端**不顯示鎖頭、不擋路由**（`hasFeature` 恆為 true）；**是否載入資料**仍依 GET /api/license（`canLoadFeature`），故僅開前端時首頁未授權區塊仍為「尚無資料」。 |

建議開發時兩端都設；正式環境勿設。

### 前端行為（已實作）

- 登入後 **GET /api/license** 存於 `useLicense()`，一律依後端回傳（不因 openAll 跳過 API）。
- **hasFeature(key)**：鎖頭、路由守衛；openAll 時恆為 true。
- **canLoadFeature(key)**：是否載入資料（如首頁環境／人流）；僅依後端 `license.features`，確保前後端一致。
- **導航**：未授權模組顯示鎖頭，點擊 toast「此功能尚未授權」；路由守衛未授權導回首頁。
- **首頁**：環境／人流區塊依 canLoadFeature 決定是否打 API，未授權顯示「尚無資料」。

### 授權碼驗證策略（離線／線上）

| 方式 | 說明 |
|------|------|
| 離線版 | 授權碼為簽過名的 JWT 或自訂格式，後端用固定公鑰驗簽；內含 features、expires_at 等。無需外網。詳見 [LICENSE_OFFLINE_AND_ONLINE.md](./LICENSE_OFFLINE_AND_ONLINE.md#一離線版offline-license)。 |
| 線上版 | 後端拿 code 向授權伺服器查詢，回傳可啟用 features 與到期日。需網路與授權服務。詳見 [LICENSE_OFFLINE_AND_ONLINE.md](./LICENSE_OFFLINE_AND_ONLINE.md#二線上版online-license)。 |
| 混合 | 離線驗簽為主，可選線上「心跳」回報使用狀況或延長。見 [LICENSE_OFFLINE_AND_ONLINE.md](./LICENSE_OFFLINE_AND_ONLINE.md#三比較與選擇)。 |

### 實作檢查清單（授權）

- [x] 後端：license 儲存（system_settings）、讀寫（licenseService）
- [x] 後端：GET /api/license、POST /api/license/activate（MVP：直接寫入 features）
- [x] 後端：requireFeature(featureKey)，並掛到 5 個模組對應路由
- [ ] 後端：授權碼驗證邏輯（離線／線上，接 POST /api/license/activate）
- [x] 前端：登入後取 GET /api/license 並寫入狀態（一律呼叫，不因 openAll 跳過）
- [x] 前端：導航未授權顯示鎖頭、點擊提示
- [x] 前端：路由守衛檢查 feature，未授權導回首頁
- [x] 前端：首頁依 canLoadFeature 決定是否載入環境／人流資料，未授權顯示「尚無資料」
- [ ] 前端：僅 admin 顯示授權碼輸入與啟用 UI（可接 POST /api/license/activate）
- [ ] 前端：403 + FEATURE_NOT_LICENSED 的統一提示與導向（可選）

---

## 總結

| 項目 | 狀態 |
|------|------|
| **1. 登入** | 前端公開路由僅 `/login`、帶 Token、401 導回登入；後端公開僅登入/註冊/YSCP，其餘已加 authenticate。 |
| **2. 用戶權限** | 後端以 requireAdmin/requireOperator 區分；前端 viewer 已隱藏所有寫入入口（含導覽列「更多功能」、首頁編輯、各地點管理、照明控制等）。 |
| **3. 授權** | 5 個模組（人流、照明、環境、影像監控、車輛進出）依授權控管；儲存於 system_settings；GET/POST /api/license 已實作；前端 hasFeature／canLoadFeature、鎖頭、路由守衛、首頁「尚無資料」已實作。授權碼驗證（離線／線上）尚未接上。 |
