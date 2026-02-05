const axios = require("axios");
const crypto = require("crypto");
const net = require("net");
const EventEmitter = require("events");
const os = require("os");
const websocketService = require("../websocket/websocketService");
const ffmpegService = require("./ffmpegService");
const { generateErrorMessage } = require("../../config/ffmpegConfig");
const logger = require("../../utils/logger").createLogger("MediaMTX Service");

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

    // 防重複 start：同一 streamId 在短時間內不重複處理（減少 path already exists）
    this.lastStartRequest = new Map(); // streamId -> { at: number }
    this.duplicateStartCooldownMs = 2000;

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

        logger.error("FFmpeg 進程錯誤(全域監聽)", { streamId, error });

        // 清理：移除 MediaMTX path、停止 FFmpeg（如果還在）
        try {
          await ffmpegService.stopGpuEncoding(streamId);
        } catch (_) {}
        try {
          await this.removePath(stream.pathName);
        } catch (_) {}

        // 從記憶體移除
        this.streams.delete(streamId);
        this.lastStartRequest.delete(streamId);

        websocketService.emitRTSPStreamError({
          streamId,
          error: error,
        });
      } catch (e) {
        logger.error("全域 FFmpeg 錯誤處理失敗", { error: e.message });
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
  _createStreamInfo(
    streamId,
    pathName,
    rtspUrl,
    hlsUrl,
    webrtcUrl,
    timestamp,
    status = "running",
    gpuOptions = null,
  ) {
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
   * 以新時間戳更新現有串流 URL 並回傳響應（減少重複邏輯）
   * @param {string} streamId
   * @param {number} [timestamp=Date.now()]
   * @returns {Object|null} 響應對象或 null
   * @private
   */
  _returnExistingStreamWithFreshUrl(streamId, timestamp = Date.now()) {
    const existing = this.streams.get(streamId);
    if (!existing) return null;
    const latestHlsUrl = this.generateHlsUrl(existing.pathName, timestamp);
    existing.hlsUrl = latestHlsUrl;
    existing.timestamp = timestamp;
    this.streams.set(streamId, existing);
    this._emitStreamStarted(
      streamId,
      existing.rtspUrl,
      latestHlsUrl,
      existing.webrtcUrl,
      existing.status,
    );
    return this._createStreamResponse(
      streamId,
      existing.rtspUrl,
      latestHlsUrl,
      existing.webrtcUrl,
      existing.status,
    );
  }

  /**
   * 從 axios 錯誤取得訊息字串
   * @param {Object} error
   * @returns {string}
   * @private
   */
  _getAxiosErrorMsg(error) {
    return (
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      ""
    );
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
  _emitStreamStarted(
    streamId,
    rtspUrl,
    hlsUrl,
    webrtcUrl,
    status = "running",
    gpuOptions = null,
  ) {
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

          client.once("error", () => resolve(false));

          client.connect(port, host);
        } catch (error) {
          resolve(false);
        }
      });
    } catch (error) {
      logger.error("健康檢查失敗", { error: error.message });
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
      logger.info(`添加路徑（Publisher 模式）: ${pathName}`);

      const response = await axios.post(
        `${this.apiBaseUrl}/v3/config/paths/add/${pathName}`,
        pathConfig,
        {
          timeout: this.apiTimeout,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      if (error.response) {
        const errorMsg = this._getAxiosErrorMsg(error);
        if (error.response.status === 409 || error.response.status === 400) {
          const lower = errorMsg.toLowerCase();
          if (
            lower.includes("already exists") ||
            lower.includes("already exist") ||
            lower.includes("path already")
          ) {
            logger.warn(`路徑 ${pathName} 已存在，可能非 Publisher 模式`);
            return { exists: true, needsReconfig: true };
          }
        }
        logger.error(`添加路徑失敗 (${error.response.status})`, { errorMsg });
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
      logger.info(`添加路徑: ${pathName}`, {
        source: rtspUrl.replace(/:[^:@]+@/, ":****@"),
      });

      const response = await axios.post(
        `${this.apiBaseUrl}/v3/config/paths/add/${pathName}`,
        pathConfig,
        {
          timeout: this.apiTimeout,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      return response.data;
    } catch (error) {
      if (error.response) {
        const errorMsg = this._getAxiosErrorMsg(error);
        if (error.response.status === 409 || error.response.status === 400) {
          const lower = errorMsg.toLowerCase();
          if (
            lower.includes("already exists") ||
            lower.includes("already exist") ||
            lower.includes("path already")
          ) {
            logger.info(`路徑 ${pathName} 已存在`);
            return { exists: true };
          }
        }
        logger.error(`添加路徑失敗 (${error.response.status})`, { errorMsg });
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
        },
      );
      return true;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // 路徑不存在，視為成功
        return true;
      }
      logger.error("移除路徑失敗", { error: error.message });
      throw new Error(`移除路徑失敗: ${error.message}`);
    }
  }

  /**
   * 輪詢檢查路徑是否真的被移除（統一方法）
   * @param {string} pathName - 路徑名稱
   * @param {number} maxWaitMs - 最大等待時間（毫秒），預設 2000ms
   * @param {number} checkIntervalMs - 檢查間隔（毫秒），預設 150ms
   * @returns {Promise<boolean>} 是否成功移除
   */
  async waitForPathRemoval(pathName, maxWaitMs = 2000, checkIntervalMs = 150) {
    const maxAttempts = Math.floor(maxWaitMs / checkIntervalMs);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      const checkStatus = await this.getPathStatus(pathName);
      if (!checkStatus || !checkStatus.ready) {
        const waitTime = (i + 1) * checkIntervalMs;
        logger.info(`路徑 ${pathName} 已成功移除（等待 ${waitTime}ms）`);
        return true;
      }
    }
    return false;
  }

  /**
   * 輪詢檢查路徑是否就緒（用於等待 MediaMTX 生成 HLS manifest）
   * @param {string} pathName - 路徑名稱
   * @param {number} maxWaitMs - 最大等待時間（毫秒），預設 5000ms
   * @param {number} checkIntervalMs - 檢查間隔（毫秒），預設 50ms
   * @returns {Promise<boolean>} 是否成功就緒
   */
  async waitForPathReady(pathName, maxWaitMs = 5000, checkIntervalMs = 50) {
    const maxAttempts = Math.floor(maxWaitMs / checkIntervalMs);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      const checkStatus = await this.getPathStatus(pathName);
      if (checkStatus && checkStatus.ready) {
        const waitTime = (i + 1) * checkIntervalMs;
        logger.info(`路徑 ${pathName} 已就緒（等待 ${waitTime}ms）`);
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
      logger.error("獲取路徑狀態失敗", { error: error.message });
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
      logger.error("獲取路徑狀態失敗", { error: error.message });
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
    const { useGpuEncoding = false } = options;

    const streamId = this.generateStreamId(rtspUrl);
    let pathName = this.generatePathName(rtspUrl); // 使用 let，因為可能需要在移除失敗時重新賦值

    // 防重複 start：2 秒內同一 streamId 再次請求則直接返回現有串流（減少 path already exists）
    const now = Date.now();
    const lastReq = this.lastStartRequest.get(streamId);
    if (lastReq && now - lastReq.at < this.duplicateStartCooldownMs) {
      const resp = this._returnExistingStreamWithFreshUrl(streamId, now);
      if (resp) return resp;
    }
    this.lastStartRequest.set(streamId, { at: now });

    // 如果串流已經存在，先檢查 MediaMTX 路徑狀態
    // 如果路徑已存在但串流剛停止，需要重新創建路徑以清除舊片段
    if (this.streams.has(streamId)) {
      const existingStream = this.streams.get(streamId);

      // 檢查 MediaMTX 路徑是否真的存在
      const pathStatus = await this.getPathStatus(pathName);

      if (pathStatus && pathStatus.ready) {
        return this._returnExistingStreamWithFreshUrl(streamId);
      }

      // 路徑不存在或未就緒，從記憶體中移除，重新創建
      logger.info(`串流 ${streamId} 的路徑不存在或未就緒，將重新創建`);
      this.streams.delete(streamId);
    }

    // 檢查 MediaMTX 服務健康狀態
    const isHealthy = await this.checkServiceHealth();
    if (!isHealthy) {
      throw new Error("MediaMTX 服務不可用，請確認服務已啟動");
    }

    try {
      let pathAlreadyRemoved = false;
      const existingPathStatus = await this.getPathStatus(pathName);
      if (existingPathStatus && existingPathStatus.ready) {
        logger.info(`路徑 ${pathName} 已存在，先移除以清除舊片段`);
        try {
          await this.removePath(pathName);
          const removed = await this.waitForPathRemoval(pathName, 1000, 100);
          pathAlreadyRemoved = removed;
          if (!removed) {
            logger.warn(`路徑 ${pathName} 移除超時，使用帶時間戳路徑`);
            pathName = this._generateTimestampedPathName(pathName);
          }
        } catch (removeError) {
          logger.warn("移除舊路徑失敗", { error: removeError.message });
          pathName = this._generateTimestampedPathName(pathName);
        }
      }

      let actualRtspSource = rtspUrl;
      let gpuOptions = null;

      if (useGpuEncoding) {
        const serverIP = this.getServerIP();
        const rtspOutput = `rtsp://${serverIP}:8554/${pathName}`;
        logger.info(`使用 GPU 編碼: ${streamId}`);

        if (!pathAlreadyRemoved) {
          const gpuPathStatus = await this.getPathStatus(pathName);
          if (gpuPathStatus && gpuPathStatus.ready) {
            try {
              await this.removePath(pathName);
              await this.waitForPathRemoval(pathName, 1000, 100);
            } catch (removeError) {
              logger.warn("GPU 路徑移除失敗", { error: removeError.message });
            }
          }
        }

        let addPubResult = await this.addPathForPublisher(pathName);
        if (addPubResult?.needsReconfig) {
          try {
            await this.removePath(pathName);
            await this.waitForPathRemoval(pathName, 1000, 100);
            await this.addPathForPublisher(pathName);
          } catch (e) {
            logger.warn("路徑重設失敗，繼續使用現有路徑", { error: e.message });
          }
        }

        const scale =
          process.env.RTSP_SCALE && /^\d+:\d+$/.test(process.env.RTSP_SCALE)
            ? process.env.RTSP_SCALE
            : "1920:1080";
        const bitrate =
          options.bitrate ||
          process.env.RTSP_BITRATE ||
          process.env.GPU_BITRATE ||
          "2M";
        const preset = options.preset || process.env.GPU_PRESET || "p4";
        const validBitrate = /^\d+M?$/.test(String(bitrate).trim())
          ? String(bitrate).trim()
          : "2M";
        const validPreset = /^p[1-7]$/.test(String(preset).trim())
          ? String(preset).trim()
          : "p4";

        ffmpegService.startGpuEncoding(streamId, rtspUrl, rtspOutput, {
          scale,
          bitrate: validBitrate,
          preset: validPreset,
        });
        const ok = await ffmpegService.waitForProcessStable(
          streamId,
          800,
          5000,
          100,
        );
        if (!ok) {
          const last = ffmpegService.getLastError(streamId);
          const ffmpegError = last?.error || "FFmpeg GPU 編碼啟動失敗";

          await ffmpegService.stopGpuEncoding(streamId);
          try {
            await this.removePath(pathName);
          } catch (_) {}

          throw new Error(
            generateErrorMessage({
              ffmpegError,
              isStillRunning: ffmpegService.isRunning(streamId),
              ffmpegReady: false,
            }),
          );
        }

        actualRtspSource = null;
        gpuOptions = { useGpuEncoding: true };

        // GPU 早回傳：FFmpeg 穩定後立即回傳，路徑就緒改為背景檢查
        const timestamp = Date.now();
        const hlsUrl = this.generateHlsUrl(pathName, timestamp);
        const webrtcUrl = this.generateWebRTCUrl(pathName);
        const streamInfo = this._createStreamInfo(
          streamId,
          pathName,
          rtspUrl,
          hlsUrl,
          webrtcUrl,
          timestamp,
          "running",
          gpuOptions,
        );
        this.streams.set(streamId, streamInfo);
        this._emitStreamStarted(
          streamId,
          rtspUrl,
          hlsUrl,
          webrtcUrl,
          "running",
          gpuOptions,
        );
        logger.info(
          `串流已回傳（早回傳）: ${streamId}，路徑 ${pathName} 背景就緒中`,
        );

        // 背景等待路徑就緒；失敗則清理並推送錯誤
        (async () => {
          const ready = await this.waitForPathReady(pathName, 5000, 50);
          if (!ready) {
            try {
              await ffmpegService.stopGpuEncoding(streamId);
            } catch (_) {}
            try {
              await this.removePath(pathName);
            } catch (_) {}
            this.streams.delete(streamId);
            this.lastStartRequest.delete(streamId);
            websocketService.emitRTSPStreamError({
              streamId,
              error: new Error(
                `HLS manifest 尚未就緒（${pathName}），請稍後重試`,
              ),
            });
            logger.error(`路徑 ${pathName} 背景就緒失敗，已清理`);
          }
        })();

        return this._createStreamResponse(streamId, rtspUrl, hlsUrl, webrtcUrl);
      }

      let addPathResult = null;
      if (actualRtspSource) {
        addPathResult = await this.addPath(pathName, actualRtspSource);
      }

      const timestamp = Date.now();
      const hlsUrl = this.generateHlsUrl(pathName, timestamp);
      const webrtcUrl = this.generateWebRTCUrl(pathName);

      const streamInfo = this._createStreamInfo(
        streamId,
        pathName,
        rtspUrl,
        hlsUrl,
        webrtcUrl,
        timestamp,
        "running",
        gpuOptions,
      );
      this.streams.set(streamId, streamInfo);

      const isExistingPath = addPathResult && addPathResult.exists;
      if (isExistingPath) {
        logger.info(`路徑 ${pathName} 已存在，等待重新初始化`);
      } else {
        logger.info(`等待路徑 ${pathName} 就緒`);
      }

      const ready = await this.waitForPathReady(pathName, 5000, 50);
      if (!ready) {
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
      this._emitStreamStarted(
        streamId,
        rtspUrl,
        hlsUrl,
        webrtcUrl,
        "running",
        gpuOptions,
      );
      logger.info(`串流啟動成功: ${streamId} (路徑: ${pathName})`);

      return this._createStreamResponse(streamId, rtspUrl, hlsUrl, webrtcUrl);
    } catch (error) {
      // 如果使用 GPU 編碼，停止 FFmpeg 進程
      if (useGpuEncoding) {
        try {
          await ffmpegService.stopGpuEncoding(streamId);
        } catch (ffmpegError) {
          logger.error("清理 FFmpeg 進程失敗", { error: ffmpegError.message });
        }
      }
      this.streams.delete(streamId);
      this.lastStartRequest.delete(streamId);

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
        logger.info(`停止 FFmpeg GPU 編碼進程: ${streamId}`);
        await ffmpegService.stopGpuEncoding(streamId);
      }

      await this.removePath(streamInfo.pathName);
      const removed = await this.waitForPathRemoval(
        streamInfo.pathName,
        2000,
        150,
      );
      if (!removed) {
        logger.warn(`路徑 ${streamInfo.pathName} 移除超時，繼續停止流程`);
      }

      // 從記憶體中移除
      this.streams.delete(streamId);
      this.lastStartRequest.delete(streamId);

      // 推送 WebSocket 事件（整合 WebSocket 推送）
      websocketService.emitRTSPStreamStopped({ streamId });

      logger.info(`串流已停止: ${streamId}`);

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
          logger.error("停止 FFmpeg 進程失敗", { error: ffmpegError.message });
        }
      }

      // 即使移除失敗，也從記憶體中移除
      this.streams.delete(streamId);
      this.lastStartRequest.delete(streamId);

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
      streamIds.map((id) => this.stopStream(id)),
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
