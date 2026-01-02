# RTSP 串接設定與影像設定說明

## 📋 目錄

1. [系統架構](#系統架構)
2. [MediaMTX 服務配置](#mediamtx-服務配置)
3. [後端 RTSP 服務配置](#後端-rtsp-服務配置)
4. [前端播放器配置](#前端播放器配置)
5. [影像編解碼器設定](#影像編解碼器設定)
6. [延遲優化設定](#延遲優化設定)
7. [環境變數配置](#環境變數配置)

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

1. **HLS 配置**

   - `hlsAlwaysRemux: yes` - 自動將不兼容的編解碼器（如 H265）轉換為瀏覽器支持的格式
   - `hlsSegmentDuration: 1s` - 每個 HLS 片段時長 1 秒（平衡延遲和穩定性）
   - `hlsSegmentCount: 3` - 保留 3 個片段（約 3 秒緩衝）

2. **WebRTC 配置**

   - `webrtcAllowOrigin: "*"` - 允許所有來源的跨域訪問

3. **路徑管理**
   - 路徑通過 API 動態添加，不在配置文件中預設
   - 每個 RTSP 串流會自動生成唯一的路徑名稱

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

## 前端播放器配置

### 播放器組件

- 位置：`app/components/rtsp/VideoPlayer.vue`
- 支持：HLS (hls.js) 和 WebRTC

### HLS 播放器配置（低延遲優化）

```typescript
const HLS_PLAYER_CONFIG = {
  maxBufferLength: 0.3, // 最大緩衝 0.3 秒（極低延遲）
  maxMaxBufferLength: 0.6, // 最大緩衝上限 0.6 秒
  backBufferLength: 0, // 禁用後緩衝
  maxBufferSize: 600 * 1000, // 最大緩衝大小 600KB
  fragLoadingTimeOut: 1000, // 片段加載超時 1 秒
  manifestLoadingTimeOut: 300, // 清單加載超時 0.3 秒
  levelLoadingTimeOut: 1000, // 級別加載超時 1 秒
};
```

### hls.js 詳細配置

```typescript
{
  enableWorker: true,                    // 啟用 Web Worker
  lowLatencyMode: true,                  // 低延遲模式
  backBufferLength: 0,                   // 禁用後緩衝
  maxBufferLength: 0.3,                  // 最大緩衝 0.3 秒
  maxMaxBufferLength: 0.6,               // 最大緩衝上限 0.6 秒
  maxBufferSize: 600 * 1000,             // 最大緩衝大小 600KB
  maxBufferHole: 0.01,                   // 極小緩衝空洞
  highBufferWatchdogPeriod: 0.1,        // 緩衝監控週期 0.1 秒
  nudgeOffset: 0.001,                    // 極小調整偏移
  nudgeMaxRetry: 1,                      // 最少重試
  fragLoadingTimeOut: 1000,              // 片段加載超時 1 秒
  manifestLoadingTimeOut: 300,           // 清單加載超時 0.3 秒
  levelLoadingTimeOut: 1000,              // 級別加載超時 1 秒
  startLevel: -1,                        // 自動選擇最佳品質
  liveSyncDurationCount: 0.3,            // 只等待 0.3 個片段就開始播放（約 0.3 秒）
  liveMaxLatencyDurationCount: 1.0,      // 最大延遲 1.0 個片段（約 1 秒）
  liveDurationInfinity: false            // 不使用無限持續時間
}
```

### 播放策略

1. **優先使用 HLS**

   - 使用 hls.js 進行播放
   - 如果瀏覽器原生支持 HLS（Safari），會優先使用原生播放器

2. **錯誤處理**

   - 網路錯誤：自動重試（最多 8 次，間隔 300ms）
   - 媒體錯誤：自動恢復
   - 解碼錯誤：回退到 hls.js（如果使用原生播放器）

3. **URL 驗證**
   - 啟動前驗證 HLS URL 是否可訪問
   - 重試 8 次，間隔 300ms
   - 驗證響應內容是否包含 HLS 標記（`#EXTM3U` 或 `#EXT-X`）

---

## 影像編解碼器設定

### 支持的編解碼器

| 編解碼器        | 支持狀態    | 說明                        |
| --------------- | ----------- | --------------------------- |
| **H264**        | ✅ 完全支持 | 瀏覽器原生支持，推薦使用    |
| **H265 (HEVC)** | ⚠️ 部分支持 | 需要轉碼，可能出現 DTS 錯誤 |

### H265 問題與解決方案

#### 問題描述

當 RTSP 串流使用 H265 編解碼器時，可能出現以下錯誤：

```
[HLS] [muxer stream_xxx] destroyed: muxer error: unable to extract DTS: invalid DeltaPocS0
```

#### 解決方案

1. **推薦方案：修改攝像頭配置**

   - 將攝像頭配置為輸出 H264 編碼
   - 優點：無需轉碼，性能最佳，延遲最低
   - 缺點：需要訪問攝像頭配置界面

2. **備選方案：使用 MediaMTX 重新封裝**

   - MediaMTX 配置了 `hlsAlwaysRemux: yes`
   - 會自動嘗試將 H265 轉換為 H264
   - 注意：標準版 MediaMTX 的轉碼能力有限

3. **測試不同通道**
   - 通常 Channel 101 是 H265 流
   - Channel 102 可能是 H264 流
   - 測試 URL：`rtsp://admin:password@192.168.2.103:554/Streaming/Channels/102`

### 影像品質設定

目前系統**不進行轉碼**，直接使用攝像頭原始串流：

- **解析度**：由攝像頭配置決定
- **幀率**：由攝像頭配置決定
- **碼率**：由攝像頭配置決定
- **編解碼器**：由攝像頭配置決定（建議使用 H264）

如需調整影像品質，請在攝像頭端進行配置。

---

## 延遲優化設定

### 目標延遲

- **HLS 播放**：約 1-2 秒
- **WebRTC 播放**：< 500ms（如果實現）

### 優化措施

#### 1. MediaMTX 配置

- `hlsSegmentDuration: 1s` - 片段時長 1 秒（平衡延遲和穩定性）
- `hlsSegmentCount: 3` - 保留 3 個片段（約 3 秒緩衝）

#### 2. 前端播放器配置

- `maxBufferLength: 0.3s` - 最小緩衝（極低延遲）
- `liveSyncDurationCount: 0.3` - 只等待 0.3 個片段就開始播放
- `liveMaxLatencyDurationCount: 1.0` - 最大延遲 1.0 個片段

#### 3. 網路優化

- 使用區域網路 IP 而非 localhost（減少網路延遲）
- 自動檢測服務器 IP 地址

### 延遲組成

```
總延遲 = RTSP 連接延遲 + MediaMTX 處理延遲 + 網路傳輸延遲 + 前端緩衝延遲

典型值：
- RTSP 連接：0.1-0.2 秒
- MediaMTX 處理：0.3-0.5 秒
- 網路傳輸：0.2-0.5 秒
- 前端緩衝：0.3-1.0 秒
--------------------------------
總計：約 1-2 秒
```

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

### 啟動串流

```javascript
// 前端調用
const response = await fetch("http://192.168.2.8:4000/api/rtsp/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    rtspUrl: "rtsp://admin:password@192.168.2.103:554/Streaming/Channels/101",
  }),
});

const result = await response.json();
// result.data.hlsUrl: http://192.168.2.8:8888/stream_0cd71f31/index.m3u8
// result.data.webrtcUrl: http://192.168.2.8:8889/stream_0cd71f31
```

### 停止串流

```javascript
await fetch(`http://192.168.2.8:4000/api/rtsp/stop/${streamId}`, {
  method: "POST",
});
```

### 獲取串流狀態

```javascript
const response = await fetch("http://192.168.2.8:4000/api/rtsp/status");
const statuses = await response.json();
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

## 相關文檔

- [H265 轉碼解決方案](./H265_TRANSCODING_SOLUTION.md)
- [API 文檔](./API_DOCUMENTATION.md)
- [MediaMTX 官方文檔](https://mediamtx.org/docs/)

---

**最後更新**：2025-12-30  
**版本**：1.0.0
