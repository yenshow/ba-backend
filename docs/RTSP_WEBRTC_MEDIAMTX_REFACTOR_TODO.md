# RTSP + WebRTC（MediaMTX）重構：代辦事項清單

**目的**：解決 MJPEG（ISAPI httpPreview）在設備端常見的「同時連線數限制／頻繁重連 403／多視窗多人同看不穩」問題，改以 **RTSP ingest + WebRTC 分發**（MediaMTX）作為監控主方案。

**範圍**：後端（ba-backend）＋前端（ba-frontend-construction、ba-frontend-central）＋ MediaMTX 部署。

---

## 最理想架構（可調整設備時之建議）

在**可調整攝影機設定**的前提下，建議採用以下單一清晰架構，避免後端轉碼、延遲與資源成本最低。

### 架構總覽

```
[攝影機] --RTSP(H.264)--→ [MediaMTX] --WebRTC--→ [瀏覽器 × N]
                               ↑
                         [ba-backend] 只做 path 生命週期（start/stop）、回傳 webrtcUrl
```

- **每台攝影機**：對外只暴露 **1 條 RTSP**；無論多少人在看，設備端只有這 1 條連線。
- **MediaMTX**：每路 RTSP 對應一個 path；對 N 個觀眾送出 N 條 WebRTC 下行，**不經後端轉碼**。
- **後端**：不轉碼、不 proxy 影像；只負責「依 deviceId 讀取 rtsp_url → 呼叫 MediaMTX API 增刪 path → 回傳 webrtcUrl」。

### 設備端（攝影機）最佳設定

| 項目 | 建議 | 說明 |
|------|------|------|
| **協定** | RTSP | 業界標準、MediaMTX 原生支援，一拉多發。 |
| **視訊編碼** | **H.264** | 瀏覽器 WebRTC 普遍支援，**無需後端轉碼**；若設備僅 H.265，需在設備改為 H.264 或接受 FFmpeg 轉碼。 |
| **碼流** | **子碼流（substream）** | 較低解析度/幀率，省頻寬、延遲更低，多格同看更穩。主碼流留給錄影或單格全螢幕。 |
| **每台對外連線** | 1 條 RTSP URL | 由 MediaMTX 拉這一條，再分發給所有觀眾。 |

設備只需提供一組 **RTSP URL**（含帳密或由後端組 URL），例如：  
`rtsp://admin:xxx@192.168.2.102:554/Streaming/Channels/102`（子碼流、H.264）。

### 後端角色（精簡）

- 儲存 camera 的 **rtsp_url**（或 host + path + username/password）。
- 提供 **stream 生命週期 API**：start → 呼叫 MediaMTX 加 path → 回傳 **webrtcUrl**；stop → 移除 path。
- **不**做影像 proxy、**不**做轉碼（理想狀況下設備已 H.264）。

### 前端角色

- 加入監控畫面時：呼叫 start API → 取得 **webrtcUrl** → 用 **WebRTC**（`RTCPeerConnection`）連到 MediaMTX → `<video>` 播放。
- 同一台攝影機多格／多用戶：同一 webrtcUrl，各自建立 peer connection；**不會**對設備重複拉 RTSP。
- 可做 **reference counting**：同一 deviceId 被多格引用時只 start 一次，全部移除再 stop。

### 小結：最佳改善要點（精華清單）

1. **設備**：改為 **RTSP、H.264、建議子碼流**，每台一組 URL。
2. **MediaMTX**：獨立服務，RTSP ingest + WebRTC egress；後端只透過 API 管理 path。
3. **後端**：只做「deviceId → rtsp_url → MediaMTX path → webrtcUrl」；不轉碼、不 proxy 影像。
4. **前端**：單一播放路徑「WebRTC + webrtcUrl」；多視窗／多用戶同看同一路不重複向設備要流。
5. **延遲**：目標 **&lt;1s**；不需 HLS（除非另做錄影/回放）。
6. **備援**：若某設備無法改 H.264，再考慮該路單獨走 FFmpeg 轉碼或保留 MJPEG fallback。

---

## 影像呈現優化建議

### 幀數（FPS）

- **由攝影機端決定**，前端與 MediaMTX 僅轉發，無法「調高」幀數。
- **多格監控**：建議攝影機子碼流設 **15～25 fps**（流暢與頻寬平衡）；解析度例如 640×360 或 720p。
- **單格全螢幕**：可用主碼流 **25/30 fps**、較高解析度。
- 在攝影機 Web 介面或 NVR 中調整「幀率／Frame rate」即可。

### GPU

- **瀏覽器**：Chrome / Edge 等會自動用 **硬體解碼**（GPU）播放 H.264，無需額外設定。
- **後端／MediaMTX**：目前為 **H.264 直通**（不轉碼），不需伺服器端 GPU。若日後改為 H.265 輸入且需轉 H.264，再考慮 FFmpeg + NVENC／QSV／VAAPI。
- **前端**：已對 `<video>` 容器使用 `transform: translateZ(0)` 以利合成層加速。

### 前端可做優化

- **可見才播**：已用 `IntersectionObserver`，格子不在視窗內時不掛載播放器，減少同時解碼路數與頻寬。
- **分頁隱藏時暫停**：分頁不可見時暫停 `<video>`，可省 CPU／電量（已實作於 VideoPlayer）。
- **多格時**：優先使用子碼流 URL，避免單機解碼過多高解析度流。

### MediaMTX 參數（可選微調）

- `readTimeout` / `writeTimeout`：預設 10s，網路不穩可略增。
- `writeQueueSize`：預設 256，延遲與穩定性取捨；已偏低延遲。
- 其餘保持現有低延遲設定即可。

---

## 0. 決策與前置盤點

- [ ] **確認目標延遲**：期望 \(<1s\) 還是 \(2–5s\) 可接受（影響是否保留 HLS/LL-HLS）。
- [ ] **確認同看規模**：單台攝影機同時最大觀看者（影響 TURN、頻寬與資源規劃）。
- [ ] **確認攝影機編碼**：
  - [ ] 設備是否可輸出 **H264**（優先走設備設定）
  - [ ] 若多為 **H265**：是否接受 **FFmpeg 轉碼**（成本較高但最穩）
- [ ] **盤點既有實作可復用**（git 歷史）：
  - [ ] `6892f77`：`src/routes/rtspRoutes.js`、`src/services/communication/mediaMTXService.js`（舊版串流 API 與 MediaMTX 管理）
  - [ ] `7b6ecef` / `f18ce91`：FFmpeg/GPU 相關（若需要 H265 → H264）

---

## 1. MediaMTX 部署與設定（基礎設施）

### 1.1 服務啟動方式（Docker / Service）

- [ ] 建立 MediaMTX 服務（建議 Docker Compose）：
  - [ ] 啟用 RTSP ingest（從設備拉流）
  - [ ] 啟用 WebRTC egress（瀏覽器播放）
  - [ ] 啟用 API（後端用來 add/remove paths、查狀態）

### 1.2 網路與防火牆

- [ ] 開放必要端口（依 MediaMTX 配置）：
  - [ ] API（例如 `9997`）
  - [ ] WebRTC HTTP（例如 `8889`）
  - [ ] WebRTC UDP port range（ICE/DTLS/SRTP）
- [ ] 設定 STUN/TURN 策略：
  - [ ] 同網段可先只用 STUN（或甚至不需要 TURN）
  - [ ] 跨網段／手機網路／複雜 NAT：規劃 TURN（避免連不上）

### 1.3 配置檔（mediamtx.yml）

- [ ] 建立/回復 `mediamtx.yml`（以舊版為參考，但以 WebRTC 為主）
- [ ] 設定 WebRTC ICE / candidates（必要時指定 public ip）
- [ ]（可選）若仍需要 HLS：才加上 HLS/LL-HLS 參數

---

## 2. 後端（ba-backend）重構代辦

### 2.1 Camera 設備資料（devices.config）

- [x] 決定 camera config 需要的欄位（以 RTSP 為主）：
  - [x] `config.rtsp_url`（必填，須以 `rtsp://` 開頭）
  - [ ]（可選）`config.username` / `config.password`（若不想把帳密放進 rtsp_url）
  - [ ]（可選）`config.stream_profile`（主碼流/子碼流）
  - [ ]（可選）`config.prefer_codec`（H264 優先）
- [x] 更新 `validateDeviceConfig`（camera 類型）符合新約束（`src/utils/deviceHelpers.js`）
- [x] 既有 MJPEG 欄位（`isapi_preview_path`）：保留作 fallback（可選填）

### 2.2 串流 API（以 deviceId 為主）

> 目標：API 從 DB 讀取 device config 取得 rtsp_url，避免前端傳入不可信 URL。已實作於 `src/routes/deviceRoutes.js`。

- [x] 新增路由（掛在 `/api/devices`）：
  - [x] `POST /api/devices/:id/stream/start`
  - [x] `POST /api/devices/:id/stream/stop`
  - [x] `GET /api/devices/:id/stream/status`
  - [ ]（可選）`POST /api/devices/stream/start-batch`
- [x] 回傳資料格式（start）：`streamId`、`pathName`、`webrtcUrl`、`hlsUrl`、`status`

### 2.3 MediaMTX 管理服務（Service Layer）

- [x] 實作 `mediaMTXService`（`src/services/communication/mediaMTXService.js`）：
  - [x] `addPath(pathName, rtspUrl)` / `removePath(pathName)` / `listPaths()`
  - [x] `pathNameFromDeviceId(deviceId)`、匯出 `WEBRTC_BASE`
- [x] 實作 `deviceStreamService`（`src/services/devices/deviceStreamService.js`）：`startStream(deviceId)`、`stopStream(deviceId)`、`getStreamStatus(deviceId)`
- [ ]（可選）路徑就緒檢查與 cache／輪詢（降低 API 壓力）

### 2.4 H265 → H264（若需要）

- [ ] 優先：文件化「設備端改輸出 H264」設定方式（各品牌不同）
- [ ] fallback：引入 FFmpeg 轉碼 pipeline（若設備只能 H265）：
  - [ ] RTSP(H265) → FFmpeg(H264) → 推到 MediaMTX ingest
  - [ ] GPU/CPU 策略（NVENC/QSV/VAAPI/純 CPU）
  - [ ] 轉碼資源上限與排程（避免後端被打爆）

### 2.5 權限與濫用防護

- [ ] 對 start/stop API 做 RBAC/限流：
  - [ ] 同一 device 在短時間內不要重複 start（idempotent）
  - [ ] 大量 camera start-batch 要有上限

---

## 3. 前端重構代辦（construction / central 同步）

### 3.1 Types 與資料結構

- [ ] `CameraDeviceConfig` 改為支援 RTSP 欄位（至少 `rtsp_url` 或 host+username+password 組 RTSP）
- [ ] `MonitorView` 改為串流資訊（WebRTC）：
  - [ ] `streamId`
  - [ ] `webrtcUrl`（或 whepUrl）
  - [ ] `status`

### 3.2 API Composables

- [ ] `useSurveillanceApi`：
  - [ ] `startCameraStream(deviceId)`
  - [ ] `stopCameraStream(deviceId)`
  - [ ] `getCameraStreamStatus(deviceId)`（或批次 status）
- [ ] `useStreamStatus`（統一狀態管理）：
  - [ ] add view 時啟動串流並拿到 webrtcUrl
  - [ ] remove view 時停止串流（需 reference counting，避免同台被多格引用就誤停）

### 3.3 播放器（VideoPlayer）

- [ ] 改為 WebRTC 播放：
  - [ ] `<video autoplay playsinline muted>`（可選是否 muted）
  - [ ] 建立 `RTCPeerConnection`、ICE、SDP exchange（依 MediaMTX 提供方式）
- [ ] 視窗可見性優化：
  - [ ] IntersectionObserver：不可見時暫停/關閉下行，避免浪費

### 3.4 UI / UX

- [ ] 控制面板：
  - [ ] 重新載入（刷新攝影機/串流狀態）
  - [ ]（可選）全部啟動/停止（監控牆）
- [ ] 錯誤呈現：
  - [ ] 顯示 ICE 連線失敗、codec 不支援、權限不足等

---

## 4. 驗收（Done Definition）

- [ ] **單一攝影機**：同時開 1/4/9 格（同一台重複）不會造成設備端 403（只會有 1 upstream）。
- [ ] **多視窗/多用戶**：同台同看可穩定播放，不會頻繁掉線。
- [ ] **重整頁面**：可快速恢復播放（不需手動清除緩存）。
- [ ] **壓力測試**：N 台攝影機 × M viewers 下，CPU/記憶體/頻寬在可接受範圍。
- [ ] **安全**：非管理員不可隨意 start/stop；有 rate limit/保護。

---

## 5. 風險與備援

- **H265 相容性**：若設備輸出 H265，瀏覽器 WebRTC 可能無法播 → 需設備改 H264 或 FFmpeg 轉碼。
- **TURN 需求**：跨網段/行動網路若無 TURN，WebRTC 可能連不上。
- **資源成本**：大量同看若需要轉碼，資源成本上升（GPU/CPU）。
- **備援策略**（可選）：
  - 若 WebRTC 失敗，可回退到 MJPEG（僅少量用戶）或 HLS（高延遲但穩）。
