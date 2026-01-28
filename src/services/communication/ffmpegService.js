const { spawn } = require("child_process");
const EventEmitter = require("events");
const { resolveFfmpegPath } = require("../../utils/ffmpegPath");
const {
  DEFAULT_CONFIG,
  getRtspInputOptions,
  buildNvencArgs,
  buildQsvArgs,
  buildAmfArgs,
  isCriticalError,
  isWarningOrError,
} = require("../../config/ffmpegConfig");

let _ffmpegPathLogged = false;

/**
 * 獲取 FFmpeg 執行檔路徑（動態解析，確保使用最新版本）
 * 不使用緩存，每次都重新解析，確保能找到最新下載的 FFmpeg
 * @returns {string} FFmpeg 執行檔路徑
 */
function getFfmpegBin() {
  // 每次都重新解析，不使用緩存
  // 這樣即使服務器啟動後才下載 FFmpeg，也能找到最新版本
  return resolveFfmpegPath(__dirname);
}

/**
 * FFmpeg GPU 硬體編碼服務
 * 
 * 負責管理 FFmpeg 進程，實現 GPU 硬體加速編碼
 * 支援 NVIDIA NVENC、Intel Quick Sync Video、AMD VCE
 * 
 * @class FFmpegService
 * @extends EventEmitter
 */
class FFmpegService extends EventEmitter {
  constructor() {
    super();
    /**
     * 存儲所有活躍的 FFmpeg 進程
     * Map<streamId, ProcessInfo>
     * 
     * @typedef {Object} ProcessInfo
     * @property {ChildProcess} process - FFmpeg 子進程
     * @property {Object} options - 編碼選項
     * @property {string} rtspInput - RTSP 輸入 URL
     * @property {string} rtspOutput - RTSP 輸出 URL
     * @property {Date} startedAt - 啟動時間
     * @property {NodeJS.Timeout|null} killTimeout - 強制終止的 timeout ID
     */
    this.processes = new Map();

    // 保留最近一次錯誤（避免 processInfo 被刪掉後無法取錯誤）
    // streamId -> { error: string, at: Date }
    this.lastErrors = new Map();
  }

  /**
   * 啟動 FFmpeg GPU 編碼進程
   * 
   * @param {string} streamId - 串流 ID（唯一標識符）
   * @param {string} rtspInput - RTSP 輸入 URL（來源串流）
   * @param {string} rtspOutput - RTSP 輸出 URL（目標串流）
   * @param {Object} [options={}] - 編碼選項
   * @param {string} [options.gpuType='nvidia'] - GPU 類型: 'nvidia', 'intel', 'amd'
   * @param {string} [options.bitrate='2M'] - 位元率，例如 '2M', '4M'
   * @param {string} [options.preset='p4'] - 編碼預設值（NVIDIA 使用 p1-p7）
   * @param {number} [options.gpuIndex=0] - GPU 索引（多 GPU 系統）
   * @returns {ChildProcess} FFmpeg 進程對象
   * @throws {Error} 如果 GPU 類型不支援或參數無效
   */
  startGpuEncoding(streamId, rtspInput, rtspOutput, options = {}) {
    // 驗證參數
    if (!streamId || typeof streamId !== "string") {
      throw new Error("streamId 必須是非空字符串");
    }
    if (!rtspInput || typeof rtspInput !== "string") {
      throw new Error("rtspInput 必須是非空字符串");
    }
    if (!rtspOutput || typeof rtspOutput !== "string") {
      throw new Error("rtspOutput 必須是非空字符串");
    }

    // 簡化配置：固定使用 NVIDIA，使用默認參數
    const config = {
      gpuType: "nvidia", // 固定使用 NVIDIA
    };

    // 檢查是否已經有進程在運行
    if (this.processes.has(streamId)) {
      console.warn(
        `[FFmpeg Service] 串流 ${streamId} 的 FFmpeg 進程已存在，先停止舊進程`
      );
      // 異步停止舊進程（不等待完成）
      this.stopGpuEncoding(streamId).catch((err) => {
        console.error(
          `[FFmpeg Service] 停止舊進程失敗: ${err.message}`
        );
      });
    }

    // 清除上一輪錯誤（避免讀到舊錯誤）
    this.lastErrors.delete(streamId);

    // 構建 FFmpeg 命令參數
    const args = this._buildFFmpegArgs(rtspInput, rtspOutput, config);

    // 記錄啟動信息
    console.log(`[FFmpeg Service] 啟動 GPU 編碼進程: ${streamId}`, {
      gpuType: config.gpuType,
      rtspInput: this._maskPassword(rtspInput),
      rtspOutput,
    });

    // 動態獲取 FFmpeg 執行檔路徑（確保使用最新版本）
    const ffmpegBin = getFfmpegBin();

    // 記錄 FFmpeg 執行檔路徑（僅記錄一次）
    if (!_ffmpegPathLogged) {
      _ffmpegPathLogged = true;
      console.log(`[FFmpeg Service] 使用 FFmpeg 執行檔: ${ffmpegBin}`);
    }

    // 啟動 FFmpeg 進程
    const ffmpeg = spawn(ffmpegBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 設置事件監聽器
    this._setupProcessHandlers(ffmpeg, streamId);

    // 存儲進程信息
    this.processes.set(streamId, {
      process: ffmpeg,
      options: config,
      rtspInput,
      rtspOutput,
      startedAt: new Date(),
      killTimeout: null,
    });

    return ffmpeg;
  }

  /**
   * 構建 FFmpeg 命令參數
   * @private
   * @param {string} rtspInput - RTSP 輸入 URL
   * @param {string} rtspOutput - RTSP 輸出 URL
   * @param {Object} config - 編碼配置
   * @returns {Array<string>} FFmpeg 參數陣列
   */
  _buildFFmpegArgs(rtspInput, rtspOutput, config) {
    const args = [];

    // 動態獲取 RTSP 輸入選項（根據 FFmpeg 版本）
    const ffmpegBin = getFfmpegBin();
    const rtspOptions = getRtspInputOptions(ffmpegBin);
    args.push(...rtspOptions);

    // 輸入 URL
    args.push("-i", rtspInput);

    // 根據 GPU 類型添加視訊編碼參數
    switch (config.gpuType) {
      case "nvidia":
        args.push(...buildNvencArgs(config));
        break;
      case "intel":
        args.push(...buildQsvArgs(config));
        break;
      case "amd":
        args.push(...buildAmfArgs(config));
        break;
      default:
        throw new Error(`不支援的 GPU 類型: ${config.gpuType}`);
    }

    // 音訊處理（如果輸入有音訊則複製，沒有則跳過）
    args.push("-c:a", "copy");

    // RTSP 輸出選項
    // -flags +global_header: RTSP 容器需要 global headers（關鍵：確保編碼器參數與容器兼容）
    // -rtsp_transport tcp: 使用 TCP 傳輸（更穩定）
    // -fflags +nobuffer+flush_packets: 低延遲設置
    // -f rtsp: RTSP 輸出格式
    // 注意：h264_nvenc 已經輸出 Annex-B 格式，不需要額外的 bitstream filter
    args.push(
      "-flags", "+global_header",
      "-fflags", "+nobuffer+flush_packets",
      "-rtsp_transport", "tcp",
      "-f", "rtsp",
      rtspOutput
    );

    return args;
  }

  /**
   * 設置 FFmpeg 進程的事件處理器
   * @private
   * @param {ChildProcess} ffmpeg - FFmpeg 進程
   * @param {string} streamId - 串流 ID
   */
  _setupProcessHandlers(ffmpeg, streamId) {
    // 處理標準輸出
    ffmpeg.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[FFmpeg ${streamId}] ${output}`);
      }
    });

    // 處理標準錯誤輸出（FFmpeg 通常將信息輸出到 stderr）
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      this._handleStderrOutput(output, streamId);
    });

    // 處理進程退出
    ffmpeg.on("exit", (code, signal) => {
      this._handleProcessExit(streamId, code, signal);
    });

    // 處理進程錯誤
    ffmpeg.on("error", (error) => {
      this._handleProcessError(streamId, error);
    });
  }

  /**
   * 處理 FFmpeg stderr 輸出
   * @private
   * @param {string} output - 輸出文本
   * @param {string} streamId - 串流 ID
   */
  _handleStderrOutput(output, streamId) {
    const trimmed = output.trim();
    if (!trimmed) return;

    // 性能監控：檢測編碼速度
    const speedMatch = trimmed.match(/speed=\s*([\d.]+)x/);
    if (speedMatch) {
      const speed = parseFloat(speedMatch[1]);
      const processInfo = this.processes.get(streamId);
      if (processInfo) {
        // 記錄編碼速度
        if (!processInfo.speedHistory) {
          processInfo.speedHistory = [];
        }
        processInfo.speedHistory.push({ speed, timestamp: Date.now() });
        
        // 只保留最近 10 次記錄
        if (processInfo.speedHistory.length > 10) {
          processInfo.speedHistory.shift();
        }

        // 如果編碼速度持續低於 0.8x，發出警告
        if (speed < 0.8 && processInfo.speedHistory.length >= 3) {
          const recentSpeeds = processInfo.speedHistory.slice(-3).map(s => s.speed);
          const avgSpeed = recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length;
          if (avgSpeed < 0.8 && !processInfo.speedWarningShown) {
            processInfo.speedWarningShown = true;
            console.warn(
              `[FFmpeg ${streamId}] ⚠️ 編碼速度過慢（${avgSpeed.toFixed(2)}x），會導致延遲累積。` +
              `建議：1) 降低解析度（已自動縮放到 1080p） 2) 或使用 MediaMTX 直接拉取（不勾選 GPU 編碼）`
            );
          }
        }
      }
    }

    if (isCriticalError(output)) {
      // 嚴重錯誤：記錄並觸發錯誤事件
      console.error(`[FFmpeg ${streamId}] 嚴重錯誤: ${trimmed}`);
      this._emitErrorSafely(streamId, trimmed);
    } else if (isWarningOrError(output)) {
      // 一般錯誤或警告：記錄但不觸發錯誤事件
      console.warn(`[FFmpeg ${streamId}] ${trimmed}`);
    } else {
      // 一般信息：正常記錄
      console.log(`[FFmpeg ${streamId}] ${trimmed}`);
    }
  }

  /**
   * 處理進程退出
   * @private
   * @param {string} streamId - 串流 ID
   * @param {number|null} code - 退出代碼
   * @param {string|null} signal - 退出信號
   */
  _handleProcessExit(streamId, code, signal) {
    console.log(
      `[FFmpeg Service] 進程退出: ${streamId}, 代碼: ${code}, 信號: ${signal}`
    );

    // 發出 exit 事件
    this.emit("exit", { streamId, code, signal });

    // 如果不是正常退出，記錄錯誤並發出錯誤事件
    if (code !== 0 && code !== null) {
      const errorMsg = `FFmpeg 進程異常退出，代碼: ${code}${signal ? `, 信號: ${signal}` : ""}`;
      this._emitErrorSafely(streamId, errorMsg);
    }

    // 從 Map 中移除（確保所有事件都已發出）
    this.processes.delete(streamId);
  }

  /**
   * 處理進程錯誤
   * @private
   * @param {string} streamId - 串流 ID
   * @param {Error} error - 錯誤對象
   */
  _handleProcessError(streamId, error) {
    console.error(`[FFmpeg Service] 進程錯誤: ${streamId}`, error);
    this.processes.delete(streamId);
    this._emitErrorSafely(streamId, error.message);
  }

  /**
   * 安全地發出錯誤事件（避免未處理的錯誤導致服務器崩潰）
   * @private
   * @param {string} streamId - 串流 ID
   * @param {string} error - 錯誤訊息
   */
  _emitErrorSafely(streamId, error) {
    // 紀錄最近錯誤（即使沒有 listener 也要能查到）
    this.lastErrors.set(streamId, { error, at: new Date() });

    // 使用 setImmediate 確保錯誤事件在事件循環的下一個階段處理
    setImmediate(() => {
      if (this.listenerCount("error") > 0) {
        this.emit("error", { streamId, error });
      } else {
        console.warn(
          `[FFmpeg Service] 錯誤但沒有錯誤監聽器: ${streamId}, ${error}`
        );
      }
    });
  }

  /**
   * 隱藏 URL 中的密碼
   * @private
   * @param {string} url - 包含密碼的 URL
   * @returns {string} 隱藏密碼後的 URL
   */
  _maskPassword(url) {
    return url.replace(/:[^:@]+@/, ":****@");
  }

  /**
   * 停止 FFmpeg 進程
   * 
   * @param {string} streamId - 串流 ID
   * @returns {Promise<boolean>} 是否成功停止
   */
  async stopGpuEncoding(streamId) {
    const processInfo = this.processes.get(streamId);
    if (!processInfo) {
      console.warn(
        `[FFmpeg Service] 串流 ${streamId} 的 FFmpeg 進程不存在`
      );
      return false;
    }

    const { process, killTimeout } = processInfo;

    // 清理之前的強制終止 timeout（如果存在）
    if (killTimeout) {
      clearTimeout(killTimeout);
      processInfo.killTimeout = null;
    }

    try {
      // 如果進程已經退出，直接清理
      if (process.killed || process.exitCode !== null) {
        this.processes.delete(streamId);
        this.lastErrors.delete(streamId);
        return true;
      }

      // 先嘗試優雅地停止（發送 SIGTERM）
      process.kill("SIGTERM");

      // 等待進程退出（最多 5 秒）
      const exitPromise = new Promise((resolve) => {
        if (process.killed || process.exitCode !== null) {
          resolve(true);
          return;
        }

        const onExit = () => {
          process.removeListener("exit", onExit);
          resolve(true);
        };
        process.once("exit", onExit);
      });

      const timeoutPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!process.killed && process.exitCode === null) {
            console.warn(
              `[FFmpeg Service] 串流 ${streamId} 的 FFmpeg 進程未正常退出，強制終止`
            );
            try {
              process.kill("SIGKILL");
            } catch (killError) {
              console.error(
                `[FFmpeg Service] 強制終止失敗: ${killError.message}`
              );
            }
          }
          resolve(false);
        }, 5000);

        // 存儲 timeout ID 以便清理
        processInfo.killTimeout = timeout;
      });

      await Promise.race([exitPromise, timeoutPromise]);

      // 清理 timeout（如果還在）
      if (processInfo.killTimeout) {
        clearTimeout(processInfo.killTimeout);
        processInfo.killTimeout = null;
      }

      this.processes.delete(streamId);
      this.lastErrors.delete(streamId);
      console.log(`[FFmpeg Service] 已停止串流 ${streamId} 的 FFmpeg 進程`);
      return true;
    } catch (error) {
      console.error(
        `[FFmpeg Service] 停止串流 ${streamId} 的 FFmpeg 進程失敗:`,
        error.message
      );
      // 即使出錯也從 Map 中移除
      this.processes.delete(streamId);
      this.lastErrors.delete(streamId);
      return false;
    }
  }

  /**
   * 取得最近一次錯誤（若有）
   * @param {string} streamId
   * @returns {{error: string, at: Date} | null}
   */
  getLastError(streamId) {
    return this.lastErrors.get(streamId) || null;
  }

  /**
   * 等待 FFmpeg 進程「穩定」一段時間後再視為啟動成功
   * 目的：避免剛啟動就因 encoder 參數/驅動問題秒退，卻被當成成功。
   *
   * @param {string} streamId
   * @param {number} stableMs - 需要連續存活的時間
   * @param {number} maxWaitMs - 最大等待時間
   * @param {number} checkIntervalMs - 輪詢間隔
   * @returns {Promise<boolean>}
   */
  async waitForProcessStable(
    streamId,
    stableMs = 1000,
    maxWaitMs = 5000,
    checkIntervalMs = 100
  ) {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= maxWaitMs) {
      // 若已經出現錯誤，直接失敗
      if (this.lastErrors.has(streamId)) return false;

      const info = this.processes.get(streamId);
      if (!info) return false;

      const running = this.isRunning(streamId);
      if (!running) return false;

      const aliveMs = Date.now() - info.startedAt.getTime();
      if (aliveMs >= stableMs) return true;

      await new Promise((r) => setTimeout(r, checkIntervalMs));
    }

    // 超時仍未達到穩定時間
    return false;
  }

  /**
   * 檢查 FFmpeg 進程是否正在運行
   * 
   * @param {string} streamId - 串流 ID
   * @returns {boolean} 是否正在運行
   */
  isRunning(streamId) {
    const processInfo = this.processes.get(streamId);
    if (!processInfo) {
      return false;
    }

    const { process } = processInfo;
    return !process.killed && process.exitCode === null;
  }

  /**
   * 獲取所有活躍的 FFmpeg 進程信息
   * 
   * @returns {Array<Object>} 進程信息陣列
   */
  getAllProcesses() {
    const processes = [];
    for (const [streamId, processInfo] of this.processes.entries()) {
      const { process, options, rtspInput, rtspOutput, startedAt } =
        processInfo;
      processes.push({
        streamId,
        isRunning: this.isRunning(streamId),
        options,
        rtspInput: this._maskPassword(rtspInput),
        rtspOutput,
        startedAt,
      });
    }
    return processes;
  }

  /**
   * 停止所有 FFmpeg 進程
   * 
   * @returns {Promise<Array>} 停止結果陣列（Promise.allSettled 格式）
   */
  async stopAllProcesses() {
    const streamIds = Array.from(this.processes.keys());
    const results = await Promise.allSettled(
      streamIds.map((id) => this.stopGpuEncoding(id))
    );
    return results;
  }

}

// 導出單例
module.exports = new FFmpegService();
