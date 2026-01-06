# 前後端影像處理完整分析

## 📋 目錄

1. [系統架構概覽](#系統架構概覽)
2. [後端影像處理](#後端影像處理)
3. [前端影像處理](#前端影像處理)
4. [MediaMTX 服務配置](#mediamtx-服務配置)
5. [編解碼器處理](#編解碼器處理)
6. [延遲優化機制](#延遲優化機制)
7. [錯誤處理與重試機制](#錯誤處理與重試機制)
8. [WebSocket 實時通知](#websocket-實時通知)
9. [性能優化策略](#性能優化策略)
10. [總結與建議](#總結與建議)

---

## 系統架構概覽

### 完整影像處理流程

```
攝影機 (RTSP 串流)
    ↓
[後端] RTSP Routes API (端口 4000)
    ↓
[後端] RTSP Stream Service (封裝層)
    ↓
[後端] MediaMTX Service (核心服務)
    ↓
MediaMTX 服務 (端口 8554/8888/8889/9997)
    ├─ RTSP 接收 (8554)
    ├─ HLS 輸出 (8888)
    ├─ WebRTC 輸出 (8889)
    └─ API 管理 (9997)
    ↓
[前端] VideoPlayer 組件
    ├─ HLS.js 播放器
    └─ 原生 HLS 播放 (Safari)
    ↓
瀏覽器渲染
```

### 服務端口分配

| 服務            | 端口 | 用途              | 協議   |
| --------------- | ---- | ----------------- | ------ |
| 後端 API        | 4000 | REST API 服務     | HTTP   |
| MediaMTX RTSP   | 8554 | 接收 RTSP 串流    | RTSP   |
| MediaMTX HLS    | 8888 | 提供 HLS 播放列表 | HTTP   |
| MediaMTX WebRTC | 8889 | 提供 WebRTC 串流  | WebRTC |
| MediaMTX API    | 9997 | 管理 API          | HTTP   |

---

## 後端影像處理

### 1. RTSP Routes (`src/routes/rtspRoutes.js`)

**功能**：提供 RESTful API 介面，處理客戶端的串流請求

**主要端點**：

```12:50:src/routes/rtspRoutes.js
router.post("/start", async (req, res, next) => {
  try {
    const { rtspUrl } = req.body;

    if (!rtspUrl) {
      return res.status(400).json({
        error: true,
        message: "RTSP URL 是必需的",
        timestamp: new Date().toISOString(),
      });
    }

    // 驗證 RTSP URL 格式
    if (!rtspUrl.startsWith("rtsp://")) {
      return res.status(400).json({
        error: true,
        message: "無效的 RTSP URL 格式，必須以 rtsp:// 開頭",
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[RTSP Routes] 收到啟動串流請求: ${rtspUrl.replace(/:[^:@]+@/, ":****@")}`
    ); // 隱藏密碼

    const result = await rtspStreamService.startStream(rtspUrl);

    console.log(`[RTSP Routes] 串流啟動成功: Stream ID = ${result.streamId}`);

    res.json({
      error: false,
      data: result,
      message: "串流已啟動",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[RTSP Routes] 啟動串流失敗:`, error.message);
    next(error);
  }
});
```

**處理流程**：

1. 驗證 RTSP URL 格式
2. 調用 RTSP Stream Service 啟動串流
3. 返回串流資訊（streamId, hlsUrl, webrtcUrl）
4. 錯誤處理與日誌記錄

### 2. RTSP Stream Service (`src/services/communication/rtspStreamService.js`)

**功能**：作為 MediaMTX 服務的封裝層，提供與原有 API 兼容的介面

**核心方法**：

```54:88:src/services/communication/rtspStreamService.js
  async startStream(rtspUrl) {
    try {
      const result = await mediaMTXService.startStream(rtspUrl);

      // 推送 WebSocket 事件：串流啟動
      websocketService.emitRTSPStreamStarted({
        streamId: result.streamId,
        rtspUrl: result.rtspUrl,
        hlsUrl: result.hlsUrl,
        webrtcUrl: result.webrtcUrl,
        status: result.status,
      });

      // 返回與原有 API 兼容的格式
      return {
        streamId: result.streamId,
        hlsUrl: result.hlsUrl,
        webrtcUrl: result.webrtcUrl, // 額外提供 WebRTC URL（低延遲選項）
        status: result.status,
        rtspUrl: result.rtspUrl,
      };
    } catch (error) {
      // 發射錯誤事件
      const streamId = this.generateStreamId(rtspUrl);
      this.emit("error", { streamId, error });

      // 推送 WebSocket 事件：串流錯誤
      websocketService.emitRTSPStreamError({
        streamId,
        error,
      });

      throw error;
    }
  }
```

**特點**：

- 事件轉發：將 MediaMTX 服務的事件轉發給上層
- WebSocket 通知：自動推送串流狀態變化
- 錯誤處理：捕獲並轉發錯誤事件

### 3. MediaMTX Service (`src/services/communication/mediaMTXService.js`)

**功能**：管理與 MediaMTX 伺服器的通信，處理串流的生命週期

**核心功能**：

#### 3.1 串流 ID 生成

```70:82:src/services/communication/mediaMTXService.js
  generateStreamId(rtspUrl) {
    return crypto.createHash("md5").update(rtspUrl).digest("hex");
  }

  /**
   * 生成路徑名稱（用於 MediaMTX 配置）
   * @param {string} rtspUrl - RTSP 串流 URL
   * @returns {string} 路徑名稱
   */
  generatePathName(rtspUrl) {
    const streamId = this.generateStreamId(rtspUrl);
    return `stream_${streamId.substring(0, 8)}`;
  }
```

#### 3.2 服務器 IP 檢測

```44:63:src/services/communication/mediaMTXService.js
  getServerIP() {
    // 優先使用環境變數
    if (process.env.MEDIAMTX_PUBLIC_IP) {
      return process.env.MEDIAMTX_PUBLIC_IP;
    }

    // 獲取區域網路 IP
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // 跳過內部（localhost）和非 IPv4 地址
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }

    // 如果沒有找到，返回 localhost（開發環境）
    return "localhost";
  }
```

#### 3.3 路徑配置添加

```152:223:src/services/communication/mediaMTXService.js
  async addPath(pathName, rtspUrl) {
    // MediaMTX 路徑配置（移到外部以便在錯誤處理中使用）
    // 注意：H265 編解碼器可能導致 HLS 生成失敗
    // 解決方案：1) 將攝像頭配置為輸出 H264  2) 使用 FFmpeg 進行轉碼
    const pathConfig = {
      source: rtspUrl,
      sourceOnDemand: false, // 立即啟動，不等待客戶端連接
      // 注意：HLS 低延遲配置需要在全局配置文件中設置
      // MediaMTX API 的路徑配置不支持直接設置 HLS 參數
    };

    try {
      // 注意：如果遇到 H265 DTS 錯誤，需要：
      // 1. 將攝像頭配置為輸出 H264 編碼
      // 2. 或使用 FFmpeg 進行轉碼（需要額外配置）
      console.log(
        `[MediaMTX Service] 添加路徑: ${pathName}, 來源: ${rtspUrl.replace(
          /:[^:@]+@/,
          ":****@"
        )}`
      );

      const response = await axios.post(
        `${this.apiBaseUrl}/v3/config/paths/add/${pathName}`,
        pathConfig,
        {
          timeout: this.apiTimeout,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      return response.data;
    } catch (error) {
      if (error.response) {
        // 路徑可能已存在（MediaMTX 可能返回 400 或 409）
        if (error.response.status === 409 || error.response.status === 400) {
          const errorMsg =
            error.response.data?.error ||
            error.response.data?.message ||
            error.message ||
            "";
          // 檢查錯誤訊息是否包含 "already exists" 或類似的關鍵字
          const errorMsgLower = errorMsg.toLowerCase();
          if (
            errorMsgLower.includes("already exists") ||
            errorMsgLower.includes("already exist") ||
            errorMsgLower.includes("path already")
          ) {
            console.log(`[MediaMTX Service] 路徑 ${pathName} 已存在`);
            return { exists: true };
          }
        }
        // 顯示詳細錯誤訊息
        const errorMsg =
          error.response.data?.error ||
          error.response.data?.message ||
          error.message;
        console.error(
          `[MediaMTX Service] 添加路徑失敗 (${error.response.status}):`,
          errorMsg
        );
        console.error(
          `[MediaMTX Service] 請求配置:`,
          JSON.stringify(pathConfig, null, 2)
        );
        throw new Error(`添加路徑失敗: ${errorMsg}`);
      }
      throw new Error(`添加路徑失敗: ${error.message}`);
    }
  }
```

#### 3.4 路徑狀態緩存優化

```250:287:src/services/communication/mediaMTXService.js
  async getAllPathsStatus() {
    const now = Date.now();

    // 如果緩存未過期，直接返回緩存
    if (
      now - this.lastStatusUpdate < this.statusUpdateInterval &&
      this.pathStatusCache.size > 0
    ) {
      return this.pathStatusCache;
    }

    try {
      const response = await axios.get(`${this.apiBaseUrl}/v3/paths/list`, {
        timeout: this.apiTimeout,
      });

      const paths = response.data?.items || [];
      const statusMap = new Map();

      paths.forEach((path) => {
        statusMap.set(path.name, path);
      });

      // 更新緩存
      this.pathStatusCache = statusMap;
      this.lastStatusUpdate = now;

      return statusMap;
    } catch (error) {
      console.error(`[MediaMTX Service] 獲取路徑狀態失敗:`, error.message);
      // 返回緩存（即使過期），避免完全失敗
      return this.pathStatusCache;
    }
  }
```

**性能優化**：

- 2 秒緩存間隔，減少 API 請求
- 批量獲取所有路徑狀態
- 緩存失效時返回舊緩存，避免完全失敗

---

## 前端影像處理

### 1. VideoPlayer 組件 (`app/components/rtsp/VideoPlayer.vue`)

**功能**：提供統一的視頻播放介面，支持 HLS 和 WebRTC

#### 1.1 HLS 播放器配置（極低延遲）

```98:106:app/components/rtsp/VideoPlayer.vue
// HLS 播放器配置常量（極低延遲優化 - 目標 < 0.5 秒）
const HLS_PLAYER_CONFIG = {
	maxBufferLength: 0.3, // 最大緩衝 0.3 秒（極低延遲）
	maxMaxBufferLength: 0.6, // 最大緩衝上限 0.6 秒
	backBufferLength: 0, // 禁用後緩衝
	maxBufferSize: 600 * 1000, // 最大緩衝大小 600KB（減少緩衝以降低延遲）
	fragLoadingTimeOut: 1000, // 片段加載超時 1 秒
	manifestLoadingTimeOut: 300, // 清單加載超時 0.3 秒
	levelLoadingTimeOut: 1000 // 級別加載超時 1 秒
};
```

#### 1.2 HLS.js 播放器初始化

```220:301:app/components/rtsp/VideoPlayer.vue
		const setupHlsJsPlayer = () => {
			if (!videoElement.value || !hlsUrl.value) return;

			// 使用 hls.js 極低延遲配置（優化畫面載入速度）
			hls.value = new Hls({
				enableWorker: true,
				lowLatencyMode: true, // 啟用低延遲模式
				backBufferLength: HLS_PLAYER_CONFIG.backBufferLength,
				maxBufferLength: HLS_PLAYER_CONFIG.maxBufferLength,
				maxMaxBufferLength: HLS_PLAYER_CONFIG.maxMaxBufferLength,
				maxBufferSize: HLS_PLAYER_CONFIG.maxBufferSize,
				maxBufferHole: 0.01, // 極小緩衝空洞（極低延遲）
				highBufferWatchdogPeriod: 0.1, // 更頻繁的緩衝監控（每 0.1 秒檢查一次）
				nudgeOffset: 0.001, // 極小調整偏移
				nudgeMaxRetry: 1, // 最少重試
				fragLoadingTimeOut: HLS_PLAYER_CONFIG.fragLoadingTimeOut,
				manifestLoadingTimeOut: HLS_PLAYER_CONFIG.manifestLoadingTimeOut,
				levelLoadingTimeOut: HLS_PLAYER_CONFIG.levelLoadingTimeOut,
				startLevel: -1, // 自動選擇最佳品質
				liveSyncDurationCount: 0.3, // 極低延遲：只等待 0.3 個片段就開始播放（約 0.06 秒）
				liveMaxLatencyDurationCount: 1.0, // 最大延遲：1.0 個片段（約 0.2 秒）
				liveDurationInfinity: false // 不使用無限持續時間
			});

			hls.value.loadSource(hlsUrl.value);
			hls.value.attachMedia(videoElement.value);

			let retryCount = 0;
			const maxRetries = 8; // 適中的重試次數（MediaMTX 配置優化後生成更快）

			hls.value.on(Hls.Events.MANIFEST_PARSED, () => {
				console.log("[HLS] 播放列表解析完成，立即開始播放");
				handleAutoPlay();
				retryCount = 0;
				loading.value = false; // 提前結束載入狀態
			});

			// 監聽第一個片段加載完成，立即開始播放
			hls.value.on(Hls.Events.FRAG_LOADED, () => {
				if (loading.value) {
					console.log("[HLS] 第一個片段加載完成，開始播放");
					loading.value = false;
					handleAutoPlay();
				}
			});

			hls.value.on(Hls.Events.ERROR, (event: any, data: any) => {
				if (data.fatal) {
					switch (data.type) {
						case Hls.ErrorTypes.NETWORK_ERROR:
							const isManifestError =
								data.details === "manifestLoadError" ||
								data.response?.code === 404 ||
								data.response?.code === 500 ||
								data.frag?.url?.includes("playlist.m3u8");

							if (isManifestError && retryCount < maxRetries) {
								retryCount++;
								setTimeout(() => {
									if (hls.value && hlsUrl.value) {
										hls.value.loadSource(hlsUrl.value);
										hls.value.startLoad();
									}
								}, 300); // 優化後的重試延遲（MediaMTX 配置優化後生成更快）
							} else if (isManifestError) {
								error.value = "HLS 串流文件尚未就緒，請檢查後端服務或稍後重試";
								hls.value?.destroy();
							} else {
								hls.value?.startLoad();
							}
							break;
						case Hls.ErrorTypes.MEDIA_ERROR:
							hls.value?.recoverMediaError();
							break;
						default:
							error.value = "播放錯誤，請重試";
							hls.value?.destroy();
							break;
					}
				}
			});
		};
```

**關鍵特性**：

- **低延遲模式**：`lowLatencyMode: true`
- **最小緩衝**：`maxBufferLength: 0.3` 秒
- **快速啟動**：`liveSyncDurationCount: 0.3`（只等待 0.3 個片段）
- **自動重試**：網路錯誤最多重試 8 次
- **錯誤恢復**：媒體錯誤自動恢復

#### 1.3 GPU 硬體加速

```449:458:app/components/rtsp/VideoPlayer.vue
/* 啟用 GPU 硬體加速（解碼和渲染） */
video {
	transform: translateZ(0);
	-webkit-transform: translateZ(0);
	will-change: contents;
	-webkit-backface-visibility: hidden;
	backface-visibility: hidden;
	object-fit: cover;
	display: block;
}
```

### 2. RTSP API Composable (`app/composables/useRtsp.ts`)

**功能**：提供 RTSP 串流管理的 API 封裝

```23:40:app/composables/useRtsp.ts
	const startStream = async (rtspUrl: string): Promise<RTSPStreamInfo> => {
		if (process.dev) {
			console.log(`[RTSP API] 啟動串流，URL: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`); // 隱藏密碼
		}

		const response = await request<RTSPStartResponse>("/rtsp/start", {
			method: "POST",
			body: JSON.stringify({ rtspUrl })
		});

		const streamInfo = handleRtspResponse<RTSPStreamInfo>(response, "啟動串流失敗");

		if (process.dev) {
			console.log(`[RTSP API] 串流啟動成功，Stream ID: ${streamInfo.streamId}, HLS URL: ${streamInfo.hlsUrl}`);
		}

		return streamInfo;
	};
```

### 3. 圖片錯誤處理 (`app/utils/imageUtils.ts`)

**功能**：提供統一的圖片載入錯誤處理機制

```11:31:app/utils/imageUtils.ts
export const handleImageError = (event: Event, fallbackSrc?: string) => {
	const img = event.target as HTMLImageElement;

	// 如果已經嘗試過備用圖片，則顯示預設佔位符
	if (img.dataset.fallbackAttempted === "true") {
		img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23e5e7eb' width='200' height='200'/%3E%3Ctext fill='%239ca3af' font-family='sans-serif' font-size='14' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3E圖片載入失敗%3C/text%3E%3C/svg%3E";
		img.alt = "圖片載入失敗";
		return;
	}

	// 如果有備用圖片，嘗試載入
	if (fallbackSrc) {
		img.dataset.fallbackAttempted = "true";
		img.src = fallbackSrc;
		return;
	}

	// 沒有備用圖片，顯示預設佔位符
	img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23e5e7eb' width='200' height='200'/%3E%3Ctext fill='%239ca3af' font-family='sans-serif' font-size='14' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3E圖片載入失敗%3C/text%3E%3C/svg%3E";
	img.alt = "圖片載入失敗";
};
```

---

## MediaMTX 服務配置

### 配置文件 (`mediamtx.yml`)

```1:32:mediamtx.yml
# MediaMTX 配置檔案
# 優化低延遲配置

logLevel: info
logDestinations: [stdout]
logFile: ""

# 監聽地址
rtspAddress: :8554
rtmpAddress: :1935
hlsAddress: :8888
webrtcAddress: :8889
apiAddress: :9997
api: yes

# HLS 低延遲配置
hlsAlwaysRemux: yes
hlsSegmentCount: 3
hlsSegmentDuration: 1s
hlsAllowOrigin: "*"

# WebRTC 配置（低延遲）
webrtcAllowOrigin: "*"

# 路徑配置（通過 API 動態添加）
paths: {}

# 全域設定：啟用重新封裝以支持 HLS 和 WebRTC
# 這會自動將不兼容的編解碼器（如 H265）轉換為瀏覽器支持的格式
readTimeout: 10s
writeTimeout: 10s
```

**關鍵配置說明**：

| 配置項               | 值   | 說明                             |
| -------------------- | ---- | -------------------------------- |
| `hlsAlwaysRemux`     | yes  | 始終重新封裝（支持編解碼器轉換） |
| `hlsSegmentCount`    | 3    | 保留 3 個片段（減少延遲）        |
| `hlsSegmentDuration` | 1s   | 片段時長 1 秒（低延遲）          |
| `hlsAllowOrigin`     | "\*" | 允許跨域訪問                     |
| `webrtcAllowOrigin`  | "\*" | 允許跨域訪問（WebRTC）           |

---

## 編解碼器處理

### 支持的編解碼器

| 編解碼器        | 支持狀態    | 說明                        |
| --------------- | ----------- | --------------------------- |
| **H264**        | ✅ 完全支持 | 瀏覽器原生支持，推薦使用    |
| **H265 (HEVC)** | ⚠️ 部分支持 | 需要轉碼，可能出現 DTS 錯誤 |

### H265 處理策略

**問題**：H265 編碼可能導致 DTS 錯誤 `unable to extract DTS: invalid DeltaPocS0`

**解決方案**：

1. **推薦**：將攝像頭配置為輸出 H264（無需轉碼，性能最佳）
2. **備選**：使用 MediaMTX 重新封裝（`hlsAlwaysRemux: yes`），但轉碼能力有限
3. **測試**：嘗試不同通道（通常 Channel 102 是 H264，Channel 101 是 H265）

### 影像品質設定

**重要**：系統不進行轉碼，直接使用攝像頭原始串流。

- **解析度**：由攝像頭配置決定
- **幀率**：由攝像頭配置決定
- **碼率**：由攝像頭配置決定
- **編解碼器**：建議使用 H264

---

## 延遲優化機制

### 目標延遲

- **HLS 播放**：約 1-2 秒
- **WebRTC**：< 500ms

### 優化措施

#### 1. MediaMTX 層面

- **片段時長**：1 秒（`hlsSegmentDuration: 1s`）
- **片段數量**：保留 3 個片段（`hlsSegmentCount: 3`）
- **重新封裝**：啟用（`hlsAlwaysRemux: yes`）

#### 2. 前端播放器層面

- **最小緩衝**：0.3 秒（`maxBufferLength: 0.3`）
- **快速啟動**：只等待 0.3 個片段（`liveSyncDurationCount: 0.3`）
- **最大延遲**：1.0 個片段（`liveMaxLatencyDurationCount: 1.0`）
- **GPU 加速**：啟用硬體加速

#### 3. 總延遲組成

```
RTSP 連接:        0.1-0.2 秒
MediaMTX 處理:     0.3-0.5 秒
網路傳輸:          0.2-0.5 秒
前端緩衝:          0.3-1.0 秒
─────────────────────────────
總延遲:            ≈ 1-2 秒
```

---

## 錯誤處理與重試機制

### 後端錯誤處理

#### 1. RTSP URL 驗證

```23:30:src/routes/rtspRoutes.js
    // 驗證 RTSP URL 格式
    if (!rtspUrl.startsWith("rtsp://")) {
      return res.status(400).json({
        error: true,
        message: "無效的 RTSP URL 格式，必須以 rtsp:// 開頭",
        timestamp: new Date().toISOString(),
      });
    }
```

#### 2. MediaMTX 服務健康檢查

```88:144:src/services/communication/mediaMTXService.js
  async checkServiceHealth() {
    try {
      // 方法1: 嘗試訪問 API 端點
      try {
        const response = await axios.get(`${this.apiBaseUrl}/v3/paths/list`, {
          timeout: this.apiTimeout,
          validateStatus: () => true, // 接受任何狀態碼
        });
        // 如果得到回應（即使是 404），表示服務正在運行
        if (response.status < 500) {
          return true;
        }
      } catch (err) {
        // 繼續嘗試其他方法
      }

      // 方法2: 使用 TCP 連接測試端口
      const net = require("net");
      return new Promise((resolve) => {
        try {
          const url = new URL(this.apiBaseUrl);
          const host = url.hostname;
          const port = parseInt(url.port) || 9997;

          const client = new net.Socket();
          client.setTimeout(2000);

          client.once("connect", () => {
            client.destroy();
            resolve(true);
          });

          client.once("timeout", () => {
            client.destroy();
            resolve(false);
          });

          client.once("error", (err) => {
            // 連接被拒絕表示端口未開放，但其他錯誤可能是網路問題
            if (err.code === "ECONNREFUSED") {
              resolve(false);
            } else {
              // 其他錯誤可能是暫時的，給一次機會
              resolve(false);
            }
          });

          client.connect(port, host);
        } catch (error) {
          resolve(false);
        }
      });
    } catch (error) {
      console.error(`[MediaMTX Service] 健康檢查失敗:`, error.message);
      return false;
    }
  }
```

### 前端錯誤處理

#### 1. HLS 播放器錯誤處理

```266:300:app/components/rtsp/VideoPlayer.vue
			hls.value.on(Hls.Events.ERROR, (event: any, data: any) => {
				if (data.fatal) {
					switch (data.type) {
						case Hls.ErrorTypes.NETWORK_ERROR:
							const isManifestError =
								data.details === "manifestLoadError" ||
								data.response?.code === 404 ||
								data.response?.code === 500 ||
								data.frag?.url?.includes("playlist.m3u8");

							if (isManifestError && retryCount < maxRetries) {
								retryCount++;
								setTimeout(() => {
									if (hls.value && hlsUrl.value) {
										hls.value.loadSource(hlsUrl.value);
										hls.value.startLoad();
									}
								}, 300); // 優化後的重試延遲（MediaMTX 配置優化後生成更快）
							} else if (isManifestError) {
								error.value = "HLS 串流文件尚未就緒，請檢查後端服務或稍後重試";
								hls.value?.destroy();
							} else {
								hls.value?.startLoad();
							}
							break;
						case Hls.ErrorTypes.MEDIA_ERROR:
							hls.value?.recoverMediaError();
							break;
						default:
							error.value = "播放錯誤，請重試";
							hls.value?.destroy();
							break;
					}
				}
			});
```

**重試策略**：

- **網路錯誤**：最多重試 8 次，每次間隔 300ms
- **媒體錯誤**：自動恢復（`recoverMediaError()`）
- **其他錯誤**：顯示錯誤訊息並銷毀播放器

#### 2. 原生 HLS 錯誤處理（Safari）

```308:332:app/components/rtsp/VideoPlayer.vue
		const errorHandler = (e: Event) => {
			const videoError = videoElement.value?.error;
			if (!videoError) {
				error.value = "視頻加載失敗";
				return;
			}

			// 解碼或格式錯誤時回退到 hls.js
			if (
				(videoError.code === videoError.MEDIA_ERR_DECODE ||
					videoError.code === videoError.MEDIA_ERR_SRC_NOT_SUPPORTED) &&
				useHlsJs &&
				videoElement.value
			) {
				videoElement.value.removeEventListener("error", errorHandler);
				videoElement.value.removeEventListener("loadedmetadata", loadedHandler);
				videoElement.value.src = "";
				videoElement.value.load();
				setTimeout(() => {
					if (videoElement.value && hlsUrl.value) {
						setupHlsJsPlayer();
					}
				}, 50); // 減少等待時間
				return;
			}

			error.value = "視頻加載失敗";
		};
```

---

## WebSocket 實時通知

### 事件類型

| 事件名稱                     | 觸發時機       | 數據格式                                                      |
| ---------------------------- | -------------- | ------------------------------------------------------------- |
| `rtsp:stream:started`        | 串流啟動成功時 | `{ streamId, rtspUrl, hlsUrl, webrtcUrl, status, timestamp }` |
| `rtsp:stream:stopped`        | 串流停止時     | `{ streamId, timestamp }`                                     |
| `rtsp:stream:error`          | 串流發生錯誤時 | `{ streamId, error: { message, code? }, timestamp }`          |
| `rtsp:stream:status:changed` | 串流狀態變更時 | `{ streamId, oldStatus, newStatus, timestamp }`（預留）       |

### 後端推送

```58:65:src/services/communication/rtspStreamService.js
      // 推送 WebSocket 事件：串流啟動
      websocketService.emitRTSPStreamStarted({
        streamId: result.streamId,
        rtspUrl: result.rtspUrl,
        hlsUrl: result.hlsUrl,
        webrtcUrl: result.webrtcUrl,
        status: result.status,
      });
```

---

## 性能優化策略

### 已實現的優化

1. **路徑狀態緩存**：2 秒緩存間隔，減少 API 請求
2. **批量狀態獲取**：一次性獲取所有路徑狀態
3. **自動 IP 檢測**：優先使用環境變數，自動檢測區域網路 IP
4. **WebSocket 通知**：實時推送串流狀態變化
5. **GPU 硬體加速**：啟用瀏覽器硬體加速
6. **低延遲配置**：最小緩衝、快速啟動

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

## 總結與建議

### 系統優勢

1. **低延遲設計**：從 MediaMTX 到前端播放器，全面優化延遲
2. **錯誤恢復**：完善的重試機制和錯誤處理
3. **實時通知**：WebSocket 推送串流狀態變化
4. **性能優化**：緩存、批量請求、GPU 加速

### 改進建議

1. **H265 支持**：考慮實現 FFmpeg 轉碼方案
2. **健康監控**：定期檢查串流狀態，自動清理失效記錄
3. **資源管理**：設置串流數量限制，防止資源耗盡
4. **性能監控**：添加性能指標統計和監控

### 最佳實踐

1. **攝像頭配置**：優先使用 H264 編碼
2. **網路環境**：確保穩定的網路連接
3. **服務器資源**：監控 CPU 和記憶體使用情況
4. **錯誤日誌**：定期檢查錯誤日誌，及時發現問題

---

**最後更新**：2025-12-30  
**版本**：1.0.0
