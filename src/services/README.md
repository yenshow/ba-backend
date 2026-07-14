# `src/services` 目錄對照（SSOT）

後端業務邏輯層；HTTP 入口見 `src/routes/`。新增 service 請依 **領域** 放入對應子資料夾，**勿**再建立 `systems/` 總包目錄。

## 目錄一覽（約 162 檔 `.js`）

| 資料夾 | 檔案數 | 職責 |
|--------|--------|------|
| `platform/` | 4 | `userService`、`settingsService`、`runtimeConfig*`（**不含** `moduleRegistry`；見 `src/access/registry.js`） |
| `license/` | 5 | 授權狀態、配額、平台線上啟用、`effectiveFeaturesCache` |
| `location/` | 6 | 區域／地點／`location_systems`（多系統共用）、controller 綁定提取 |
| `elevator/` | 7 | 電梯地點、運行態、樓層授權、梯控同步 job |
| `ladderSdk/` | 10 | HCNetSDK 梯控／呼梯、卡號、佈防事件 |
| `snapshotStatus/` | 9 | Modbus 快照型子系統：`*StatusService` + 背景 `snapshotTaskRegistry` |
| `environment/` | 6 | 環境讀數、衍生指標、彙總排程 |
| `peopleCounting/` | 13 | 人流 API、sync、providers；含 ISAPI 攝影機訂閱（`isapiPeopleCounting*`） |
| `vehicleAccess/` | 18 | 車輛進出 API、ISAPI 訂閱／持久化、方向正規化、備份同步 |
| `entryExit/` | 4 | 人流／車輛共用：transition／cumulative 統計、營運日、`resolveTimeOptions` |
| `devices/` | 10 | 設備 CRUD、Modbus、`modbusDiDoConfig` |
| `monitoring/` | 11 | `backgroundMonitor`、`monitoringTaskRegistry`、`snapshotTaskRegistry`、環境／電梯／快照／DI-DO 監控 |
| `alerts/` | 10 | 警報 CRUD、規則、Email、聯動 |
| `operationalEvents/` | 4 | `service` 查寫／`copy` 文案／`hooks` 控制寫入·抑制·電梯投影／`retentionScheduler` |
| `backup/` | 8 | 備份排程與各系統報表格式 |
| `accessControl/` | 5 | 門禁業務、ISAPI 訂閱／持久化 |
| `isapi/` | 1 | **佈防訂閱中心** `isapiSubscribeHub`（`licenseRuntimeService` reconcile） |
| `externalData/` | 14 | 外部 DB handler 與車輛群組彙總 |
| `communication/` | 2 | MediaMTX 串流（對應 license `surveillance`） |
| `personnel/` | 11 | 人員、匯入、人臉、同步 job |
| `yscp/` | 5 | YSCP Artemis 客戶端、事件訂閱、Runtime、人員／事件接收 |
| `websocket/` | 2 | WebSocket 推播、`wsEventPermissions` |
| `multimedia/` | 1 | 多媒體儀表板 |
| `notifications/` | 1 | SMTP mailer |

## 路由 → Service 對照（常用）

| 路由模組 | 主要 service |
|----------|----------------|
| `userRoutes` | `platform/userService`、`access/permissionService`（含 `/permission-definitions`、`/:id/permissions`） |
| `settingsRoutes` / `runtimeConfigRoutes` | `platform/settingsService`、`platform/runtimeConfigService` |
| `licenseRoutes` | `license/*` |
| `locationRoutes` | `location/locationService` |
| `environmentRoutes` | `environment/environmentService` |
| `peopleCountingRoutes` | `peopleCounting/peopleCountingService`、`entryExit/resolveTimeOptions` |
| `lighting`～`smokeAlarm` Routes（狀態 API） | `snapshotStatus/*StatusService` + `location/locationService` |
| `deviceRoutes` / `modbusRoutes` | `devices/*` |
| `alertRoutes` | `alerts/*` |
| `operationalEventRoutes` | `operationalEvents/*` |
| `accessControlRoutes` | `accessControl/accessControlService` |
| `externalDataRoutes` | `externalData/*` |
| `personnelRoutes` | `personnel/*` |
| `elevatorRoutes` | `elevator/*`、`elevatorFloorSyncJobService` |
| `ladderSdkRoutes` | `ladderSdk/*` |
| `multimediaDashboardRoutes` | `multimedia/multimediaDashboardService` |

啟動時另見 `server.js`：`platform/runtimeConfigApply`、`environment/environmentAggregationService`、備份／警報排程、ISAPI 訂閱等。

## 依賴慣例

- **深度**：`services/<domain>/` 下一層檔案引用 DB／config／utils 用 `../../database`、`../../config`、`../../utils`。
- **跨域**：優先 `require("../<domain>/...")`，避免在 `routes` 外再包一層 `systems`。
- **快照監控**：`monitoring/snapshotTaskRegistry` 註冊各 `snapshotStatus/*`；共用欄位語意見 `monitoring/systemSnapshotStatusFields.js`。
- **人流統計**：**不**註冊於 `monitoringTaskRegistry`／`backgroundMonitor`；即時刷新依 YSCP 事件（`yscpEventRoutes`）、門禁／攝影機 ISAPI 訂閱與 WS 提示 → REST 校準（見 `docs/40-systems/people-counting.md`）。舊版定時輪詢 `peopleCountingMonitor.js` 已移除，勿恢復。
- **Modbus DI/DO**：照明／空調與 `devices/modbusDiDoConfig.js` 共用，勿在單一 `*StatusService` 內複製位址解析。

## 新增子系統時放哪裡？

| 類型 | 建議路徑 |
|------|----------|
| 有 `getStatusSnapshot` 的 Modbus 基礎設施 | `snapshotStatus/<name>StatusService.js` + 在 `monitoring/snapshotTaskRegistry.js` 註冊 |
| 區域／地點設定延伸 | 改 `location/locationService.js` 的 `formatSystem` |
| 獨立 feature（環境、人流、車輛） | `environment/`、`peopleCounting/`、`vehicleAccess/` 或新開同層資料夾 |
| 跨 feature 共用（進出統計、營運日） | `entryExit/`（路由：`routes/entryExitRoutes.js`） |
| 平台／授權 | `platform/`、`license/` |

詳細擴充 checklist 見 `docs/00-decisions/infrastructure-layout-design.md`。

## 維護注意

- `dist/staging/` 為打包產物；變更 `src/services` 後需重新執行打包腳本才會同步。
- HTTP 路徑中的 `/systems/:systemId` 表示「地點系統實例」，與本目錄名稱無關。
