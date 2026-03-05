# 設備 MJPEG（ISAPI）重構：全面移除 RTSP／改用 MJPEG

## 📋 文件目的與決策

**重構決策**：**全面移除**後端 RTSP／FFmpeg／MediaMTX 轉碼架構，**全面改用**設備本身提供的 ISAPI MJPEG 預覽（例如 `http://192.168.2.102/ISAPI/Streaming/channels/102/httpPreview`）。

**目標**：  
由「後端拉 RTSP → FFmpeg/MediaMTX 轉碼 → 前端播 HLS/WebRTC」改為「紀錄設備 IP + ISAPI 路徑 → 前端或後端代理直接播設備 MJPEG」，以降低後端負擔。

本文檔說明：**應保留**、**需移除**、**需新增**的項目，供重構執行對照。

---

## 1. 應保留並擴充

### 1.1 設備資料模型（`devices` 表）

| 項目 | 說明 |
|------|------|
| **保留** | `devices` 表、`device_types`、`device_models` 結構不變。 |
| **紀錄內容** | **設備 IP**（如 `192.168.2.102`）與 **ISAPI 預覽路徑**（如 `/ISAPI/Streaming/channels/102/httpPreview`）。 |
| **實作** | 使用既有 `devices.config`（JSONB）：<br>• `config.host` 或 `config.ip_address`：設備 IP<br>• `config.isapi_preview_path`：ISAPI 預覽路徑（必填）<br>• 選填：`config.username`、`config.password`、`config.port`（預設 80） |

**預覽 URL 組裝**：  
`http://{config.host}:{config.port || 80}{config.isapi_preview_path}`  
範例：`http://192.168.2.102/ISAPI/Streaming/channels/102/httpPreview`

### 1.2 設備類型與驗證（`deviceHelpers.js`）

| 項目 | 說明 |
|------|------|
| **保留** | `parseConfig`、`stringifyConfig`、`validateDeviceConfig(config, typeCode)`。 |
| **擴充** | 在 `camera` 類型之 `validateDeviceConfig` 中新增 `isapi_preview_path`（必填字串）；約定使用 `host`（與門禁一致）或 `ip_address` 其一。 |

### 1.3 門禁／ISAPI 既有邏輯

| 項目 | 說明 |
|------|------|
| **保留** | `access_control` 之 config：`host`、`username`、`password`、`port`。MJPEG 攝影機若需 Digest 可沿用。 |
| **保留** | `isapi_access_events` 表、依 `device_ip` 查詢（人流、門禁）。 |
| **保留** | `src/services/accessControl/isapiClient.js`。MJPEG 需登入時可複用做後端 proxy 或帶認證請求。 |

### 1.4 設備 API 與服務

| 項目 | 說明 |
|------|------|
| **保留** | `deviceRoutes.js`、`deviceService.js`、`deviceTypeService.js`、`deviceModelService.js`（設備 CRUD、依類型篩選）。 |
| **保留** | `websocketService` 及其與 RTSP **無關**之事件（告警、設備狀態、人流、門禁等）。 |

---

## 2. 需移除（全面 MJPEG 清單）

### 2.1 檔案：直接刪除

| 檔案 | 說明 |
|------|------|
| `src/routes/rtspRoutes.js` | RTSP API 路由。 |
| `src/services/communication/mediaMTXService.js` | MediaMTX 串流管理。 |
| `src/services/communication/ffmpegService.js` | FFmpeg GPU/CPU 編碼。 |
| `src/config/ffmpegConfig.js` | FFmpeg 參數與錯誤訊息。 |
| `src/utils/ffmpegPath.js` | FFmpeg 執行檔路徑解析。 |
| `mediamtx/mediamtx.yml` | MediaMTX 設定（若無其他服務依賴）。 |

### 2.2 主程式變更

| 位置 | 動作 |
|------|------|
| `server.js`（或 app 掛載處） | 移除 `app.use("/api/rtsp", rtspRoutes)` 及對 `rtspRoutes` 的 require。 |
| `src/services/websocket/websocketService.js` | 移除 `emitRTSPStreamStarted`、`emitRTSPStreamStopped`、`emitRTSPStreamError`、`emitRTSPStreamStatusChanged` 四個函數及其在 `module.exports` 的導出。 |
| 其餘檔案 | 若有直接 require `mediaMTXService`、`ffmpegService`、`rtspRoutes`、`ffmpegPath`、`ffmpegConfig` 之處，一併移除或改為新預覽服務。 |

### 2.3 環境變數與設定

| 項目 | 動作 |
|------|------|
| `.env` / 範例 | 移除：`MEDIAMTX_*`、`FFMPEG_PATH`、`ENABLE_GPU_ENCODING`、`GPU_*`、`RTSP_*`、`RTSP_SCALE` 等。 |
| `src/config.js` | 移除上述對應之讀取（如 `mediamtx`、`rtspUrl`、FFmpeg 相關）。 |

### 2.4 文件與腳本

| 項目 | 說明 |
|------|------|
| `docs/GPU_ACCELERATION_IMPLEMENTATION.md` | 可保留作為「舊架構說明」或標註為已棄用；或移入 `docs/archive/`。 |
| npm 腳本 | 若有 `mediamtx:start`、`ffmpeg:check`、`ffmpeg:download` 等，可移除或改為註解。 |

---

## 3. 需新增

### 3.1 預覽 URL API

| 項目 | 說明 |
|------|------|
| **端點** | `GET /api/devices/:id/preview-url`（或 `GET /api/cameras/:id/preview-url`）。 |
| **回傳** | `{ url, streamType: "mjpeg", deviceId, deviceName }`；若需認證則由後端 proxy 或回傳帶簽名/一次性 token 的 URL。 |
| **權限** | 與現行設備 API 一致（如 `authenticate` 等）。 |

### 3.2 預覽服務與驗證

| 項目 | 說明 |
|------|------|
| **預覽服務** | 新增 `src/services/devices/devicePreviewService.js`（或併入 deviceService）：依設備 ID 讀取 `config.host`、`config.isapi_preview_path`、`config.port`，組出 MJPEG URL；需認證時使用 `isapiClient` 做 proxy。 |
| **路由** | 在 `deviceRoutes.js` 新增 `GET /:id/preview-url`，或獨立路由掛在 `/api/devices`。 |
| **deviceHelpers** | camera 類型必填 `isapi_preview_path`（見 1.2）。 |

---

## 4. 設備 config 範例（MJPEG 攝影機）

```json
{
  "type": "camera",
  "host": "192.168.2.102",
  "port": 80,
  "isapi_preview_path": "/ISAPI/Streaming/channels/102/httpPreview",
  "username": "admin",
  "password": "xxxx"
}
```

- **必填**：`host`（或 `ip_address` 二擇一統一）、`isapi_preview_path`。  
- **選填**：`port`（預設 80）、`username`、`password`。  

預覽 URL：`http://192.168.2.102/ISAPI/Streaming/channels/102/httpPreview`。

---

## 5. 總結對照表（全面 MJPEG）

| 分類 | 保留 | 移除 | 新增 |
|------|------|------|------|
| **資料** | devices、config（IP + isapi_preview_path）、device_types/models、isapi_access_events | — | — |
| **驗證** | deviceHelpers（擴充 camera isapi_preview_path） | — | camera 必填 isapi_preview_path |
| **設備 API** | CRUD、列表、類型篩選 | — | GET preview-url |
| **RTSP / 轉碼** | — | rtspRoutes、mediaMTXService、ffmpegService、ffmpegConfig、ffmpegPath、mediamtx.yml、相關 env | — |
| **服務** | deviceService、isapiClient、accessControlService、websocketService（非 RTSP） | mediaMTXService、ffmpegService | devicePreviewService（或併入 deviceService） |
| **WebSocket** | 告警、設備狀態、人流、門禁 | RTSP 四個 emit 函數 | 可選：camera:preview:url 等 |
| **組態** | 伺服器、資料庫、CORS、設備相關 | MEDIAMTX_*、FFMPEG_*、GPU_*、RTSP_* | — |

依此表執行即為**全面移除 RTSP／全面改用 MJPEG** 之重構。

---

## 6. 預覽卡頓與優化

MJPEG 預覽卡頓可能來自**網路頻寬**、**設備推流負擔**、**瀏覽器解碼／繪圖**。可同時從**網頁端**與**設備端**著手。

### 6.1 網頁端已做／可做優化

| 項目 | 說明 |
|------|------|
| **可見才串流** | 監控畫面使用 IntersectionObserver：僅在**可見視窗內**的格子才掛上 `<img src="previewUrl">`，離開視窗即卸載、停止請求，減少多格同時串流造成的卡頓與頻寬消耗。 |
| **渲染優化** | 預覽容器與 MJPEG `<img>` 使用 `transform: translateZ(0)`、`backface-visibility: hidden`，提升至獨立合成層，減少主執行緒重繪、緩解卡頓。 |
| **連線數** | 同一時間僅對「可見格」建立 HTTP 連線；若為 9 格版面且僅 3 格在視窗內，實際只拉 3 路 MJPEG。 |

若仍卡頓，可再考慮：縮小預覽區尺寸（CSS）、減少同時可見格數（版面選擇）、或由後端/設備提供較低解析度或較低幀率之預覽路徑（若設備支援）。

### 6.2 設備端建議設定（需依型號支援調整）

| 項目 | 說明 |
|------|------|
| **解析度／子碼流** | 若設備支援子碼流（substream）或較低解析度之 ISAPI 路徑，可改用該路徑作為 `isapi_preview_path`，以降低位元率與瀏覽器解碼負擔。 |
| **幀率 (fps)** | 在設備 Web 介面或 ISAPI 參數中調低預覽幀率（例如 5～10 fps），可顯著減少頻寬與卡頓。 |
| **JPEG 畫質** | 若設備可調 MJPEG 的 JPEG 品質，適度調低可減小每幀大小與延遲。 |

目前預覽 URL 為固定路徑（如 `/ISAPI/Streaming/channels/102/httpPreview`）；若設備文件載明可加查詢參數（如 `?resolution=640x480`、`?fps=5`），可將該參數納入設備設定或預覽 URL 組裝邏輯，以利在不改程式前提下由使用者選擇較輕量預覽。

---

**最後更新**：2025-03-05  
**對應**：全面改用設備 ISAPI MJPEG、`GPU_ACCELERATION_IMPLEMENTATION.md` 架構棄用
