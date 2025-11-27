# Modbus 操作與方法清單

## 📋 總覽

本文件列出所有 Modbus 相關的操作與方法，包含後端 API、服務方法、前端 API 和頁面功能。

---

## 🔧 後端 API 端點

**重要**：所有 Modbus API 都需要在 query 參數中提供設備連線資訊（`host`、`port`、`unitId`），後端支援同時連接多個不同的 Modbus 設備。

### 健康檢查

- **`GET /api/modbus/health?host=<ip>&port=<port>&unitId=<id>`**
  - 功能：檢查 Modbus 連線狀態
  - 參數（必填）：
    - `host`: Modbus 設備 IP 位址
    - `port`: Modbus TCP 埠號（通常為 502）
    - `unitId`: Modbus Unit ID（0-255）
  - 回應：`{ isOpen, host, port, unitId, lastConnectedAt }`

### 讀取操作（GET）

| 端點                                | Function Code | 功能              | 參數（必填）                                  | 回應格式                               |
| ----------------------------------- | ------------- | ----------------- | --------------------------------------------- | -------------------------------------- |
| `GET /api/modbus/discrete-inputs`   | 02            | 讀取離散輸入 (DI) | `host`, `port`, `unitId`, `address`, `length` | `{ address, length, data: boolean[] }` |
| `GET /api/modbus/coils`             | 01            | 讀取數位輸出 (DO) | `host`, `port`, `unitId`, `address`, `length` | `{ address, length, data: boolean[] }` |
| `GET /api/modbus/holding-registers` | 03            | 讀取保持暫存器    | `host`, `port`, `unitId`, `address`, `length` | `{ address, length, data: number[] }`  |
| `GET /api/modbus/input-registers`   | 04            | 讀取輸入暫存器    | `host`, `port`, `unitId`, `address`, `length` | `{ address, length, data: number[] }`  |

**參數說明：**

- `host`（必填）：Modbus 設備 IP 位址
- `port`（必填）：Modbus TCP 埠號（通常為 502）
- `unitId`（必填）：Modbus Unit ID（0-255）
- `address`（選填）：開始位址（非負整數，預設 0）
- `length`（選填）：讀取筆數（1-125，預設 10）

### 寫入操作（PUT）

| 端點                    | Function Code | 功能              | Query 參數（必填）       | 請求體 | 回應格式                                     |
| ----------------------- | ------------- | ----------------- | ------------------------ | ------ | -------------------------------------------- |
| `PUT /api/modbus/coils` | 05/15         | 寫入數位輸出 (DO) | `host`, `port`, `unitId` | 見下方 | `{ address, value/values, success, device }` |

**Query 參數（必填）**：

- `host`: Modbus 設備 IP 位址
- `port`: Modbus TCP 埠號（通常為 502）
- `unitId`: Modbus Unit ID（0-255）

**單個寫入請求：**

```json
{
	"address": 0,
	"value": true
}
```

**多個寫入請求：**

```json
{
	"address": 0,
	"values": [true, false, true]
}
```

---

## 🛠️ 後端服務方法（ModbusClient）

### 連線管理

- **`ensureConnection()`**
  - 功能：確保 Modbus TCP 連線已建立
  - 回傳：`Promise<void>`
  - 說明：自動處理連線、重連、ID 設定

### 讀取方法

- **`readDiscreteInputs(address, length)`**

  - Function Code: 02
  - 功能：讀取離散輸入
  - 回傳：`Promise<boolean[]>`

- **`readCoils(address, length)`**

  - Function Code: 01
  - 功能：讀取數位輸出（DO）
  - 回傳：`Promise<boolean[]>`

- **`readHoldingRegisters(address, length)`**

  - Function Code: 03
  - 功能：讀取保持暫存器
  - 回傳：`Promise<number[]>`

- **`readInputRegisters(address, length)`**
  - Function Code: 04
  - 功能：讀取輸入暫存器
  - 回傳：`Promise<number[]>`

### 寫入方法

- **`writeCoil(address, value)`**

  - Function Code: 05
  - 功能：寫入單個 DO
  - 參數：`address: number`, `value: boolean`
  - 回傳：`Promise<boolean>`（成功與否）

- **`writeCoils(address, values)`**
  - Function Code: 15
  - 功能：寫入多個 DO
  - 參數：`address: number`, `values: boolean[]`
  - 回傳：`Promise<boolean>`（成功與否）

### 狀態查詢

- **`getStatus()`**

  - 功能：取得連線狀態
  - 回傳：`{ isOpen, host, port, unitId, lastConnectedAt }`

- **`close()`**
  - 功能：關閉 Modbus 連線
  - 回傳：`Promise<void>`

---

## 🎨 前端 API 方法（useModbusApi）

### 讀取方法

- **`getHealth()`**

  - 功能：健康檢查
  - 回傳：`Promise<ModbusHealth>`

- **`getDiscreteInputs(address, length)`**

  - 功能：讀取離散輸入
  - 回傳：`Promise<ModbusDataResponse<boolean>>`

- **`getCoils(address, length)`**

  - 功能：讀取數位輸出（DO）
  - 回傳：`Promise<ModbusDataResponse<boolean>>`

- **`getHoldingRegisters(address, length)`**

  - 功能：讀取保持暫存器
  - 回傳：`Promise<ModbusDataResponse<number>>`

- **`getInputRegisters(address, length)`**
  - 功能：讀取輸入暫存器
  - 回傳：`Promise<ModbusDataResponse<number>>`
  - 狀態：目前未在頁面中使用

### 寫入方法

- **`writeCoil(address, value)`**

  - 功能：寫入單個 DO
  - 回傳：`Promise<{ address, value, success }>`

- **`writeCoils(address, values)`**
  - 功能：寫入多個 DO
  - 回傳：`Promise<{ address, values, success }>`

---

## 📄 前端頁面功能（modbus.vue）

### 資料載入

- **`loadModbusData(type, options?)`** ⭐ 統一方法

  - 功能：統一載入 Modbus 資料
  - 參數：
    - `type`: `"discrete-inputs" | "holding-registers" | "coils"`
    - `options`: `{ suppressError?: boolean }`
  - 說明：內部會根據 type 呼叫對應的 API 並更新對應的 ref

- **`loadDiscreteInputs(options?)`** - 向後兼容
- **`loadHoldingRegisters(options?)`** - 向後兼容
- **`loadCoils(options?)`** - 向後兼容

- **`loadData(options?)`**
  - 功能：載入所有資料（健康檢查 + 三種讀取）
  - 參數：`{ silent?: boolean }`
  - 說明：`silent=true` 時用於自動刷新，不會顯示錯誤訊息

### 手動刷新

- **`handleRefresh(type)`** ⭐ 統一方法

  - 功能：統一處理手動刷新
  - 參數：`type: ModbusDataType`

- **`handleDiscreteRefresh()`** - 向後兼容
- **`handleHoldingRefresh()`** - 向後兼容
- **`handleCoilsRefresh()`** - 向後兼容

### DO 控制

- **`handleToggleCoil(address, value)`**
  - 功能：切換 DO 狀態
  - 參數：`address: number`, `value: boolean`
  - 說明：寫入後自動重新讀取 DO 狀態

### 自動刷新

- **`startAutoRefresh()`**

  - 功能：啟動每 2 秒自動刷新
  - 說明：在 `onMounted` 時自動啟動

- **`stopAutoRefresh()`**
  - 功能：停止自動刷新
  - 說明：在 `onBeforeUnmount` 時自動停止

### 工具函數

- **`validateForm()`**

  - 功能：驗證表單（位址和筆數）
  - 回傳：`boolean`

- **`formatDate(value)`**

  - 功能：格式化日期顯示
  - 參數：`Date | string | null`
  - 回傳：`string`

- **`setError(message)`**
  - 功能：設定錯誤訊息

### 計算屬性

- **`isConnected`** - 是否已連線
- **`hostLabel`** - 目標裝置標籤（host:port）
- **`healthStatus`** - 連線狀態文字

---

## 📊 資料結構

### ModbusHealth

```typescript
{
	isOpen: boolean;
	host: string;
	port: number;
	unitId: number;
	lastConnectedAt: string | null;
}
```

### ModbusDataResponse<T>

```typescript
{
  address: number;
  length: number;
  data: T[];  // T 為 number 或 boolean
  device?: DeviceConfig;  // 設備配置資訊（後端回應中包含）
}
```

### DeviceConfig

```typescript
{
  host: string;    // Modbus 設備 IP 位址
  port: number;    // Modbus TCP 埠號
  unitId: number;  // Modbus Unit ID (0-255)
}
```

---

## 🔄 精簡後的架構

### 後端

- ✅ 使用 `routeFactory` 統一處理讀取路由
- ✅ 連線管理統一在 `ensureConnection`
- ✅ 錯誤處理統一在路由層

### 前端

- ✅ 使用 `loadModbusData(type)` 統一載入邏輯
- ✅ 使用 `handleRefresh(type)` 統一刷新邏輯
- ✅ 保留個別函數以維持向後兼容
- ✅ 移除多餘的箭頭函數包裝

---

## 📝 使用範例

### 後端 API 呼叫

```bash
# 讀取 DO（位址 0-15）
curl "http://localhost:4000/api/modbus/coils?host=192.168.2.204&port=502&unitId=1&address=0&length=16"

# 寫入 DO（位址 0 設為 true）
curl -X PUT "http://localhost:4000/api/modbus/coils?host=192.168.2.204&port=502&unitId=1" \
  -H "Content-Type: application/json" \
  -d '{"address": 0, "value": true}'
```

### 前端使用

```typescript
// 定義設備配置
const deviceConfig: DeviceConfig = {
	host: "192.168.2.205",
	port: 502,
	unitId: 205
};

// 在 composable 中
const modbusApi = useModbusApi();
const health = await modbusApi.getHealth(deviceConfig);
const coils = await modbusApi.getCoils(0, 16, deviceConfig);
await modbusApi.writeCoil(0, true, deviceConfig);

// 在頁面中
loadModbusData("coils", { suppressError: true });
handleRefresh("coils");
```

---

---

## ✅ 前後端相容性驗證

### API 參數格式

**前端傳遞方式** (`app/composables/useModbus.ts`):

```typescript
const deviceConfigToParams = (deviceConfig: DeviceConfig): QueryParams => {
	return {
		host: deviceConfig.host,
		port: deviceConfig.port,
		unitId: deviceConfig.unitId
	};
};
```

**後端接收方式** (`src/routes/modbusRoutes.js`):

```javascript
const parseDeviceParams = (req) => {
	const host = req.query.host.trim();
	const port = Number(req.query.port);
	const unitId = Number(req.query.unitId);
	return { host, port, unitId };
};
```

**驗證結果**: ✅ **完全一致**
- 前端透過 query 參數傳遞 `host`, `port`, `unitId`
- 後端從 `req.query` 讀取並解析這些參數
- 參數名稱、類型、驗證邏輯都匹配

### API 回應格式

**前端類型定義** (`app/types/modbus.ts`):

```typescript
export interface ModbusHealth {
	isOpen: boolean;
	host: string;
	port: number;
	unitId: number;
	lastConnectedAt: string | null;
}

export interface ModbusDataResponse<T = number | boolean> {
	address: number;
	length: number;
	data: T[];
	device?: DeviceConfig;
}
```

**後端回應格式**:

- 健康檢查：`{ isOpen, host, port, unitId, lastConnectedAt }`
- 讀取操作：`{ address, length, data, device }`

**驗證結果**: ✅ **完全一致**
- `ModbusHealth` 的所有欄位都匹配
- `ModbusDataResponse` 包含所有必要欄位
- `lastConnectedAt` 在後端是 Date 對象，Express 會自動序列化為 ISO 字符串

### API 端點對應

| 功能                   | 前端方法                                             | 後端端點                            | 狀態 |
| ---------------------- | ---------------------------------------------------- | ----------------------------------- | ---- |
| 健康檢查               | `getHealth(deviceConfig)`                            | `GET /api/modbus/health`            | ✅   |
| 讀取離散輸入           | `getDiscreteInputs(address, length, deviceConfig)`   | `GET /api/modbus/discrete-inputs`   | ✅   |
| 讀取 Coils             | `getCoils(address, length, deviceConfig)`            | `GET /api/modbus/coils`             | ✅   |
| 讀取 Holding Registers | `getHoldingRegisters(address, length, deviceConfig)` | `GET /api/modbus/holding-registers` | ✅   |
| 讀取 Input Registers   | `getInputRegisters(address, length, deviceConfig)`   | `GET /api/modbus/input-registers`   | ✅   |
| 寫入單個 Coil          | `writeCoil(address, value, deviceConfig)`            | `PUT /api/modbus/coils`             | ✅   |
| 寫入多個 Coils         | `writeCoils(address, values, deviceConfig)`          | `PUT /api/modbus/coils`             | ✅   |

### 設備配置管理

**前端設計**:
- 設備配置在頁面層定義（`modbus.vue`）
- 每個 API 調用都傳遞 `DeviceConfig`
- 支援不同頁面使用不同設備配置

**後端設計**:
- 支援同時連接多個設備
- 每個連接使用 `host:port:unitId` 作為唯一 key
- 自動管理連線池，避免重複連接
- 每個設備的連線狀態獨立追蹤

**驗證結果**: ✅ **設計一致**

### 錯誤處理

**前端** (`app/composables/useModbus.ts`):
```typescript
catch (error) {
  if (error instanceof Error) {
    throw new Error(`Modbus API 請求失敗: ${error.message}`);
  }
  throw error;
}
```

**後端** (`src/server.js`):
```javascript
app.use((err, _req, res, _next) => {
	console.error(err);
	res.status(500).json({
		message: "Modbus request failed",
		details: err.message
	});
});
```

**驗證結果**: ✅ **一致**

### 已修復的問題

**問題**: `lastConnectedAt` 共享問題
- 原本所有設備共享同一個時間戳
- **修復**: 改為 `Map` 結構，每個連接獨立追蹤（`src/services/modbusClient.js`）

### 功能驗證狀態

- [x] 健康檢查 API
- [x] 讀取離散輸入、Coils、Holding Registers、Input Registers
- [x] 寫入單個/多個 Coils
- [x] 多設備並發連接
- [x] 每個設備獨立連線狀態追蹤
- [x] 自動重連機制
- [x] 參數驗證、連線錯誤、Modbus 協議錯誤處理

**整體狀態**: ✅ **功能正常運作**

---

## ⚠️ 注意事項

1. **位址對應**：DO 12 對應 Modbus 位址 0（從 0 開始）
2. **筆數限制**：單次讀取最多 125 筆
3. **自動刷新**：每 2 秒自動刷新一次（可在 `AUTO_REFRESH_INTERVAL` 調整）
4. **連線管理**：後端會自動處理連線與重連
5. **錯誤處理**：所有 API 都有統一的錯誤處理機制
6. **設備配置**：所有 Modbus API 都需要在 query 參數中提供設備連線資訊（`host`、`port`、`unitId`）
7. **多設備支援**：後端支援同時連接多個不同的 Modbus 設備，每個設備的連線狀態獨立追蹤
