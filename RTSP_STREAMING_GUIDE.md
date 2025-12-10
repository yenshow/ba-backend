# RTSP 串流完整指南

## 📋 目錄

1. [概述](#概述)
2. [架構說明](#架構說明)
3. [API 端點](#api-端點)
4. [使用方式](#使用方式)
5. [GPU 硬體加速](#gpu-硬體加速)
6. [低延遲配置](#低延遲配置)
7. [故障排除](#故障排除)
8. [性能優化](#性能優化)

---

## 概述

本系統實現了將 RTSP 串流轉換為 HLS (HTTP Live Streaming) 格式，讓前端網頁可以播放 RTSP 視頻串流。系統支持自動 GPU 硬體加速（macOS/Windows/Linux），目標延遲約 **1-2 秒**（使用 GPU 加速）或 **2-4 秒**（軟體編碼）。

### 主要特性

- ✅ 自動 GPU 硬體加速檢測（macOS/Windows/Linux）
- ✅ 低延遲串流（1-2 秒延遲）
- ✅ 多串流並發支持
- ✅ 自動錯誤恢復
- ✅ 跨平台支持

---

## 架構說明

### 後端

- **服務**: `src/services/rtspStreamService.js` - 使用 ffmpeg 將 RTSP 轉換為 HLS，支持 GPU 加速
- **路由**: `src/routes/rtspRoutes.js` - 提供 RESTful API 端點
- **靜態文件**: `public/hls/` - 存儲 HLS 文件（playlist.m3u8 和 .ts 片段）

### 前端

- **Composable**: `app/composables/useRtsp.ts` - RTSP API 封裝
- **組件**: `app/components/rtsp/VideoPlayer.vue` - 視頻播放器組件（支持 HLS）
- **頁面**: `app/pages/rtsp.vue` - 示例頁面

### 文件結構

```
public/
  hls/
    {streamId}/
      playlist.m3u8
      segment_000.ts
      segment_001.ts
      ...
```

---

## API 端點

### 啟動串流

```http
POST /api/rtsp/start
Content-Type: application/json

{
  "rtspUrl": "rtsp://admin:password@192.168.1.100:554/stream"
}
```

**回應**:

```json
{
	"error": false,
	"data": {
		"streamId": "abc123...",
		"rtspUrl": "rtsp://admin:password@192.168.1.100:554/stream",
		"hlsUrl": "/hls/abc123.../playlist.m3u8",
		"status": "running"
	},
	"message": "串流已啟動"
}
```

### 停止串流

```http
POST /api/rtsp/stop/:streamId
```

### 獲取所有串流狀態

```http
GET /api/rtsp/status
```

### 獲取指定串流狀態

```http
GET /api/rtsp/status/:streamId
```

---

## 使用方式

### 前端使用 VideoPlayer 組件

```vue
<template>
	<RtspVideoPlayer :rtsp-url="rtspUrl" :hls-url="hlsUrl" :stream-id="streamId" :auto-start="true" />
</template>

<script setup>
const rtspUrl = ref("rtsp://admin:password@192.168.1.100:554/stream");
const hlsUrl = ref("");
const streamId = ref("");
</script>
```

### 使用 Composable

```typescript
const rtspApi = useRtspApi();

// 啟動串流
const streamInfo = await rtspApi.startStream("rtsp://...");

// 停止串流
await rtspApi.stopStream(streamInfo.streamId);

// 獲取所有串流狀態
const streams = await rtspApi.getAllStreamStatus();

// 獲取指定串流狀態
const stream = await rtspApi.getStreamStatus(streamId);
```

---

## GPU 硬體加速

系統會自動檢測並使用可用的 GPU 硬體加速編碼器，顯著降低延遲和 CPU 使用率。

### 支持的平台和編碼器

#### macOS (VideoToolbox) ✅

- **編碼器**: `h264_videotoolbox`
- **優勢**:
  - 延遲降低約 30-50%
  - CPU 使用率降低 60-80%
  - 更好的實時性能
- **自動啟用**: 系統會自動檢測並使用

#### Windows (NVENC/QSV) ✅

- **NVENC**: NVIDIA 顯卡（自動檢測並優先使用）
  - 編碼器: `h264_nvenc`
  - 需要: NVIDIA 顯卡和最新驅動
- **QSV**: Intel 集成顯卡（NVENC 不可用時使用）
  - 編碼器: `h264_qsv`
  - 需要: Intel 處理器（第 4 代或更新）和相應驅動

#### Linux (NVENC/VAAPI) ✅

- **NVENC**: NVIDIA 獨立顯卡
- **VAAPI**: Intel/AMD 集成顯卡

### 檢測機制

系統會在首次啟動串流時自動檢測：

1. 執行 `ffmpeg -encoders` 檢查可用編碼器
2. 根據平台和可用編碼器選擇最佳選項
3. 緩存檢測結果，避免重複檢測
4. 如果檢測失敗，自動回退到軟體編碼

### 檢查硬體加速是否啟用

查看後端日誌，應該看到：

**macOS:**

```
[RTSP Stream] 檢測到 macOS VideoToolbox 硬體加速
[RTSP Stream] 使用編碼器: h264_videotoolbox (VideoToolbox 硬體加速)
```

**Windows (NVIDIA):**

```
[RTSP Stream] 檢測到 NVIDIA NVENC 硬體加速
[RTSP Stream] 使用編碼器: h264_nvenc (NVENC 硬體加速)
```

**Windows (Intel):**

```
[RTSP Stream] 檢測到 Intel QSV 硬體加速
[RTSP Stream] 使用編碼器: h264_qsv (QSV 硬體加速)
```

**手動檢查可用編碼器**:

```bash
ffmpeg -encoders | grep -i "nvenc\|qsv\|videotoolbox\|vaapi"
```

---

## 低延遲配置

### 後端配置（ffmpeg）

#### 當前配置（已優化）

- **片段時長**: 1 秒 (`-hls_time 1`)
- **保留片段**: 3 個 (`-hls_list_size 3`) - 約 3 秒緩衝
- **禁用緩存**: `-hls_allow_cache 0`
- **獨立片段**: `-hls_flags independent_segments`

#### GPU 編碼器參數

**VideoToolbox (macOS)**:

- `-allow_sw 1` - 允許軟體回退
- `-realtime 1` - 實時編碼模式

**NVENC (NVIDIA)**:

- `-preset p1` - 最快預設（最低延遲）
- `-tune ll` - 低延遲模式
- `-rc cbr` - 恆定比特率

**QSV (Intel)**:

- `-preset veryfast` - QSV 預設選項
- `-global_quality 23` - 品質參數（18-28）

**軟體編碼（回退）**:

- `-preset ultrafast` - 最快編碼預設
- `-tune zerolatency` - 零延遲調優
- `-g 30` - GOP 大小（關鍵幀間隔）

### 前端配置（hls.js）

```javascript
{
  lowLatencyMode: true,
  backBufferLength: 0,        // 禁用後緩衝
  maxBufferLength: 3,         // 最大緩衝 3 秒
  maxMaxBufferLength: 5,      // 最大緩衝上限 5 秒
  maxBufferSize: 3 * 1000 * 1000, // 最大緩衝大小 3MB
  maxFragLoadingTimeOut: 2000,    // 片段加載超時 2 秒
  fragLoadingTimeOut: 2000,
  manifestLoadingTimeOut: 2000,
  levelLoadingTimeOut: 2000
}
```

### 延遲組成

1. **RTSP 源延遲**: 取決於攝像頭/設備（通常 0.5-1 秒）
2. **ffmpeg 編碼延遲**:
   - GPU 加速: 約 0.3-0.5 秒
   - 軟體編碼: 約 0.5-1 秒
3. **HLS 片段生成**: 1 秒（等待第一個片段完成）
4. **瀏覽器緩衝**: 1-2 秒（低延遲模式）

**總延遲**:

- **GPU 加速**: 約 **1-2 秒**
- **軟體編碼**: 約 **2-4 秒**

---

## 故障排除

### 1. ERR_CONNECTION_REFUSED 錯誤

**錯誤訊息**:

```
POST http://192.168.10.124:4000/api/rtsp/start net::ERR_CONNECTION_REFUSED
```

**解決方法**:

1. **確認後端服務器正在運行**:

   ```bash
   cd /Users/caijunyao/Desktop/ba-backend
   npm run dev
   ```

2. **檢查服務器是否監聽正確的端口**:

   ```bash
   lsof -i :4000  # macOS/Linux
   netstat -ano | findstr :4000  # Windows
   ```

3. **測試 API 連接**:

   ```bash
   node scripts/testRtspApi.js 192.168.10.124
   ```

4. **檢查前端配置**:
   確認 `ba-frontend/.env` 文件中的 `NUXT_PUBLIC_API_BASE` 配置正確：

   ```env
   NUXT_PUBLIC_API_BASE=http://192.168.10.124:4000/api
   ```

5. **重啟前端開發服務器**

### 2. 串流無法啟動

**可能原因**:

- RTSP URL 格式不正確
- RTSP 服務器不可訪問
- ffmpeg 未正確安裝

**解決方法**:

1. **驗證 RTSP URL 格式**:

   ```
   rtsp://[用戶名]:[密碼]@[IP]:[端口]/[路徑]
   ```

2. **測試 RTSP 連接**:

   ```bash
   ffmpeg -rtsp_transport tcp -i "rtsp://admin:password@192.168.1.100:554/stream" -t 5 -f null -
   ```

3. **檢查後端日誌**: 查看後端控制台輸出，尋找 ffmpeg 錯誤訊息

### 3. 視頻無法播放

**可能原因**:

- HLS 文件未生成
- 瀏覽器不支持 HLS
- CORS 問題
- video 元素未正確渲染

**解決方法**:

1. **檢查 HLS 文件是否存在**:
   訪問 `http://192.168.10.124:4000/hls/{streamId}/playlist.m3u8`
   應該能看到 m3u8 文件內容

2. **檢查瀏覽器控制台**:
   打開瀏覽器開發者工具，查看 Console 和 Network 標籤

3. **確認 hls.js 已安裝**:

   ```bash
   cd /Users/caijunyao/Desktop/ba-frontend
   npm list hls.js
   ```

4. **檢查 video 元素**: 查看控制台是否有 "video 元素未能及時渲染" 錯誤

### 4. 硬體加速未啟用

**檢查步驟**:

1. **檢查系統是否支持**:

   - macOS: 自動支持 VideoToolbox
   - Windows: 需要 NVIDIA 顯卡（NVENC）或 Intel 處理器（QSV）
   - Linux: 需要支持 VAAPI 的顯卡

2. **檢查驅動程序**:

   - Windows (NVENC): 確保安裝了最新的 NVIDIA 驅動
   - Windows (QSV): 確保 Intel 顯卡驅動已安裝
   - Linux (VAAPI): 確保安裝了相應的驅動和庫

3. **查看後端日誌**: 啟動串流時會顯示檢測到的編碼器

4. **手動檢查可用編碼器**:
   ```bash
   ffmpeg -encoders | grep -i "nvenc\|qsv\|videotoolbox\|vaapi"
   ```

### 5. 延遲過高

**解決方法**:

1. **確認 GPU 加速已啟用**: 查看後端日誌
2. **檢查 RTSP 源本身的延遲**: 可能是攝像頭延遲
3. **檢查網路狀況**: 網路延遲會影響總延遲
4. **調整 HLS 參數**（不推薦，會增加負載）:
   - `-hls_time 0.5` - 片段時長 0.5 秒
   - `-hls_list_size 2` - 只保留 2 個片段

### 6. 播放卡頓

**解決方法**:

1. **增加緩衝區大小**（在 `VideoPlayer.vue` 中）:

   ```javascript
   maxBufferLength: 5; // 從 3 增加到 5
   ```

2. **檢查網路帶寬**: 確保網路速度足夠

3. **檢查服務器資源**: CPU/GPU 使用率是否過高

---

## 性能優化

### 性能對比

#### CPU 編碼 (libx264)

- **延遲**: 約 2-4 秒
- **CPU 使用率**: 高（單核心 50-100%）
- **品質**: 優秀
- **適用場景**: 低並發、高品質需求

#### GPU 編碼 (VideoToolbox/NVENC/QSV)

- **延遲**: 約 1-2 秒（降低 30-50%）
- **CPU 使用率**: 低（降低 60-80%）
- **品質**: 良好（略低於 CPU 編碼）
- **適用場景**: 高並發、低延遲需求

### 監控和調試

#### 檢查編碼性能

```bash
# 查看 ffmpeg 進程的 CPU 使用率
top -pid $(pgrep -f "ffmpeg.*rtsp")  # macOS/Linux
tasklist | findstr ffmpeg  # Windows

# 查看 GPU 使用率（macOS）
sudo powermetrics --samplers gpu_power -i 1000

# 查看 GPU 使用率（Windows - NVIDIA）
nvidia-smi
```

#### 測試延遲

1. 記錄 RTSP 源的時間戳（如果可能）
2. 記錄瀏覽器播放的時間戳
3. 計算差值

### 進一步降低延遲的方法

#### 方法 A: 降低片段時長（不推薦）

```javascript
"-hls_time", "0.5"; // 0.5 秒片段
"-hls_list_size", "2"; // 只保留 2 個片段
```

**風險**: 會大幅增加服務器負載和網路請求頻率

#### 方法 B: 使用 LL-HLS (Low Latency HLS)

需要支持 LL-HLS 的播放器（hls.js 支持）

```javascript
"-hls_flags", "delete_segments+independent_segments+program_date_time";
"-hls_playlist_type", "event";
```

#### 方法 C: 使用 WebRTC（最低延遲，約 0.5-1 秒）

需要額外實現：

- 使用 `mediasoup` 或 `Kurento` 等 WebRTC 服務器
- 將 RTSP 轉換為 WebRTC 流
- 前端使用 WebRTC API 接收

---

## 環境變數配置

### 後端 (.env)

```env
HOST=0.0.0.0
PORT=4000
```

### 前端 (.env)

```env
NUXT_PUBLIC_API_BASE=http://192.168.10.124:4000/api
NUXT_PUBLIC_MODBUS_TIMEOUT=5000
```

**注意**: 將 `192.168.10.124` 替換為您的實際後端服務器 IP 地址

---

## 技術細節

### HLS 轉換參數

- **片段時長**: 1 秒 (`-hls_time 1`)
- **保留片段數**: 3 個 (`-hls_list_size 3`)
- **視頻編碼**: H.264（自動選擇 GPU 或 CPU 編碼器）
- **音頻編碼**: AAC (`-c:a aac`)
- **傳輸協議**: TCP (`-rtsp_transport tcp`)

### 瀏覽器支持

- **Safari**: 原生支持 HLS
- **Chrome/Firefox/Edge**: 使用 hls.js 庫

### 注意事項

1. **ffmpeg 依賴**: 確保系統已安裝 ffmpeg，後端使用 `@ffmpeg-installer/ffmpeg` 自動安裝
2. **網路延遲**: RTSP 轉 HLS 會有約 1-4 秒的延遲（取決於是否使用 GPU 加速）
3. **資源消耗**: 每個串流會持續運行 ffmpeg 進程，注意服務器資源
4. **文件清理**: HLS 片段會自動刪除舊文件，但停止串流後不會自動清理目錄
5. **CORS**: HLS 文件已設置 CORS 頭，允許跨域訪問

---

## 範例 RTSP URL

```
rtsp://admin:Aa83124007@192.168.2.103:554/Streaming/Channels/101
```

格式: `rtsp://[用戶名]:[密碼]@[IP]:[端口]/[路徑]`

---

## 快速診斷步驟

1. **檢查後端服務器**:

   ```bash
   curl http://localhost:4000/api/rtsp/status
   ```

2. **檢查前端配置**:

   ```bash
   cd /Users/caijunyao/Desktop/ba-frontend
   cat .env | grep NUXT_PUBLIC_API_BASE
   ```

3. **測試完整流程**:

   ```bash
   cd /Users/caijunyao/Desktop/ba-backend
   node scripts/testRtspApi.js 192.168.10.124
   ```

4. **檢查網路連接**:
   ```bash
   ping 192.168.10.124
   ```

---

## 參考資料

- [FFmpeg HLS 文檔](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- [FFmpeg 硬體加速文檔](https://trac.ffmpeg.org/wiki/HWAccelIntro)
- [hls.js 低延遲配置](https://github.com/video-dev/hls.js/blob/master/docs/API.md#lowlatencymode)
- [HLS 低延遲最佳實踐](https://developer.apple.com/documentation/http_live_streaming/hls_authoring_specification_for_apple_devices)
- [WebRTC 實時串流](https://webrtc.org/)
