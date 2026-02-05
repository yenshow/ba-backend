# GPU 加速影像處理系統

## 📋 概述

本文檔說明 BA 系統中影像串流處理的完整架構，包括 GPU 硬體編碼的實作方案、系統架構、數據流程，以及相關的技術細節。

**實施狀態**：✅ **已完全實施並投入使用**

**核心結論**：✅ **使用 FFmpeg 服務層進行 GPU 硬體編碼，顯著提升影像處理性能**

**相關文檔**：`STREAMING_OPTIMIZATION_ANALYSIS.md` — 串流優化歷程、問題修復與驗證步驟

---

## 📁 影像處理相關檔案

| 檔案                                            | 職責                                    |
| ----------------------------------------------- | --------------------------------------- |
| `src/services/communication/ffmpegService.js`   | FFmpeg GPU 編碼進程、參數組裝、速度監控 |
| `src/services/communication/mediaMTXService.js` | MediaMTX 路徑管理、早回傳、背景就緒檢查 |
| `src/config/ffmpegConfig.js`                    | NVENC/QSV/AMF 參數、scale、錯誤判定     |
| `src/routes/rtspRoutes.js`                      | RTSP API 端點                           |
| `src/utils/ffmpegPath.js`                       | FFmpeg 執行檔路徑解析                   |
| `mediamtx/mediamtx.yml`                         | HLS/WebRTC 低延遲配置                   |

---

## 🏗️ 系統架構總覽

### 完整數據流架構

```
┌─────────────────────────────────────────────────────────────────┐
│                        影像處理完整流程                            │
└─────────────────────────────────────────────────────────────────┘

攝像頭設備 (RTSP 輸出)
    ↓
┌───────────────────────────────────────────────────────────────┐
│  可選：FFmpeg GPU 硬體編碼層                                    │
│  • NVIDIA NVENC (h264_nvenc)                                   │
│  • Intel Quick Sync (h264_qsv)                                 │
│  • AMD VCE (h264_amf)                                          │
│  • 位元率控制、低延遲優化                                      │
└───────────────────────────────────────────────────────────────┘
    ↓
MediaMTX 串流伺服器
    ├─ RTSP 輸入接收 (Port 8554)
    ├─ HLS 輸出 (Port 8888) ──→ 前端播放器 (HLS.js)
    └─ WebRTC 輸出 (Port 8889) ──→ 前端播放器 (低延遲)
```

### 兩種處理模式

#### 模式 1：CPU 編碼（預設）

```
攝像頭 (RTSP)
    ↓
MediaMTX (CPU 編碼/封裝)
    ↓
HLS/WebRTC 輸出
    ↓
前端播放器
```

**適用場景**：

- 低負載環境
- 不需要高品質編碼
- 系統沒有 GPU 或 GPU 驅動未安裝

#### 模式 2：GPU 硬體編碼（推薦）

```
攝像頭 (RTSP)
    ↓
FFmpeg Service (GPU 硬體編碼)
    ├─ NVIDIA NVENC
    ├─ Intel Quick Sync
    └─ AMD VCE
    ↓
MediaMTX (接收已編碼串流)
    ↓
HLS/WebRTC 輸出
    ↓
前端播放器
```

**適用場景**：

- 高負載環境（多路串流）
- 需要高品質編碼
- 需要降低 CPU 負擔
- 系統具備 GPU 且驅動已安裝

---

## 🚀 實作架構詳解

### 後端服務架構

```
┌─────────────────────────────────────────────────────────────┐
│                    後端服務 (Node.js)                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐                                        │
│  │  rtspRoutes.js   │  API 路由層                            │
│  │  • POST /start   │  ──→ 接收串流啟動請求                  │
│  │  • POST /stop    │  ──→ 接收串流停止請求                  │
│  │  • GET /status   │  ──→ 查詢串流狀態                      │
│  └────────┬─────────┘                                        │
│           │                                                   │
│           ▼                                                   │
│  ┌──────────────────┐                                        │
│  │ mediaMTXService  │  串流管理服務                          │
│  │                  │                                        │
│  │  • startStream() │  ──→ 啟動串流（支援 GPU 選項）         │
│  │  • stopStream()  │  ──→ 停止串流（清理 FFmpeg 進程）       │
│  │  • addPath()     │  ──→ 添加 MediaMTX 路徑                │
│  └────────┬─────────┘                                        │
│           │                                                   │
│           ├──────────────────┐                              │
│           │                  │                               │
│           ▼                  ▼                               │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │  ffmpegService   │  │  websocketService│                  │
│  │                  │  │                  │                  │
│  │  • startGpuEnc() │  │  • emitRTSP...   │                  │
│  │  • stopGpuEnc()  │  │  • 即時狀態推送  │                  │
│  │  • buildArgs()   │  │                  │                  │
│  └──────────────────┘  └──────────────────┘                  │
│                                                               │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
                    ┌──────────────────────────┐
                    │   MediaMTX (Port 9997)   │
                    │   • RTSP: 8554          │
                    │   • HLS: 8888           │
                    │   • WebRTC: 8889        │
                    └──────────────────────────┘
```

### 核心組件說明

#### 1. FFmpeg 服務層 (`ffmpegService.js`)

**職責**：

- 管理 FFmpeg GPU 編碼進程的生命週期
- 構建 GPU 編碼命令參數
- 監控進程狀態和錯誤處理
- 支援多種 GPU 類型（NVIDIA、Intel、AMD）

**關鍵方法**：

```javascript
// 啟動 GPU 編碼
startGpuEncoding(streamId, rtspInput, rtspOutput, options);

// 停止 GPU 編碼
stopGpuEncoding(streamId);

// 構建 FFmpeg 參數
buildFFmpegArgs(rtspInput, rtspOutput, options);

// 等待進程穩定
waitForProcessStable(streamId, stableMs, maxWaitMs, checkIntervalMs);
```

**實施位置**：`src/services/communication/ffmpegService.js`

#### 2. MediaMTX 服務層 (`mediaMTXService.js`)

**職責**：

- 管理 MediaMTX 串流路徑
- 整合 FFmpeg 服務（可選）
- 生成播放 URL（HLS、WebRTC）
- 處理串流狀態和錯誤

**關鍵方法**：

```javascript
// 啟動串流（支援 GPU 選項）
async startStream(rtspUrl, options = {
  useGpuEncoding: boolean,
  gpuType: 'nvidia' | 'intel' | 'amd',
  bitrate: string,
  preset: string
})

// 停止串流
async stopStream(streamId)

// 添加路徑
async addPath(pathName, rtspUrl)
```

**實施位置**：`src/services/communication/mediaMTXService.js`

#### 3. RTSP 路由層 (`rtspRoutes.js`)

**職責**：

- 提供 RESTful API 端點
- 驗證請求參數
- 調用服務層方法

**API 端點**：

```javascript
POST /api/rtsp/start
Body: {
  rtspUrl: string,
  useGpuEncoding?: boolean   // 簡化：僅開關，bitrate/preset 由 env 控制
}

POST /api/rtsp/stop/:streamId
GET /api/rtsp/status
GET /api/rtsp/status/:streamId
GET /api/rtsp/refresh/:streamId
```

> **注意**：`rtspRoutes.js` 僅傳遞 `useGpuEncoding`；bitrate、preset、scale 由 `mediaMTXService` 從環境變數讀取（`RTSP_SCALE`、`RTSP_BITRATE`/`GPU_BITRATE`、`GPU_PRESET`），API 可擴展以支援覆寫。

**實施位置**：`src/routes/rtspRoutes.js`

---

## 🔄 完整流程說明

### 串流啟動流程（GPU 編碼模式，早回傳架構）

```
1. 前端發起請求
   POST /api/rtsp/start
   { "rtspUrl": "rtsp://camera_url", "useGpuEncoding": true }
        ↓
2. rtspRoutes.js 驗證參數（RTSP URL）
        ↓
3. mediaMTXService.startStream()
   • 防重複 start：2 秒內同一 streamId 直接回傳現有串流
   • 生成 streamId / pathName，檢查 MediaMTX 健康
   • 若舊路徑存在：removePath → waitForPathRemoval(1000ms, 100ms)
        ↓
4. GPU 分支：addPathForPublisher(pathName)
   • 配置 MediaMTX 為 Publisher 模式（等待 RTSP 推送）
        ↓
5. ffmpegService.startGpuEncoding(scale, bitrate, preset)
   • scale 來自 RTSP_SCALE 或預設 1920:1080
   • waitForProcessStable(800ms, 5000ms, 100ms)
        ↓
6. 【早回傳】FFmpeg 穩定後立即回傳 API
   • 生成 hlsUrl、webrtcUrl，推送 WebSocket
   • waitForPathReady 改為背景執行（5000ms, 50ms）
        ↓
7. 背景：路徑就緒成功 → 正常；失敗 → 清理 + WebSocket rtsp:stream:error
```

### 串流停止流程

```
1. 前端發起請求
   POST /api/rtsp/stop/:streamId
        ↓
2. mediaMTXService.stopStream()
   • 檢查串流是否存在
        ↓
3. 如果使用 GPU 編碼
   • ffmpegService.stopGpuEncoding()
   • 優雅停止（SIGTERM）
   • 超時後強制終止（SIGKILL）
        ↓
4. mediaMTXService.removePath()
   • 從 MediaMTX 移除路徑
   • 輪詢確認移除成功（最多 2 秒，間隔 150ms）
        ↓
5. 清理記憶體
   • 從 streams Map 中移除
        ↓
6. 推送 WebSocket 事件
   • 通知前端串流已停止
        ↓
7. 返回響應
   {
     "success": true,
     "message": "串流已停止"
   }
```

---

## ⚙️ GPU 編碼配置

### 支援的 GPU 類型

#### 1. NVIDIA (NVENC)

**編碼器**：`h264_nvenc`

**配置參數**：

```javascript
{
  gpuType: 'nvidia',
  bitrate: '2M',        // 位元率
  preset: 'p4'          // 編碼預設值 (p1-p7)
}
```

**Preset 映射**（FFmpeg 8.0+，p1–p7 + -tune ll）：

- `p1`：最高品質，最慢
- `p2`–`p3`：高品質
- `p4`：**預設**，平衡品質與速度
- `p5`–`p6`：低延遲優化
- `p7`：最高性能，較低品質

**實際 FFmpeg 參數**（對應 `ffmpegConfig.js`）：

```bash
-rtsp_transport tcp   # 使用 TCP 傳輸（更穩定）
-timeout 5000000      # 5 秒超時（FFmpeg 5.0+）
-i rtsp://...         # 輸入 URL
-vf scale=1920:1080   # 可選，由 RTSP_SCALE 或 options.scale 決定
-c:v h264_nvenc
-preset p4            # p1–p7
-tune ll              # 低延遲 tune
-rc cbr               # 固定位元率（低延遲穩定性）
-b:v 2M
-maxrate 2M
-bufsize 4M
-g 6                  # GOP 與 MediaMTX 200ms 片段對齊
-pix_fmt yuv420p
-color_range tv
-c:a copy
-f rtsp rtsp://...    # 輸出 URL
```

**硬體要求**：

- ✅ NVIDIA GPU（支援 NVENC）
- ✅ NVIDIA 驅動程式（最新版本）
- ✅ CUDA 運行時庫（通常包含在驅動程式中）

#### 2. Intel (Quick Sync Video)

**編碼器**：`h264_qsv`

**配置參數**：

```javascript
{
  gpuType: 'intel',
  bitrate: '2M'
}
```

**FFmpeg 參數**（`buildQsvArgs`）：

```bash
-c:v h264_qsv
-preset fast
-b:v 2M
-maxrate 2M
-bufsize 4M
```

> **注意**：Intel QSV 目前未實作 scale；若需縮放可擴展 `ffmpegConfig.js` 的 `buildQsvArgs`。

**硬體要求**：

- ✅ Intel CPU（支援 Quick Sync）
- ✅ Intel Media SDK

#### 3. AMD (VCE)

**編碼器**：`h264_amf`

**配置參數**：

```javascript
{
  gpuType: 'amd',
  bitrate: '2M'
}
```

**FFmpeg 參數**（`buildAmfArgs`）：

```bash
-c:v h264_amf
-quality speed
-b:v 2M
-maxrate 2M
-bufsize 4M
```

> **注意**：AMD AMF 目前未實作 scale；若需縮放可擴展 `ffmpegConfig.js` 的 `buildAmfArgs`。

**硬體要求**：

- ✅ AMD GPU（支援 VCE）
- ✅ AMD Media Framework

---

## 📊 性能優勢

### CPU vs GPU 編碼對比

| 項目           | CPU 編碼       | GPU 編碼           |
| -------------- | -------------- | ------------------ |
| **編碼速度**   | 較慢           | 快 3-5 倍          |
| **CPU 使用率** | 高（50-80%）   | 低（10-20%）       |
| **多路串流**   | 受限（2-4 路） | 支援更多（10+ 路） |
| **延遲**       | 較高（2-5 秒） | 較低（1-2 秒）     |
| **品質**       | 中等           | 高（硬體優化）     |
| **功耗**       | 高             | 較低               |

### 實際測試數據

**測試環境**：

- GPU: NVIDIA GeForce GT 1030
- CPU: Intel Core i5
- 串流: 1080p @ 30fps

**單路串流**：

- CPU 編碼：CPU 使用率 60-70%，延遲 3-4 秒
- GPU 編碼：CPU 使用率 10-15%，延遲 1-2 秒

**多路串流（4 路）**：

- CPU 編碼：CPU 使用率 90%+，延遲 5-8 秒，不穩定
- GPU 編碼：CPU 使用率 20-30%，延遲 1-2 秒，穩定

---

## 🔧 配置與使用

### 環境變數配置

```bash
# .env 文件

# MediaMTX 配置
MEDIAMTX_API_URL=http://localhost:9997
MEDIAMTX_HLS_URL=http://192.168.1.100:8888
MEDIAMTX_WEBRTC_URL=http://192.168.1.100:8889
MEDIAMTX_PUBLIC_IP=192.168.1.100

# FFmpeg 配置（可選）
FFMPEG_PATH=          # 不指定則使用內建/系統 FFmpeg

# GPU 編碼預設值（可選）
ENABLE_GPU_ENCODING=false  # 預設不使用 GPU
GPU_TYPE=nvidia
GPU_BITRATE=2M             # 或 RTSP_BITRATE=2M
GPU_PRESET=p4              # NVIDIA 預設 p1–p7
RTSP_SCALE=1920:1080       # 輸出解析度（可設 1280:720 以降低延遲）
```

**MediaMTX 低延遲配置**（`mediamtx/mediamtx.yml`）：

- `hlsSegmentDuration: 200ms`、`hlsPartDuration: 50ms` — 與 FFmpeg `-g 6`（200ms @ 30fps）對齊
- `hlsSegmentCount: 7` — LL-HLS 要求 ≥7

### API 使用範例

#### 啟動 GPU 編碼串流

```javascript
// 前端請求（bitrate、preset 由環境變數 RTSP_BITRATE、GPU_PRESET 控制）
const response = await fetch("/api/rtsp/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    rtspUrl: "rtsp://camera_ip:554/stream",
    useGpuEncoding: true,
  }),
});

const result = await response.json();
// 早回傳：約 0.8–1s 即回傳
// {
//   streamId: "...",
//   hlsUrl: "http://server:8888/path/index.m3u8?t=...",
//   webrtcUrl: "http://server:8889/path",
//   status: "running"
// }
```

#### 啟動 CPU 編碼串流（預設）

```javascript
const response = await fetch("/api/rtsp/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    rtspUrl: "rtsp://camera_ip:554/stream",
    // 不指定 useGpuEncoding 或設為 false
  }),
});
```

#### 停止串流

```javascript
const response = await fetch(`/api/rtsp/stop/${streamId}`, {
  method: "POST",
});
```

---

## 🛠️ 故障排除

### 常見問題

#### 1. FFmpeg 無法載入 GPU 編碼器

**錯誤訊息**：

```
Cannot load nvcuda.dll
Error initializing encoder
```

**解決方案**：

1. **檢查 GPU 驅動程式**：

   ```bash
   # Windows
   nvidia-smi

   # 如果命令不存在，需要安裝 NVIDIA 驅動程式
   # 下載：https://www.nvidia.com/drivers
   ```

2. **更新驅動程式**：
   - 前往 NVIDIA 官方網站下載最新驅動程式
   - 安裝後重啟系統

3. **檢查 FFmpeg 版本**：

   ```bash
   npm run ffmpeg:check
   # 或
   ffmpeg -encoders | grep nvenc
   ```

4. **如果問題持續**：
   - 安裝 CUDA Toolkit（如果驅動程式更新後仍無法解決）
   - 或使用 CPU 編碼模式

#### 2. FFmpeg 進程啟動失敗

**錯誤訊息**：

```
FFmpeg GPU 編碼進程啟動失敗或超時
```

**解決方案**：

1. **檢查 RTSP 輸入是否可用**：

   ```bash
   ffmpeg -i rtsp://camera_url -t 5 test.mp4
   ```

2. **檢查 MediaMTX 是否運行**：

   ```bash
   npm run mediamtx:start
   ```

3. **檢查端口是否被佔用**：
   ```bash
   # Windows
   netstat -ano | findstr :8554
   ```

#### 3. 編碼品質不佳

**解決方案**：

1. **調整位元率**：

   ```javascript
   {
     bitrate: "4M"; // 提高位元率
   }
   ```

2. **調整 Preset（NVIDIA）**：

   ```javascript
   {
     preset: "p1"; // 使用最高品質（較慢）
   }
   ```

3. **檢查原始串流品質**：
   - 確認攝像頭輸出品質
   - 檢查網路帶寬

---

## 📝 實施細節

### FFmpeg 路徑解析

系統會按以下優先順序查找 FFmpeg 執行檔：

1. **環境變數** `FFMPEG_PATH`（最高優先級）
2. **下載的最新版本** `ffmpeg/bin/ffmpeg.exe`（Windows）或 `ffmpeg/bin/ffmpeg`（Linux/macOS）
3. **npm 包** `@ffmpeg-installer/ffmpeg`（備用）
4. **系統 PATH**（最後備用）

**驗證 FFmpeg 路徑**：

```bash
npm run ffmpeg:check
```

**下載最新 FFmpeg**：

```bash
npm run ffmpeg:download
```

### 進程管理

**FFmpeg 進程生命週期**：

1. **啟動**：`spawn()` 創建進程
2. **監控**：監聽 `stdout`、`stderr`、`exit` 事件
3. **錯誤處理**：捕獲錯誤並發出事件
4. **停止**：
   - 先發送 `SIGTERM`（優雅停止）
   - 等待 5 秒
   - 如果未退出，發送 `SIGKILL`（強制終止）

**進程狀態追蹤**：

- 使用 `Map<streamId, processInfo>` 存儲進程信息
- 包含：進程對象、選項、輸入/輸出 URL、啟動時間

### 錯誤處理機制

**多層錯誤處理**：

1. **FFmpeg 進程錯誤**：
   - 監聽 `stderr` 輸出
   - 識別嚴重錯誤（`error initializing`、`error while opening encoder`）
   - 發出 `error` 事件

2. **MediaMTX 服務錯誤**：
   - 捕獲 API 請求錯誤
   - 清理失敗的串流
   - 推送 WebSocket 錯誤事件

3. **超時處理（精簡低延遲）**：
   - FFmpeg 進程穩定：穩定判定 800ms、最多 5s、輪詢 100ms
   - MediaMTX 路徑就緒：最多 5s、輪詢 50ms（背景執行）
   - 路徑移除：首次 1000ms / 100ms；停止時 2000ms / 150ms

---

## ✅ 總結

### 核心優勢

1. **性能提升**：
   - GPU 編碼速度提升 3-5 倍
   - CPU 使用率降低 60-80%
   - 支援更多並發串流

2. **架構靈活**：
   - 可選 GPU 編碼（向後兼容）
   - 支援多種 GPU 類型
   - 統一的 API 介面

3. **穩定性**：
   - 完整的錯誤處理機制
   - 進程生命週期管理
   - 自動重試和恢復

4. **易於維護**：
   - 清晰的服務層分離
   - 統一的代碼結構
   - 完整的日誌記錄

### 實施狀態

- ✅ **FFmpeg 服務層**：完全實施
- ✅ **GPU 編碼支援**：NVIDIA、Intel、AMD
- ✅ **API 整合**：完全整合
- ✅ **錯誤處理**：完整實施
- ✅ **進程管理**：完整實施
- ✅ **文檔**：完整文檔

### 使用建議

**生產環境**：

- ✅ 推薦使用 GPU 編碼（如果硬體支援）
- ✅ 監控 GPU 使用率和溫度
- ✅ 根據負載調整位元率和 preset

**開發/測試環境**：

- ✅ 可以使用 CPU 編碼（簡化部署）
- ✅ 測試 GPU 編碼功能

---

**最後更新**：2025-02-02

**文檔版本**：2.2（與程式碼對齊：早回傳、NVENC 參數、環境變數）

**狀態**：✅ 生產就緒
