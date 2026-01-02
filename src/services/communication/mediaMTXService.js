const axios = require("axios");
const crypto = require("crypto");
const EventEmitter = require("events");
const os = require("os");

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
    const webrtcHost = process.env.MEDIAMTX_WEBRTC_URL || `http://${serverIP}:8889`;
    this.webrtcBaseUrl = webrtcHost;
    
    // 存儲所有活躍的串流
    this.streams = new Map();
    // API 請求超時時間（毫秒）
    this.apiTimeout = 10000;
    
    // 路徑狀態緩存（優化性能：減少 API 請求）
    this.pathStatusCache = new Map();
    this.lastStatusUpdate = 0;
    this.statusUpdateInterval = 2000; // 批量更新間隔 2 秒
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
   * 添加路徑配置到 MediaMTX
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
      console.log(`[MediaMTX Service] 添加路徑: ${pathName}, 來源: ${rtspUrl.replace(/:[^:@]+@/, ':****@')}`);

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
          const errorMsg = error.response.data?.error || error.response.data?.message || error.message || '';
          // 檢查錯誤訊息是否包含 "already exists" 或類似的關鍵字
          const errorMsgLower = errorMsg.toLowerCase();
          if (errorMsgLower.includes('already exists') || errorMsgLower.includes('already exist') || errorMsgLower.includes('path already')) {
            console.log(`[MediaMTX Service] 路徑 ${pathName} 已存在`);
            return { exists: true };
          }
        }
        // 顯示詳細錯誤訊息
        const errorMsg = error.response.data?.error || error.response.data?.message || error.message;
        console.error(`[MediaMTX Service] 添加路徑失敗 (${error.response.status}):`, errorMsg);
        console.error(`[MediaMTX Service] 請求配置:`, JSON.stringify(pathConfig, null, 2));
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
      await axios.post(`${this.apiBaseUrl}/v3/config/paths/remove/${pathName}`, {}, {
        timeout: this.apiTimeout,
      });
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
   * 獲取所有路徑狀態（批量獲取，使用緩存優化性能）
   * @returns {Promise<Map<string, Object>>}
   */
  async getAllPathsStatus() {
    const now = Date.now();
    
    // 如果緩存未過期，直接返回緩存
    if (now - this.lastStatusUpdate < this.statusUpdateInterval && this.pathStatusCache.size > 0) {
      return this.pathStatusCache;
    }

    try {
      const response = await axios.get(
        `${this.apiBaseUrl}/v3/paths/list`,
        {
          timeout: this.apiTimeout,
        }
      );

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
   * @returns {Promise<{streamId: string, hlsUrl: string, webrtcUrl: string, status: string}>}
   */
  async startStream(rtspUrl) {
    if (!rtspUrl || typeof rtspUrl !== "string") {
      throw new Error("RTSP URL 是必需的");
    }

    // 驗證 RTSP URL 格式
    if (!rtspUrl.startsWith("rtsp://")) {
      throw new Error("無效的 RTSP URL 格式，必須以 rtsp:// 開頭");
    }

    const streamId = this.generateStreamId(rtspUrl);
    const pathName = this.generatePathName(rtspUrl);

    // 如果串流已經存在，返回現有資訊
    if (this.streams.has(streamId)) {
      const existingStream = this.streams.get(streamId);
      return {
        streamId,
        hlsUrl: existingStream.hlsUrl,
        webrtcUrl: existingStream.webrtcUrl,
        status: existingStream.status,
        rtspUrl: existingStream.rtspUrl,
      };
    }

    // 檢查 MediaMTX 服務健康狀態
    const isHealthy = await this.checkServiceHealth();
    if (!isHealthy) {
      throw new Error("MediaMTX 服務不可用，請確認服務已啟動");
    }

    try {
      // 添加路徑到 MediaMTX
      const addPathResult = await this.addPath(pathName, rtspUrl);

      // 如果路徑已存在，檢查是否已經在我們的記錄中
      if (addPathResult && addPathResult.exists) {
        // 路徑已存在，嘗試獲取現有路徑的狀態
        const pathStatus = await this.getPathStatus(pathName);
        if (pathStatus && pathStatus.ready) {
          // 路徑存在且就緒，生成播放 URL 並添加到記錄
          const hlsUrl = `${this.hlsBaseUrl}/${pathName}/index.m3u8`;
          const webrtcUrl = `${this.webrtcBaseUrl}/${pathName}`;

          const streamInfo = {
            streamId,
            pathName,
            rtspUrl,
            hlsUrl,
            webrtcUrl,
            status: "running",
            startedAt: new Date(),
          };

          this.streams.set(streamId, streamInfo);

          console.log(`[MediaMTX Service] 串流已存在並就緒: ${streamId} (路徑: ${pathName})`);

          return {
            streamId,
            hlsUrl,
            webrtcUrl,
            status: "running",
            rtspUrl,
          };
        }
      }

      // 生成播放 URL
      const hlsUrl = `${this.hlsBaseUrl}/${pathName}/index.m3u8`;
      const webrtcUrl = `${this.webrtcBaseUrl}/${pathName}`;

      // 存儲串流資訊
      const streamInfo = {
        streamId,
        pathName,
        rtspUrl,
        hlsUrl,
        webrtcUrl,
        status: "running",
        startedAt: new Date(),
      };

      this.streams.set(streamId, streamInfo);

      console.log(`[MediaMTX Service] 串流啟動成功: ${streamId} (路徑: ${pathName})`);

      return {
        streamId,
        hlsUrl,
        webrtcUrl,
        status: streamInfo.status,
        rtspUrl,
      };
    } catch (error) {
      // 清理失敗的串流
      this.streams.delete(streamId);
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
      // 從 MediaMTX 移除路徑
      await this.removePath(streamInfo.pathName);

      // 從記憶體中移除
      this.streams.delete(streamId);

      console.log(`[MediaMTX Service] 串流已停止: ${streamId}`);

      return {
        success: true,
        message: `串流 ${streamId} 已停止`,
      };
    } catch (error) {
      // 即使移除失敗，也從記憶體中移除
      this.streams.delete(streamId);
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
}

// 導出單例
module.exports = new MediaMTXService();

