# RTSP 串接設定與影像設定說明

## 📋 目錄

1. [系統架構](#系統架構)
2. [MediaMTX 服務配置](#mediamtx-服務配置)
3. [後端 RTSP 服務配置](#後端-rtsp-服務配置)
4. [WebSocket 整合](#websocket-整合)
5. [前端播放器配置](#前端播放器配置)
6. [影像編解碼器設定](#影像編解碼器設定)
7. [延遲優化設定](#延遲優化設定)
8. [環境變數配置](#環境變數配置)
9. [性能優化與改進建議](#性能優化與改進建議)

---

## 系統架構

```
攝影機 (RTSP)
    ↓
MediaMTX 服務 (端口 8554)
    ↓
轉換為 HLS/WebRTC
    ↓
前端播放器 (hls.js / WebRTC)
```

### 服務端口

| 服務            | 端口 | 用途              |
| --------------- | ---- | ----------------- |
| MediaMTX RTSP   | 8554 | 接收 RTSP 串流    |
| MediaMTX HLS    | 8888 | 提供 HLS 播放列表 |
| MediaMTX WebRTC | 8889 | 提供 WebRTC 串流  |
| MediaMTX API    | 9997 | 管理 API          |
| 後端 API        | 4000 | 後端服務          |

---

## MediaMTX 服務配置

### 配置文件位置

- 主配置：`mediamtx.yml`
- 運行配置：`mediamtx/mediamtx.yml`

### 當前配置 (`mediamtx.yml`)

```yaml
# 日誌設定
logLevel: info
logDestinations: [stdout]
logFile: ""

# 監聽地址
rtspAddress: :8554 # RTSP 輸入端口
rtmpAddress: :1935 # RTMP 輸入端口
hlsAddress: :8888 # HLS 輸出端口
webrtcAddress: :8889 # WebRTC 輸出端口
apiAddress: :9997 # API 管理端口
api: yes # 啟用 API

# HLS 低延遲配置
hlsAlwaysRemux: yes # 始終重新封裝（支持編解碼器轉換）
hlsSegmentCount: 3 # 保留 3 個片段
hlsSegmentDuration: 1s # 片段時長 1 秒
hlsAllowOrigin: "*" # 允許跨域訪問

# WebRTC 配置（低延遲）
webrtcAllowOrigin: "*" # 允許跨域訪問

# 路徑配置（通過 API 動態添加）
paths: {}

# 全域設定
readTimeout: 10s # 讀取超時
writeTimeout: 10s # 寫入超時
```

### 配置說明

- **HLS 配置**：`hlsAlwaysRemux: yes` 自動轉換編解碼器，`hlsSegmentDuration: 1s` 片段時長 1 秒，`hlsSegmentCount: 3` 保留 3 個片段
- **WebRTC 配置**：`webrtcAllowOrigin: "*"` 允許跨域訪問
- **路徑管理**：路徑通過 API 動態添加，每個串流自動生成唯一路徑名稱

---

## 後端 RTSP 服務配置

### 服務架構

```
RTSP Routes (API)
    ↓
RTSP Stream Service (封裝層)
    ↓
MediaMTX Service (核心服務)
    ↓
MediaMTX API (HTTP)
```

### 主要文件

1. **`src/routes/rtspRoutes.js`** - API 路由

   - `POST /api/rtsp/start` - 啟動串流
   - `POST /api/rtsp/stop/:streamId` - 停止串流
   - `GET /api/rtsp/status` - 獲取所有串流狀態
   - `GET /api/rtsp/status/:streamId` - 獲取指定串流狀態

2. **`src/services/communication/rtspStreamService.js`** - RTSP 服務封裝層

   - 提供與原有 API 兼容的介面
   - 轉發 MediaMTX 服務的事件

3. **`src/services/communication/mediaMTXService.js`** - MediaMTX 核心服務
   - 管理與 MediaMTX API 的通信
   - 處理路徑的添加和移除
   - 管理串流狀態

### 路徑配置

當添加新的 RTSP 串流時，後端會發送以下配置到 MediaMTX：

```javascript
{
  source: "rtsp://camera-url",  // RTSP 來源 URL
  sourceOnDemand: false         // 立即啟動，不等待客戶端連接
}
```

### 串流 ID 生成

- 基於 RTSP URL 的 MD5 哈希值生成
- 格式：`{streamId}` (32 字符十六進制)
- 路徑名稱：`stream_{streamId前8位}`

### URL 生成

- **HLS URL**: `http://{serverIP}:8888/{pathName}/index.m3u8`
- **WebRTC URL**: `http://{serverIP}:8889/{pathName}`

服務器 IP 會自動檢測（優先使用環境變數 `MEDIAMTX_PUBLIC_IP`）

---

## WebSocket 整合

系統通過 WebSocket 實時推送 RTSP 串流狀態變化。所有事件會廣播給所有連接的客戶端。

### WebSocket 事件類型

| 事件名稱                     | 觸發時機       | 數據格式                                                      |
| ---------------------------- | -------------- | ------------------------------------------------------------- |
| `rtsp:stream:started`        | 串流啟動成功時 | `{ streamId, rtspUrl, hlsUrl, webrtcUrl, status, timestamp }` |
| `rtsp:stream:stopped`        | 串流停止時     | `{ streamId, timestamp }`                                     |
| `rtsp:stream:error`          | 串流發生錯誤時 | `{ streamId, error: { message, code? }, timestamp }`          |
| `rtsp:stream:status:changed` | 串流狀態變更時 | `{ streamId, oldStatus, newStatus, timestamp }`（預留）       |

### 前端使用範例

```javascript
import { io } from "socket.io-client";

const socket = io("http://192.168.2.8:4000", {
  transports: ["websocket"],
});

socket.on("rtsp:stream:started", (data) => {
  // data.streamId, data.hlsUrl, data.webrtcUrl
});

socket.on("rtsp:stream:stopped", (data) => {
  // data.streamId
});

socket.on("rtsp:stream:error", (data) => {
  // data.streamId, data.error.message
});
```

**實現位置**：

- 後端：`src/services/websocket/websocketService.js`
- 觸發：`src/services/communication/rtspStreamService.js`

---

## 前端播放器配置

**位置**：`app/components/rtsp/VideoPlayer.vue`  
**支持**：HLS (hls.js) 和 WebRTC

### hls.js 低延遲配置

```typescript
{
  enableWorker: true,
  lowLatencyMode: true,
  backBufferLength: 0,
  maxBufferLength: 0.3,                  // 最大緩衝 0.3 秒
  maxMaxBufferLength: 0.6,               // 最大緩衝上限 0.6 秒
  maxBufferSize: 600 * 1000,
  liveSyncDurationCount: 0.3,            // 只等待 0.3 個片段就開始播放
  liveMaxLatencyDurationCount: 1.0,      // 最大延遲 1.0 個片段
  fragLoadingTimeOut: 1000,
  manifestLoadingTimeOut: 300,
}
```

**播放策略**：優先使用 HLS，自動重試網路錯誤（最多 8 次），URL 驗證後播放

---

## 影像編解碼器設定

### 支持的編解碼器

| 編解碼器        | 支持狀態    | 說明                        |
| --------------- | ----------- | --------------------------- |
| **H264**        | ✅ 完全支持 | 瀏覽器原生支持，推薦使用    |
| **H265 (HEVC)** | ⚠️ 部分支持 | 需要轉碼，可能出現 DTS 錯誤 |

### H265 問題與解決方案

**問題**：H265 編碼可能導致 DTS 錯誤 `unable to extract DTS: invalid DeltaPocS0`

**解決方案**：

1. **推薦**：將攝像頭配置為輸出 H264（無需轉碼，性能最佳）
2. **備選**：使用 MediaMTX 重新封裝（`hlsAlwaysRemux: yes`），但轉碼能力有限
3. **測試**：嘗試不同通道（通常 Channel 102 是 H264，Channel 101 是 H265）

### 影像品質設定

系統不進行轉碼，直接使用攝像頭原始串流。解析度、幀率、碼率、編解碼器均由攝像頭配置決定（建議使用 H264）。

---

## 延遲優化設定

**目標延遲**：HLS 播放約 1-2 秒，WebRTC < 500ms

**優化措施**：

- MediaMTX：片段時長 1 秒，保留 3 個片段
- 前端播放器：最小緩衝 0.3 秒，自動檢測服務器 IP
- 總延遲組成：RTSP 連接(0.1-0.2s) + MediaMTX 處理(0.3-0.5s) + 網路傳輸(0.2-0.5s) + 前端緩衝(0.3-1.0s) ≈ 1-2 秒

---

## 環境變數配置

### 後端環境變數

```bash
# MediaMTX 服務配置
MEDIAMTX_API_URL=http://localhost:9997          # MediaMTX API 地址
MEDIAMTX_HLS_URL=http://192.168.2.8:8888        # MediaMTX HLS 地址（供前端訪問）
MEDIAMTX_WEBRTC_URL=http://192.168.2.8:8889     # MediaMTX WebRTC 地址（供前端訪問）
MEDIAMTX_PUBLIC_IP=192.168.2.8                  # 服務器公網 IP（可選，自動檢測）

# 後端服務配置
PORT=4000                                        # 後端服務端口
HOST=0.0.0.0                                    # 監聽地址
```

### 前端環境變數

```bash
# API 配置
NUXT_PUBLIC_API_BASE=http://192.168.2.8:4000/api

# MediaMTX 服務 URL
NUXT_PUBLIC_MEDIAMTX_HLS_URL=http://192.168.2.8:8888
NUXT_PUBLIC_MEDIAMTX_WEBRTC_URL=http://192.168.2.8:8889
```

### 配置說明

- **`MEDIAMTX_PUBLIC_IP`**：如果設置，會優先使用此 IP 構建前端可訪問的 URL
- 如果未設置，系統會自動檢測區域網路 IP 地址
- 前端 URL 必須使用實際的服務器 IP，不能使用 `localhost`

---

## 使用範例

```javascript
// 啟動串流
const response = await fetch("http://192.168.2.8:4000/api/rtsp/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    rtspUrl: "rtsp://admin:password@192.168.2.103:554/Streaming/Channels/101",
  }),
});
const result = await response.json();
// result.data.hlsUrl, result.data.webrtcUrl

// 停止串流
await fetch(`http://192.168.2.8:4000/api/rtsp/stop/${streamId}`, {
  method: "POST",
});

// 獲取串流狀態
const statuses = await fetch("http://192.168.2.8:4000/api/rtsp/status").then(
  (r) => r.json()
);
```

---

## 故障排除

### 常見問題

1. **MediaMTX 服務未運行**

   - 檢查：`curl http://localhost:9997/v3/paths/list`
   - 啟動：`npm run mediamtx:start`

2. **HLS 文件 404 錯誤**

   - 等待幾秒讓 MediaMTX 生成第一個片段
   - 檢查 RTSP URL 是否可訪問
   - 確認攝像頭使用 H264 編碼

3. **H265 DTS 錯誤**

   - 將攝像頭配置為輸出 H264
   - 或使用 Channel 102（通常是 H264）

4. **跨域錯誤**

   - 確認 `hlsAllowOrigin: "*"` 和 `webrtcAllowOrigin: "*"` 已設置

5. **延遲過高**
   - 檢查網路連接
   - 確認前端播放器配置已應用
   - 考慮使用 WebRTC（如果實現）

---

## 性能優化與改進建議

### 目前實現的優化

- **路徑狀態緩存**：2 秒緩存間隔，減少 API 請求
- **批量狀態獲取**：一次性獲取所有路徑狀態
- **自動 IP 檢測**：優先使用環境變數，自動檢測區域網路 IP
- **WebSocket 通知**：實時推送串流狀態變化

### 建議的進一步優化

| 優先級 | 優化項目         | 說明                           |
| ------ | ---------------- | ------------------------------ |
| 🔴 高  | 串流健康監控     | 定期檢查狀態，自動清理失效記錄 |
| 🟡 中  | API 請求重試機制 | 指數退避重試（最多 3 次）      |
| 🟡 中  | 串流資源管理     | 設置數量限制，自動清理閒置串流 |
| 🟢 低  | 性能指標統計     | API 響應時間、失敗率統計       |
| 🟢 低  | 配置優化         | 將硬編碼配置移到環境變數       |
| 🟢 低  | 連接池優化       | 使用 HTTP Keep-Alive           |

---

## 相關文檔

- [H265 轉碼解決方案](./H265_TRANSCODING_SOLUTION.md)
- [API 文檔](./API_DOCUMENTATION.md)
- [MediaMTX 官方文檔](https://mediamtx.org/docs/)

---

**最後更新**：2025-12-30  
**版本**：1.1.0
