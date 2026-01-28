const axios = require("axios");
const crypto = require("crypto");
const EventEmitter = require("events");
const os = require("os");
const websocketService = require("../websocket/websocketService");
const ffmpegService = require("./ffmpegService");

/**
 * MediaMTX 服務管理類別
 * 負責與 MediaMTX 伺服器通信，管理 RTSP 串流
 */
class MediaMTXService extends EventEmitter {
  constructor() {
    super();
    // MediaMTX API 基礎 URL
    this.apiBaseUrl = process.env.MEDIAMTX_API_URL || "http://localhost:9997";

    // 獲取服務器 IP 地址（用於前端訪問）
    const serverIP = this.getServerIP();

    // MediaMTX HLS 輸出 URL（供前端播放）
    // 使用服務器 IP 而不是 localhost，以便前端可以訪問
    const hlsHost = process.env.MEDIAMTX_HLS_URL || `http://${serverIP}:8888`;
    this.hlsBaseUrl = hlsHost;

    // MediaMTX WebRTC URL（低延遲選項）
    const webrtcHost =
      process.env.MEDIAMTX_WEBRTC_URL || `http://${serverIP}:8889`;
    this.webrtcBaseUrl = webrtcHost;

    // 存儲所有活躍的串流
    this.streams = new Map();
    // API 請求超時時間（毫秒）
    this.apiTimeout = 10000;

    // 路徑狀態緩存（優化性能：減少 API 請求）
    this.pathStatusCache = new Map();
    this.lastStatusUpdate = 0;
    this.statusUpdateInterval = 2000; // 批量更新間隔 2 秒

    // 全域監聽 FFmpeg 服務錯誤（避免每次 startStream 臨時掛 listener）
    // 目的：FFmpeg 任何時候掛掉，都能把 stream 標記錯誤並清理 MediaMTX path。
    ffmpegService.on("error", async ({ streamId, error }) => {
      try {
        const stream = this.streams.get(streamId);
        if (!stream) return;

        // 只處理 GPU 編碼串流
        if (!stream.useGpuEncoding) return;

        console.error(`[MediaMTX Service] FFmpeg 進程錯誤(全域監聽): ${streamId}`, error);

        // 清理：移除 MediaMTX path、停止 FFmpeg（如果還在）
        try {
          await ffmpegService.stopGpuEncoding(streamId);
        } catch (_) {}
        try {
          await this.removePath(stream.pathName);
        } catch (_) {}

        // 從記憶體移除
        this.streams.delete(streamId);

        websocketService.emitRTSPStreamError({
          streamId,
          error: error,
        });
      } catch (e) {
        console.error(`[MediaMTX Service] 全域 FFmpeg 錯誤處理失敗: ${e.message}`);
      }
    });
  }

  /**
   * 獲取服務器 IP 地址（用於前端訪問）
   * @returns {string} IP 地址
   */
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

  /**
   * 生成串流 ID（基於 RTSP URL）
   * @param {string} rtspUrl - RTSP 串流 URL
   * @returns {string} 串流 ID
   */
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

  /**
   * 生成 HLS URL（統一方法，包含時間戳以防止緩存）
   * @param {string} pathName - 路徑名稱
   * @param {number} timestamp - 時間戳（可選，預設使用當前時間）
   * @returns {string} HLS URL
   */
  generateHlsUrl(pathName, timestamp = null) {
    const ts = timestamp || Date.now();
    return `${this.hlsBaseUrl}/${pathName}/index.m3u8?t=${ts}`;
  }

  /**
   * 生成 WebRTC URL
   * @param {string} pathName - 路徑名稱
   * @returns {string} WebRTC URL
   */
  generateWebRTCUrl(pathName) {
    return `${this.webrtcBaseUrl}/${pathName}`;
  }

  /**
   * 創建串流資訊對象（統一方法）
   * @param {string} streamId - 串流 ID
   * @param {string} pathName - 路徑名稱
   * @param {string} rtspUrl - RTSP URL
   * @param {string} hlsUrl - HLS URL
   * @param {string} webrtcUrl - WebRTC URL
   * @param {number} timestamp - 時間戳
   * @param {string} status - 狀態
   * @param {Object} gpuOptions - GPU 編碼選項（可選）
   * @returns {Object} 串流資訊對象
   * @private
   */
  _createStreamInfo(streamId, pathName, rtspUrl, hlsUrl, webrtcUrl, timestamp, status = "running", gpuOptions = null) {
    return {
      streamId,
      pathName,
      rtspUrl,
      hlsUrl,
      webrtcUrl,
      timestamp,
      status,
      startedAt: new Date(),
      useGpuEncoding: gpuOptions !== null,
      gpuOptions: gpuOptions || undefined,
    };
  }

  /**
   * 創建串流響應對象（統一方法）
   * @param {string} streamId - 串流 ID
   * @param {string} rtspUrl - RTSP URL
   * @param {string} hlsUrl - HLS URL
   * @param {string} webrtcUrl - WebRTC URL
   * @param {string} status - 狀態
   * @returns {Object} 串流響應對象
   * @private
   */
  _createStreamResponse(streamId, rtspUrl, hlsUrl, webrtcUrl, status) {
    return {
      streamId,
      rtspUrl,
      hlsUrl,
      webrtcUrl,
      status: status || "running",
    };
  }

  /**
   * 推送串流啟動 WebSocket 事件（統一方法）
   * @param {string} streamId - 串流 ID
   * @param {string} rtspUrl - RTSP URL
   * @param {string} hlsUrl - HLS URL
   * @param {string} webrtcUrl - WebRTC URL
   * @param {string} status - 狀態
   * @param {Object} gpuOptions - GPU 編碼選項（可選）
   * @private
   */
  _emitStreamStarted(streamId, rtspUrl, hlsUrl, webrtcUrl, status = "running", gpuOptions = null) {
    websocketService.emitRTSPStreamStarted({
      streamId,
      rtspUrl,
      hlsUrl,
      webrtcUrl,
      status,
      useGpuEncoding: gpuOptions !== null,
      gpuOptions: gpuOptions || undefined,
    });
  }

  /**
   * 檢查 MediaMTX 服務是否可用
   * @returns {Promise<boolean>}
   */
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

  /**
   * 添加路徑配置到 MediaMTX（Publisher 模式，等待 RTSP 推送）
   * @param {string} pathName - 路徑名稱
   * @returns {Promise<Object>}
   */
  async addPathForPublisher(pathName) {
    // MediaMTX 路徑配置（Publisher 模式）
    // 不設置 source，讓路徑等待 RTSP publisher 連接
    const pathConfig = {
      sourceOnDemand: false, // 立即啟動，不等待客戶端連接
      // 注意：不設置 source，表示等待 publisher 推送
    };

    try {
      console.log(
        `[MediaMTX Service] 添加路徑（Publisher 模式）: ${pathName}`
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
        if (error.response.status === 409 || error.response.status === 400) {
          const errorMsg =
            error.response.data?.error ||
            error.response.data?.message ||
            error.message ||
            "";
          const errorMsgLower = errorMsg.toLowerCase();
          if (
            errorMsgLower.includes("already exists") ||
            errorMsgLower.includes("already exist") ||
            errorMsgLower.includes("path already")
          ) {
            // 路徑已存在，但可能配置不正確，需要重新配置
            console.warn(
              `[MediaMTX Service] 路徑 ${pathName} 已存在，但可能不是 Publisher 模式，將嘗試移除並重新添加`
            );
            // 返回特殊標記，讓調用者知道需要處理
            return { exists: true, needsReconfig: true };
          }
        }
        const errorMsg =
          error.response.data?.error ||
          error.response.data?.message ||
          error.message;
        console.error(
          `[MediaMTX Service] 添加路徑失敗 (${error.response.status}):`,
          errorMsg
        );
        throw new Error(`添加路徑失敗: ${errorMsg}`);
      }
      throw new Error(`添加路徑失敗: ${error.message}`);
    }
  }

  /**
   * 添加路徑配置到 MediaMTX（Source 模式，拉取 RTSP 串流）
   * @param {string} pathName - 路徑名稱
   * @param {string} rtspUrl - RTSP 來源 URL
   * @returns {Promise<Object>}
   */
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

  /**
   * 移除路徑配置
   * @param {string} pathName - 路徑名稱
   * @returns {Promise<boolean>}
   */
  async removePath(pathName) {
    try {
      await axios.post(
        `${this.apiBaseUrl}/v3/config/paths/remove/${pathName}`,
        {},
        {
          timeout: this.apiTimeout,
        }
      );
      return true;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // 路徑不存在，視為成功
        return true;
      }
      console.error(`[MediaMTX Service] 移除路徑失敗:`, error.message);
      throw new Error(`移除路徑失敗: ${error.message}`);
    }
  }

  /**
   * 輪詢檢查路徑是否真的被移除（統一方法）
   * @param {string} pathName - 路徑名稱
   * @param {number} maxWaitMs - 最大等待時間（毫秒），預設 3000ms
   * @param {number} checkIntervalMs - 檢查間隔（毫秒），預設 200ms
   * @returns {Promise<boolean>} 是否成功移除
   */
  async waitForPathRemoval(pathName, maxWaitMs = 3000, checkIntervalMs = 200) {
    const maxAttempts = Math.floor(maxWaitMs / checkIntervalMs);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      const checkStatus = await this.getPathStatus(pathName);
      if (!checkStatus || !checkStatus.ready) {
        const waitTime = (i + 1) * checkIntervalMs;
        console.log(
          `[MediaMTX Service] 路徑 ${pathName} 已成功移除（等待 ${waitTime}ms）`
        );
        return true;
      }
    }
    return false;
  }

  /**
   * 輪詢檢查路徑是否就緒（用於等待 MediaMTX 生成 HLS manifest）
   * @param {string} pathName - 路徑名稱
   * @param {number} maxWaitMs - 最大等待時間（毫秒），預設 5000ms
   * @param {number} checkIntervalMs - 檢查間隔（毫秒），預設 200ms
   * @returns {Promise<boolean>} 是否成功就緒
   */
  async waitForPathReady(pathName, maxWaitMs = 5000, checkIntervalMs = 200) {
    const maxAttempts = Math.floor(maxWaitMs / checkIntervalMs);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      const checkStatus = await this.getPathStatus(pathName);
      if (checkStatus && checkStatus.ready) {
        const waitTime = (i + 1) * checkIntervalMs;
        console.log(
          `[MediaMTX Service] 路徑 ${pathName} 已就緒（等待 ${waitTime}ms）`
        );
        return true;
      }
    }
    return false;
  }

  /**
   * 生成帶時間戳的路徑名稱（用於強制創建新路徑）
   * @param {string} basePathName - 基礎路徑名稱
   * @returns {string} 帶時間戳的路徑名稱
   */
  _generateTimestampedPathName(basePathName) {
    const timestamp = Date.now();
    return `${basePathName}_${timestamp}`;
  }

  /**
   * 獲取所有路徑狀態（批量獲取，使用緩存優化性能）
   * @returns {Promise<Map<string, Object>>}
   */
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

  /**
   * 獲取路徑狀態（優化：使用緩存）
   * @param {string} pathName - 路徑名稱
   * @returns {Promise<Object|null>}
   */
  async getPathStatus(pathName) {
    try {
      const allPaths = await this.getAllPathsStatus();
      return allPaths.get(pathName) || null;
    } catch (error) {
      console.error(`[MediaMTX Service] 獲取路徑狀態失敗:`, error.message);
      return null;
    }
  }

  /**
   * 啟動 RTSP 串流
   * @param {string} rtspUrl - RTSP 串流 URL
   * @param {Object} options - 串流選項
   * @param {boolean} options.useGpuEncoding - 是否使用 GPU 編碼
   * @param {string} options.gpuType - GPU 類型: 'nvidia', 'intel', 'amd'
   * @param {string} options.bitrate - 位元率，例如 '2M'
   * @param {string} options.preset - 編碼預設值（NVIDIA 使用）
   * @returns {Promise<{streamId: string, hlsUrl: string, webrtcUrl: string, status: string}>}
   */
  async startStream(rtspUrl, options = {}) {
    if (!rtspUrl || typeof rtspUrl !== "string") {
      throw new Error("RTSP URL 是必需的");
    }

    // 驗證 RTSP URL 格式
    if (!rtspUrl.startsWith("rtsp://")) {
      throw new Error("無效的 RTSP URL 格式，必須以 rtsp:// 開頭");
    }

    // 解析 GPU 編碼選項（簡化：只保留開關）
    const {
      useGpuEncoding = false,
    } = options;

    const streamId = this.generateStreamId(rtspUrl);
    let pathName = this.generatePathName(rtspUrl); // 使用 let，因為可能需要在移除失敗時重新賦值

    // 如果串流已經存在，先檢查 MediaMTX 路徑狀態
    // 如果路徑已存在但串流剛停止，需要重新創建路徑以清除舊片段
    if (this.streams.has(streamId)) {
      const existingStream = this.streams.get(streamId);
      
      // 檢查 MediaMTX 路徑是否真的存在
      const pathStatus = await this.getPathStatus(pathName);
      
      if (pathStatus && pathStatus.ready) {
        // 路徑存在且就緒，直接返回新的 URL（帶最新時間戳）
        const timestamp = Date.now();
        const latestHlsUrl = this.generateHlsUrl(existingStream.pathName, timestamp);
        
        // 更新現有串流的 URL
        existingStream.hlsUrl = latestHlsUrl;
        existingStream.timestamp = timestamp;
        this.streams.set(streamId, existingStream);
        
        // 推送 WebSocket 事件（通知前端 URL 已更新）
        this._emitStreamStarted(
          streamId,
          existingStream.rtspUrl,
          latestHlsUrl,
          existingStream.webrtcUrl,
          existingStream.status
        );
        
        return this._createStreamResponse(
          streamId,
          existingStream.rtspUrl,
          latestHlsUrl,
          existingStream.webrtcUrl,
          existingStream.status
        );
      }
      
      // 路徑不存在或未就緒，從記憶體中移除，重新創建
      console.log(
        `[MediaMTX Service] 串流 ${streamId} 的路徑不存在或未就緒，將重新創建`
      );
      this.streams.delete(streamId);
    }

    // 檢查 MediaMTX 服務健康狀態
    const isHealthy = await this.checkServiceHealth();
    if (!isHealthy) {
      throw new Error("MediaMTX 服務不可用，請確認服務已啟動");
    }

    try {
      // 檢查路徑是否已存在，如果存在則先移除（確保清除舊片段）
      const existingPathStatus = await this.getPathStatus(pathName);
      if (existingPathStatus && existingPathStatus.ready) {
        console.log(
          `[MediaMTX Service] 路徑 ${pathName} 已存在，先移除以清除舊片段`
        );
        try {
          await this.removePath(pathName);
          
          // ⭐ 關鍵：輪詢檢查路徑是否真的被移除（統一方法）
          const removed = await this.waitForPathRemoval(pathName, 3000, 200);
          
          if (!removed) {
            console.warn(
              `[MediaMTX Service] 路徑 ${pathName} 移除超時（3秒），使用帶時間戳的路徑名稱強制重新創建`
            );
            // ⭐ 關鍵：如果路徑無法移除，使用帶時間戳的路徑名稱強制創建新路徑
            pathName = this._generateTimestampedPathName(pathName);
            console.log(
              `[MediaMTX Service] 使用新路徑名稱: ${pathName}（避免使用舊片段）`
            );
          }
        } catch (removeError) {
          // 移除失敗，使用帶時間戳的路徑名稱
          console.warn(
            `[MediaMTX Service] 移除舊路徑失敗，使用帶時間戳的路徑名稱: ${removeError.message}`
          );
          pathName = this._generateTimestampedPathName(pathName);
          console.log(
            `[MediaMTX Service] 使用新路徑名稱: ${pathName}（避免使用舊片段）`
          );
        }
      }

      // 根據是否使用 GPU 編碼決定串流來源
      let actualRtspSource = rtspUrl;
      let gpuOptions = null;

      if (useGpuEncoding) {
        // 使用 GPU 編碼：先啟動 FFmpeg，再添加 MediaMTX 路徑
        const serverIP = this.getServerIP();
        const rtspOutput = `rtsp://${serverIP}:8554/${pathName}`;

        console.log(
          `[MediaMTX Service] 使用 GPU 編碼: ${streamId}`
        );

        // ⭐ 關鍵：先移除舊路徑（如果存在），然後配置為 publisher 模式
        const existingPathStatus = await this.getPathStatus(pathName);
        if (existingPathStatus && existingPathStatus.ready) {
          console.log(
            `[MediaMTX Service] 路徑 ${pathName} 已存在，先移除以重新配置為 Publisher 模式`
          );
          try {
            await this.removePath(pathName);
            await this.waitForPathRemoval(pathName, 2000, 200);
          } catch (removeError) {
            console.warn(
              `[MediaMTX Service] 移除舊路徑失敗: ${removeError.message}`
            );
          }
        }

        // 配置 MediaMTX 路徑為 publisher 模式（等待 FFmpeg 推送）
        await this.addPathForPublisher(pathName);

        // 等待一小段時間，確保 MediaMTX 路徑已準備好接收推送
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 啟動 FFmpeg GPU 編碼（推送到 MediaMTX）
        // ⚠️ 性能警告：2560x1440 解析度編碼負擔重，建議縮放到 1080p 或 720p
        // 如果編碼速度 < 0.8x，會導致延遲累積
        ffmpegService.startGpuEncoding(streamId, rtspUrl, rtspOutput, {
          gpuType: "nvidia", // 固定使用 NVIDIA
          scale: "1920:1080", // ⭐ 關鍵優化：縮放到 1080p，大幅降低編碼負擔
          // 可選：使用 "1280:720" 獲得最低延遲（但畫質較低）
        });

        // 等待 FFmpeg 穩定啟動（避免 “剛啟動就秒退” 卻被視為成功）
        const ok = await ffmpegService.waitForProcessStable(streamId, 2000, 8000, 200);
        if (!ok) {
          const last = ffmpegService.getLastError(streamId);
          const ffmpegError = last?.error || "FFmpeg GPU 編碼啟動失敗";

          await ffmpegService.stopGpuEncoding(streamId);
          try {
            await this.removePath(pathName);
          } catch (_) {}

          const { generateErrorMessage } = require("../../config/ffmpegConfig");
          throw new Error(
            generateErrorMessage({
              ffmpegError,
              isStillRunning: ffmpegService.isRunning(streamId),
              ffmpegReady: false,
            })
          );
        }

        // GPU 編碼模式下，路徑已經配置為 publisher，不需要再次添加
        actualRtspSource = null; // 標記為已配置
        gpuOptions = { useGpuEncoding: true };
      } else {
        // 非 GPU 編碼：直接使用原始 RTSP URL（Source 模式）
        actualRtspSource = rtspUrl;
      }

      // 添加路徑到 MediaMTX（僅在非 GPU 編碼模式下需要）
      let addPathResult = null;
      if (actualRtspSource) {
        addPathResult = await this.addPath(pathName, actualRtspSource);
      }

      // 生成播放 URL（統一方法，包含時間戳以防止緩存）
      const timestamp = Date.now();
      const hlsUrl = this.generateHlsUrl(pathName, timestamp);
      const webrtcUrl = this.generateWebRTCUrl(pathName);

      // 存儲串流資訊（使用統一方法，包含 GPU 選項）
      const streamInfo = this._createStreamInfo(
        streamId,
        pathName,
        rtspUrl,
        hlsUrl,
        webrtcUrl,
        timestamp,
        "running",
        gpuOptions
      );
      this.streams.set(streamId, streamInfo);

      // 等待路徑就緒（無論是新路徑還是已存在的路徑）
      const isExistingPath = addPathResult && addPathResult.exists;
      if (isExistingPath) {
        console.log(
          `[MediaMTX Service] 路徑 ${pathName} 已存在，等待 MediaMTX 重新初始化`
        );
      } else {
        console.log(
          `[MediaMTX Service] 等待新路徑 ${pathName} 就緒（MediaMTX 生成 HLS manifest）`
        );
      }

      // ⭐ 優化：輪詢檢查路徑是否就緒，而不是固定等待時間
      const ready = await this.waitForPathReady(pathName, 8000, 200);
      if (!ready) {
        // 不再回傳成功（避免前端拿到 404 manifest）
        // 清理：移除路徑、停止 FFmpeg（若有）
        try {
          if (useGpuEncoding) await ffmpegService.stopGpuEncoding(streamId);
        } catch (_) {}
        try {
          await this.removePath(pathName);
        } catch (_) {}

        this.streams.delete(streamId);
        throw new Error(`HLS manifest 尚未就緒（${pathName}），請稍後重試`);
      }

      // 路徑已就緒或超時，推送 WebSocket 事件
      this._emitStreamStarted(streamId, rtspUrl, hlsUrl, webrtcUrl, "running", gpuOptions);
      console.log(
        `[MediaMTX Service] 串流啟動成功: ${streamId} (路徑: ${pathName})`
      );

      return this._createStreamResponse(streamId, rtspUrl, hlsUrl, webrtcUrl);
    } catch (error) {
      // 如果使用 GPU 編碼，停止 FFmpeg 進程
      if (useGpuEncoding) {
        try {
          await ffmpegService.stopGpuEncoding(streamId);
        } catch (ffmpegError) {
          console.error(
            `[MediaMTX Service] 清理 FFmpeg 進程失敗: ${ffmpegError.message}`
          );
        }
      }

      // 清理失敗的串流
      this.streams.delete(streamId);
      
      // 推送 WebSocket 錯誤事件（streamId 已在上面計算過）
      websocketService.emitRTSPStreamError({
        streamId,
        error: error,
      });
      
      throw new Error(`啟動串流失敗: ${error.message}`);
    }
  }

  /**
   * 停止 RTSP 串流
   * @param {string} streamId - 串流 ID
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async stopStream(streamId) {
    if (!this.streams.has(streamId)) {
      throw new Error(`串流 ${streamId} 不存在`);
    }

    const streamInfo = this.streams.get(streamId);

    try {
      // 如果使用 GPU 編碼，先停止 FFmpeg 進程
      if (streamInfo.useGpuEncoding) {
        console.log(
          `[MediaMTX Service] 停止 FFmpeg GPU 編碼進程: ${streamId}`
        );
        await ffmpegService.stopGpuEncoding(streamId);
      }

      // 從 MediaMTX 移除路徑
      await this.removePath(streamInfo.pathName);

      // ⭐ 關鍵：輪詢檢查路徑是否真的被移除（統一方法）
      // 這確保路徑被完全清理，避免重新啟動時使用舊片段
      const removed = await this.waitForPathRemoval(streamInfo.pathName, 3000, 200);

      if (!removed) {
        console.warn(
          `[MediaMTX Service] 路徑 ${streamInfo.pathName} 移除超時（3秒），但繼續停止流程`
        );
      }

      // 從記憶體中移除
      this.streams.delete(streamId);

      // 推送 WebSocket 事件（整合 WebSocket 推送）
      websocketService.emitRTSPStreamStopped({ streamId });

      console.log(`[MediaMTX Service] 串流已停止: ${streamId}`);

      return {
        success: true,
        message: `串流 ${streamId} 已停止`,
      };
    } catch (error) {
      // 即使移除失敗，也停止 FFmpeg 進程（如果使用 GPU 編碼）
      if (streamInfo && streamInfo.useGpuEncoding) {
        try {
          await ffmpegService.stopGpuEncoding(streamId);
        } catch (ffmpegError) {
          console.error(
            `[MediaMTX Service] 停止 FFmpeg 進程失敗: ${ffmpegError.message}`
          );
        }
      }

      // 即使移除失敗，也從記憶體中移除
      this.streams.delete(streamId);
      
      // 推送 WebSocket 錯誤事件
      websocketService.emitRTSPStreamError({
        streamId,
        error: error,
      });
      
      throw new Error(`停止串流失敗: ${error.message}`);
    }
  }

  /**
   * 獲取串流狀態（優化：批量獲取路徑狀態，減少 API 請求）
   * @param {string} streamId - 串流 ID（可選，不提供則返回所有串流）
   * @returns {Object|Array|null}
   */
  async getStreamStatus(streamId = null) {
    if (streamId) {
      if (!this.streams.has(streamId)) {
        return null;
      }

      const stream = this.streams.get(streamId);
      // 批量獲取所有路徑狀態（使用緩存）
      const allPaths = await this.getAllPathsStatus();
      const pathStatus = allPaths.get(stream.pathName) || null;

      return {
        streamId: stream.streamId,
        rtspUrl: stream.rtspUrl,
        hlsUrl: stream.hlsUrl,
        webrtcUrl: stream.webrtcUrl,
        status: pathStatus?.ready ? "running" : "stopped",
        startedAt: stream.startedAt,
        pathStatus: pathStatus,
      };
    }

    // 返回所有串流狀態（優化：只發起一次 API 請求）
    const allPaths = await this.getAllPathsStatus();
    const statuses = [];

    for (const stream of this.streams.values()) {
      const pathStatus = allPaths.get(stream.pathName) || null;
      statuses.push({
        streamId: stream.streamId,
        rtspUrl: stream.rtspUrl,
        hlsUrl: stream.hlsUrl,
        webrtcUrl: stream.webrtcUrl,
        status: pathStatus?.ready ? "running" : "stopped",
        startedAt: stream.startedAt,
        pathStatus: pathStatus,
      });
    }

    return statuses;
  }

  /**
   * 停止所有串流
   * @returns {Promise<Array>}
   */
  async stopAllStreams() {
    const streamIds = Array.from(this.streams.keys());
    const results = await Promise.allSettled(
      streamIds.map((id) => this.stopStream(id))
    );
    return results;
  }

  /**
   * 獲取最新的 HLS URL（帶時間戳，防止緩存）
   * @param {string} streamId - 串流 ID
   * @returns {Promise<{hlsUrl: string, timestamp: number, serverTime: number}>}
   */
  async getLatestHlsUrl(streamId) {
    if (!this.streams.has(streamId)) {
      throw new Error(`串流 ${streamId} 不存在`);
    }

    const stream = this.streams.get(streamId);
    const timestamp = Date.now();
    // 使用統一方法生成帶時間戳的 URL
    const hlsUrl = this.generateHlsUrl(stream.pathName, timestamp);

    return {
      hlsUrl,
      timestamp,
      serverTime: timestamp, // 與 timestamp 相同，保留以維持 API 兼容性
    };
  }
}

// 導出單例
module.exports = new MediaMTXService();
