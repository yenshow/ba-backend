# Modbus 操作與方法清單

## 📋 總覽

本文件列出所有 Modbus 相關的操作與方法，包含後端 API、服務方法、前端 API 和頁面功能。

---

## 🔧 後端 API 端點

### 健康檢查

- **`GET /api/modbus/health`**
  - 功能：檢查 Modbus 連線狀態
  - 回應：`{ isOpen, host, port, unitId, lastConnectedAt }`
  - 無參數

### 讀取操作（GET）

| 端點                                | Function Code | 功能              | 參數                   | 回應格式                               |
| ----------------------------------- | ------------- | ----------------- | ---------------------- | -------------------------------------- |
| `GET /api/modbus/discrete-inputs`   | 02            | 讀取離散輸入 (DI) | `?address=0&length=16` | `{ address, length, data: boolean[] }` |
| `GET /api/modbus/coils`             | 01            | 讀取數位輸出 (DO) | `?address=0&length=16` | `{ address, length, data: boolean[] }` |
| `GET /api/modbus/holding-registers` | 03            | 讀取保持暫存器    | `?address=0&length=10` | `{ address, length, data: number[] }`  |
| `GET /api/modbus/input-registers`   | 04            | 讀取輸入暫存器    | `?address=0&length=10` | `{ address, length, data: number[] }`  |

**參數說明：**

- `address`: 開始位址（非負整數，預設 0）
- `length`: 讀取筆數（1-125，預設 10）

### 寫入操作（PUT）

| 端點                    | Function Code | 功能              | 請求體 | 回應格式                             |
| ----------------------- | ------------- | ----------------- | ------ | ------------------------------------ |
| `PUT /api/modbus/coils` | 05/15         | 寫入數位輸出 (DO) | 見下方 | `{ address, value/values, success }` |

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
curl "http://localhost:4000/api/modbus/coils?address=0&length=16"

# 寫入 DO（位址 0 設為 true）
curl -X PUT http://localhost:4000/api/modbus/coils \
  -H "Content-Type: application/json" \
  -d '{"address": 0, "value": true}'
```

### 前端使用

```typescript
// 在 composable 中
const modbusApi = useModbusApi();
const health = await modbusApi.getHealth();
const coils = await modbusApi.getCoils(0, 16);
await modbusApi.writeCoil(0, true);

// 在頁面中
loadModbusData("coils", { suppressError: true });
handleRefresh("coils");
```

---

## ⚠️ 注意事項

1. **位址對應**：DO 12 對應 Modbus 位址 0（從 0 開始）
2. **筆數限制**：單次讀取最多 125 筆
3. **自動刷新**：每 2 秒自動刷新一次（可在 `AUTO_REFRESH_INTERVAL` 調整）
4. **連線管理**：後端會自動處理連線與重連
5. **錯誤處理**：所有 API 都有統一的錯誤處理機制
