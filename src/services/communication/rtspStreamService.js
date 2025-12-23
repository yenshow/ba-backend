const EventEmitter = require("events");
const mediaMTXService = require("./mediaMTXService");

/**
 * RTSP 串流服務（使用 MediaMTX）
 * 此服務作為 MediaMTX 的封裝層，提供與原有 API 兼容的介面
 */
class RTSPStreamService extends EventEmitter {
  constructor() {
    super();
    // 將 MediaMTX 服務的事件轉發
    this._setupEventForwarding();
  }

  /**
   * 設置事件轉發（從 MediaMTX 服務轉發事件）
   * @private
   */
  _setupEventForwarding() {
    // 監聽 MediaMTX 服務的事件並轉發
    mediaMTXService.on("error", (errorInfo) => {
      this.emit("error", errorInfo);
    });

    mediaMTXService.on("end", (streamInfo) => {
      this.emit("end", streamInfo);
    });
  }

  /**
   * 生成串流 ID（基於 RTSP URL）
   * @param {string} rtspUrl - RTSP 串流 URL
   * @returns {string} 串流 ID
   */
  generateStreamId(rtspUrl) {
    return mediaMTXService.generateStreamId(rtspUrl);
  }

  /**
   * 啟動 RTSP 串流轉換為 HLS
   * @param {string} rtspUrl - RTSP 串流 URL
   * @returns {Promise<{streamId: string, hlsUrl: string, status: string}>}
   */
  async startStream(rtspUrl) {
    try {
      const result = await mediaMTXService.startStream(rtspUrl);
      
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
      throw error;
    }
  }

  /**
   * 停止 RTSP 串流
   * @param {string} streamId - 串流 ID
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async stopStream(streamId) {
    try {
      return await mediaMTXService.stopStream(streamId);
    } catch (error) {
      throw error;
    }
  }

  /**
   * 獲取串流狀態
   * @param {string} streamId - 串流 ID（可選，不提供則返回所有串流）
   * @returns {Object|Array|null}
   */
  async getStreamStatus(streamId = null) {
    try {
      return await mediaMTXService.getStreamStatus(streamId);
    } catch (error) {
      console.error(`[RTSP Stream Service] 獲取串流狀態失敗:`, error.message);
      // 如果 MediaMTX 服務不可用，返回記憶體中的狀態
      if (streamId) {
        const stream = mediaMTXService.streams.get(streamId);
        if (stream) {
          return {
            streamId: stream.streamId,
            rtspUrl: stream.rtspUrl,
            hlsUrl: stream.hlsUrl,
            webrtcUrl: stream.webrtcUrl,
            status: "unknown",
            startedAt: stream.startedAt,
          };
        }
        return null;
      }
      // 返回所有串流
      return Array.from(mediaMTXService.streams.values()).map((stream) => ({
        streamId: stream.streamId,
        rtspUrl: stream.rtspUrl,
        hlsUrl: stream.hlsUrl,
        webrtcUrl: stream.webrtcUrl,
        status: "unknown",
        startedAt: stream.startedAt,
      }));
    }
  }

  /**
   * 停止所有串流
   * @returns {Promise<Array>}
   */
  async stopAllStreams() {
    return await mediaMTXService.stopAllStreams();
  }

  /**
   * 清理 HLS 文件（MediaMTX 自動管理，此方法保留以維持 API 兼容性）
   * @param {string} streamId - 串流 ID
   */
  cleanupHlsFiles(streamId) {
    // MediaMTX 自動管理文件，無需手動清理
    console.log(`[RTSP Stream Service] MediaMTX 自動管理文件，無需手動清理: ${streamId}`);
  }
}

// 導出單例
module.exports = new RTSPStreamService();
