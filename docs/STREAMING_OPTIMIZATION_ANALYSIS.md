# 串流流程優化分析與處理

依據後端日誌與 MediaMTX 日誌的實際執行結果，重新審視整套流程、問題與優化方案。本文檔與 `GPU_ACCELERATION_IMPLEMENTATION.md` 互補，聚焦於優化歷程與驗證。

---

## 一、流程與日誌結果（修復 scale 後 terminals/8.txt）

```
1. POST /api/rtsp/start { rtspUrl, useGpuEncoding: true }
2. 路徑已存在 → removePath() → waitForPathRemoval(1000ms) → 超時 → 使用帶時間戳路徑
3. addPathForPublisher(pathName)
4. [FFmpeg Config] 啟用解析度縮放: 1920:1080
5. FFmpeg 輸出: 1920x1080（已套用 scale）
6. waitForPathReady → 已就緒（等待 3000ms）
7. POST /api/rtsp/start 200 6200 ms
```

修復 scale 傳入後：路徑就緒由約 4900ms 降至約 3000ms，POST 由約 8247ms 降至約 6200ms；編碼仍會短暫掉速（0.5x–0.7x）後恢復至約 1.2x。

---

## 二、日誌暴露的問題

### 1. 【已修復】FFmpeg 未套用縮放，仍輸出 2560x1440

- **現象**：FFmpeg 輸出為 `Stream #0:0: Video: h264 (Main), yuv420p(tv, bt709, progressive), 2560x1440`，與攝影機輸入同解析度。
- **原因**：`ffmpegService.startGpuEncoding()` 內將 `config` 固定為 `{ gpuType: "nvidia" }`，**未把呼叫端傳入的 `options`（含 `scale: "1920:1080"`）併入**，故 `buildNvencArgs(config)` 從未收到 `scale`，`-vf scale=1920:1080` 未加入參數。
- **影響**：1440p 編碼負擔大，編碼速度僅約 0.5x–0.7x，路徑就緒需約 5s，整體啟動約 8.2s。
- **處理**：在 `ffmpegService.js` 的 `startGpuEncoding()` 中，將 `options` 合併進 `config`（保留 `gpuType: "nvidia"`，並傳入 `scale`、`bitrate`、`preset`、`gpuIndex`），使 `scale: "1920:1080"` 實際傳給 `_buildFFmpegArgs` → `buildNvencArgs`，確保輸出為 1080p。

### 2. 路徑就緒等待約 4900ms（預期隨修復 1 改善）

- **現象**：`[MediaMTX Service] 路徑 stream_0cd71f31_1769676791130 已就緒（等待 4900ms）`，幾乎用滿 5s 上限。
- **原因**：FFmpeg 未縮放導致編碼慢，需較長時間才能產出足夠資料讓 MediaMTX 產生 HLS manifest。
- **處理**：修復 1 後編碼改為 1080p、速度預期 >1x，路徑就緒時間預期可降至約 1–2s，無需改動 `waitForPathReady` 邏輯。

### 3. 路徑移除超時後使用帶時間戳路徑（已優化）

- **現象**：`路徑 stream_0cd71f31 移除超時，使用帶時間戳路徑`。
- **原因**：MediaMTX 在約定時間內未回報路徑移除完成。
- **處理**：**已將首次路徑移除等待由 2s 改為 1s**（`waitForPathRemoval(1000, 100)`），提早改用帶時間戳路徑，縮短啟動約 1s。

### 4. FFmpeg 編碼速度過慢警告（預期隨修復 1 改善）

- **現象**：`編碼速度過慢（0.71x），會導致延遲累積。建議：1) 降低解析度（已自動縮放到 1080p） 2) 或使用 MediaMTX 直接拉取`。
- **原因**：實際未縮放，仍為 1440p 編碼，故速度 <1x。
- **處理**：修復 1 後縮放生效，速度預期 ≥1x，此警告出現頻率應明顯下降。

### 5. NVENC preset 棄用警告（已修復）

- **現象**：`[h264_nvenc] The selected preset is deprecated. Use p1 to p7 + -tune or fast/medium/slow`。
- **原因**：FFmpeg 8.0 棄用舊 preset（llhp/llhq 等），改為 P1–P7 + `-tune`。
- **處理**：**已改為 `-preset p4 -tune ll`**（`ffmpegConfig.js` NVENC 使用 p1–p7 與 `-tune ll`），消除棄用警告。

### 6. 輸入像素格式與解碼錯誤（可選）

- **現象**：`deprecated pixel format used (yuvj420p(pc))`、`error while decoding MB ... bytestream -5`、`corrupt decoded frame`。
- **原因**：攝影機輸出為 `yuvj420p(pc)`；解碼錯誤多為網路/RTSP 封包遺失或時序問題。
- **處理**：已設 `-color_range tv`、`-pix_fmt yuv420p` 輸出；解碼錯誤可透過改善網路或攝影機端設定減輕，後端可維持目前 RTSP 選項（如 TCP）。

### 7. MediaMTX「path already exists」（可觀察）

- **現象**：`[API] path already exists`（mediamtx.log 第 28–30 行）。
- **原因**：在路徑尚未自 MediaMTX 完全移除前再次 add path（例如重試或重複點擊）。
- **處理**：後端已對 409/400 與 "already exists" 做處理並改用時間戳路徑；若仍頻繁出現，可檢查前端是否重複發送 start 或後端是否在移除確認後再 add。

### 8. LL-HLS part duration 變動（iOS 相容性）

- **現象**：`part duration changed from 133ms to 134ms - this will cause an error in iOS clients`。
- **原因**：MediaMTX 依實際資料計算 part 長度，與設定之 100ms 有微小偏差。
- **處理**：屬 MediaMTX 行為，若需支援 iOS 可追蹤上游設定或版本；目前不影響一般瀏覽器播放。

---

## 三、已實施的程式變更

| 項目                            | 檔案                             | 變更                                                                                                          |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 傳入 scale/options              | `ffmpegService.js`               | `startGpuEncoding()` 的 `config` 合併 `options`（scale、bitrate、preset、gpuIndex）。                         |
| 路徑移除等待                    | `mediaMTXService.js`             | 首次路徑移除 `waitForPathRemoval(2000,150)` → `(1000,100)`，提早使用時間戳路徑。                              |
| NVENC preset                    | `ffmpegConfig.js`                | 改為 `-preset p4 -tune ll`（P1–P7），移除舊 llhp 棄用警告。                                                   |
| 速度警告條件                    | `ffmpegService.js`               | 改為「最近 5 次平均 <0.7x」才告警，避免啟動階段短暫掉速觸發。                                                 |
| 解析度可配置                    | `mediaMTXService.js`             | 支援環境變數 `RTSP_SCALE`（如 `1280:720`），預設 `1920:1080`。                                                |
| **GPU 早回傳**                  | `mediaMTXService.js`             | FFmpeg 穩定（約 0.8s）後立即回傳 API 響應；`waitForPathReady` 改為背景執行，失敗則清理並推送 WebSocket 錯誤。 |
| **前端 manifest 輪詢**          | `VideoPlayer.vue` (construction) | 取得 `hlsUrl` 後輪詢 manifest（每 300ms，最長 6s），就緒後再呼叫 `initHlsPlayer()`，縮短體感載入時間。        |
| **HLS 片段縮短（1~1.5s 目標）** | `mediamtx.yml`                   | `hlsSegmentDuration` 500ms→200ms、`hlsPartDuration` 100ms→50ms，首段更快就緒、路徑就緒時間縮短。              |
| **GOP 對齊片段**                | `ffmpegConfig.js`                | `-g` 15→6（200ms@30fps），與 MediaMTX 200ms 片段對齊，減少首 keyframe 等待。                                  |
| **位元率/預設可配置**           | `mediaMTXService.js`             | GPU 啟動時傳入 `bitrate`、`preset`；支援環境變數 `RTSP_BITRATE`/`GPU_BITRATE`、`GPU_PRESET`，API 可覆寫。     |
| **防重複 start**                | `mediaMTXService.js`             | 同一 streamId 2 秒內再次 start 直接回傳現有串流；停止/錯誤時清除 cooldown，減少 path already exists。         |
| **路徑就緒輪詢間隔**            | `mediaMTXService.js`             | `waitForPathReady` 輪詢間隔 100ms→50ms，更快偵測 HLS manifest 就緒。                                          |

效果摘要：

- Scale 生效：輸出 1920x1080，路徑就緒約 3s，POST 約 6.2s（較修復前 8.2s 改善）。
- 路徑移除 1s 即切時間戳路徑，可再省約 1s。
- 欲進一步加速編碼可設 `RTSP_SCALE=1280:720`。
- **早回傳**：GPU 串流 API 約 0.8s 即回傳，前端可立即拿到 `hlsUrl` 並輪詢 manifest；路徑就緒改為背景檢查，失敗時透過 WebSocket 通知前端。
- **1~1.5s 目標**：200ms 片段 + GOP 6，路徑就緒與播放延遲可降至約 1~1.5s；若需次秒級請改用 WebRTC（`webrtcUrl`）。

---

## 四、建議驗證步驟

1. 重啟後端，以 `useGpuEncoding: true` 呼叫 POST /api/rtsp/start。
2. 日誌應有：`[FFmpeg Config] 啟用解析度縮放: 1920:1080`（或 `RTSP_SCALE` 設定值）、FFmpeg 輸出 `1920x1080`、無 NVENC preset 棄用警告。
3. 早回傳：POST /api/rtsp/start 約 0.8–1s 即 200；路徑就緒（背景）：`已就緒（等待 XXXms）` 目標約 1–1.5s（200ms 片段 + GOP 6 下）。

## 五、環境變數（可選）

- **RTSP_SCALE**：輸出解析度，格式 `寬:高`，例如 `1920:1080`（預設）、`1280:720`（更低延遲）。無效值時使用 1920:1080。
- **RTSP_BITRATE** / **GPU_BITRATE**：FFmpeg 輸出位元率，例如 `2M`、`4M`。API 請求可覆寫。無效值時使用 2M。
- **GPU_PRESET**：NVIDIA 編碼預設（p1–p7），例如 `p4`（平衡）、`p5`（低延遲）。無效值時使用 p4。

## 六、架構：早回傳與延遲說明

- **問題**：前端體感延遲 ≈ 後端 API 等待時間（原約 3s）+ HLS 路徑就緒（原約 3s）+ HLS 播放緩衝，合計曾達 4~4.5s。
- **後端早回傳**：GPU 路徑在 FFmpeg 穩定（約 0.8s）後即回傳 `streamId`、`hlsUrl`、`webrtcUrl`；`waitForPathReady` 改為背景執行。若路徑未就緒則清理並透過 WebSocket 推送 `rtsp:stream:error`。
- **前端**：收到 API 響應後輪詢 HLS manifest URL（每 300ms，最長 6s），manifest 可訪問後再 `initHlsPlayer()`，避免「先等 3s 再開始載入」的體感。
- **1~1.5s 目標**：MediaMTX 改為 200ms 片段、50ms part，FFmpeg GOP 改為 6（200ms@30fps），首段更快產出 → 路徑就緒時間可從約 3s 降至約 1~1.5s，整體玻璃到玻璃延遲趨近 1~1.5s。若實測仍高，可再試 `RTSP_SCALE=1280:720` 減輕編碼負擔。
- **次秒級延遲**：要穩定低於 1s 請改用 **WebRTC**：後端已回傳 `webrtcUrl`，前端改為使用 WebRTC 播放器（如 `mediamtx` 官方前端範例或 `rtsp-simple-proxy` 的 WebRTC 客戶端），可達約 0.2~0.5s 延遲。

## 七、碼流與網速對延遲的影響

- **碼流 (Bitrate)**：目前 FFmpeg 輸出約 2000 kb/s，200ms 片段約 50 kB。碼流越高、同長度片段越大，下載時間越長；若網路頻寬不足，區段無法在播放前下載完成，會造成緩衝與延遲上升。在弱網或多路串流時可考慮降低碼流（如 `RTSP_SCALE=1280:720` 或未來支援可配置 bitrate）。
- **網速 (Network)**：DevTools 網路分頁中，多數 HLS 請求在數十毫秒內完成屬正常；若「時間」欄位持續偏高，表示網路延遲或擁塞，會直接拉長填滿緩衝的時間、增加體感延遲。出現 800ms+ 的「已取消」m3u8 請求多為 LL-HLS 的 blocking 輪詢（播放器請求未來片段、伺服器掛起直到就緒），若播放器隨後追趕直播而取消屬正常，不需視為錯誤。
- **結論**：碼流與網速都會影響延遲；目前 2M/1080p 在區網下通常足夠，實際部署時可依網路條件與多路數評估是否降解析度或碼流。

## 八、可再優化項目

| 項目                    | 說明                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端 manifest 輪詢間隔  | 目前 300ms；可改為 200ms 以略提早偵測到 manifest 就緒，邊際效益有限。                                                                                           |
| HLS.js 緩衝與同步       | 已設 `liveSyncDurationCount: 0.1`、`maxBufferLength: 0.2` 等極低延遲參數；可依實測微調 `TARGET_LATENCY` / `MAX_LATENCY`，過於激進在弱網下易卡頓。               |
| 碼流/解析度可配置       | 後端已支援 `RTSP_SCALE`、`RTSP_BITRATE`/`GPU_BITRATE`、`GPU_PRESET`（環境變數或 API）；弱網可設較低 bitrate 或 1280x720。                                       |
| deprecated pixel format | FFmpeg 日誌中 `deprecated pixel format used (yuvj420p)` 來自攝影機輸出；已設 `-color_range tv -pix_fmt yuv420p`，若仍出現可檢查輸入端或忽略（對延遲影響極小）。 |
| WebRTC                  | 若要穩定次秒級延遲，改用後端已提供的 `webrtcUrl` 與 WebRTC 播放器為最有效方案。                                                                                 |

## 九、後續可選

- 後端已加防重複 start：同一 streamId 在 2 秒內再次 start 則直接回傳現有串流，減少「path already exists」；前端仍可避免短時間內重複點擊。
- iOS LL-HLS：若需支援 iOS，再調整 MediaMTX part duration 或版本。
- HLS 輪詢：若前端與 HLS 服務不同源，需在 MediaMTX 或反向代理啟用 CORS，否則 manifest 輪詢會失敗，前端會顯示「HLS 清單尚未就緒」。

---

---

## 十、影像處理架構速覽

```
攝像頭 (RTSP) → FFmpeg GPU 編碼（可選）→ MediaMTX → HLS/WebRTC → 前端播放器
                    ↑
             ffmpegService.js
             ffmpegConfig.js
```

- **ffmpegService.js**：GPU 編碼進程管理、參數組裝、速度監控
- **mediaMTXService.js**：路徑管理、早回傳、背景就緒檢查
- **ffmpegConfig.js**：NVENC/QSV/AMF 參數、scale、錯誤判定
- **mediamtx.yml**：hlsSegmentDuration 200ms、hlsPartDuration 50ms、GOP 對齊

---

**文件版本**：1.6  
**最後更新**：2025-02-02  
**對應**：與現有程式碼（ffmpegService、mediaMTXService、ffmpegConfig、mediamtx.yml）一致
