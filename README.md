## Modbus 測試後端

簡單的 Node.js / Express 服務，可透過 REST API 讀取 Modbus TCP 資料（Holding/Input Registers、Coils、Discrete Inputs），方便後續 BA 系統整合前的驗證。

### 安裝

```bash
npm install
```

### 設定環境變數

複製 `env.example` 為 `.env`，並依實際 Modbus 裝置調整。

```bash
cp env.example .env
```

| 變數                     | 說明                       | 預設        |
| ------------------------ | -------------------------- | ----------- |
| `PORT`                   | 後端服務監聽 port          | `4000`      |
| `MODBUS_HOST`            | Modbus TCP 伺服器位址      | `127.0.0.1` |
| `MODBUS_PORT`            | Modbus TCP 伺服器 port     | `8502`      |
| `MODBUS_UNIT_ID`         | Slave/Unit ID              | `1`         |
| `MODBUS_TIMEOUT`         | 單位 ms 的 request timeout | `2000`      |
| `MODBUS_RECONNECT_DELAY` | 重新連線延遲（目前保留）   | `2000`      |

### 啟動方式

開發模式（自動重啟）：

```bash
npm run dev
```

正式執行：

```bash
npm start
```

服務啟動後，可透過下列 API 測試：

| Method | Path                                                | 說明                   |
| ------ | --------------------------------------------------- | ---------------------- |
| `GET`  | `/api/modbus/health`                                | 查看連線狀態           |
| `GET`  | `/api/modbus/holding-registers?address=0&length=10` | 讀取 Holding Registers |
| `GET`  | `/api/modbus/input-registers?address=0&length=10`   | 讀取 Input Registers   |
| `GET`  | `/api/modbus/coils?address=0&length=10`             | 讀取 Coils             |
| `GET`  | `/api/modbus/discrete-inputs?address=0&length=10`   | 讀取 Discrete Inputs   |

### 工具腳本

- `npm run test:modbus <host> [port]` - 測試 Modbus 連接並自動檢測配置
- `npm run scan:modbus <host> <port> <unitId> <type> <startAddress> <endAddress>` - 掃描 Modbus 地址範圍

### 後續擴充建議

- 依據 BA 系統需求，將讀取結果儲存至資料庫或訊息佇列
- 新增背景排程，定期輪詢並緩存資料
- 增加寫入（Write Single/Multiple Registers/Coils）功能，實現雙向控制
