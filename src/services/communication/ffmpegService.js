const { spawn } = require("child_process");
const EventEmitter = require("events");
const { resolveFfmpegPath } = require("../../utils/ffmpegPath");

const FFMPEG_BIN = resolveFfmpegPath(__dirname);
let _ffmpegPathLogged = false;

/**
 * FFmpeg 服務管理類別
 * 負責管理 FFmpeg GPU 硬體編碼進程
 */
class FFmpegService extends EventEmitter {
  constructor() {
    super();
    // 存儲所有活躍的 FFmpeg 進程
    // streamId -> { process, options, rtspInput, rtspOutput }
    this.processes = new Map();
  }

  /**
   * 啟動 FFmpeg GPU 編碼進程
   * @param {string} streamId - 串流 ID
   * @param {string} rtspInput - RTSP 輸入 URL
   * @param {string} rtspOutput - RTSP 輸出 URL
   * @param {Object} options - 編碼選項
   * @param {string} options.gpuType - GPU 類型: 'nvidia', 'intel', 'amd'
   * @param {string} options.bitrate - 位元率，例如 '2M'
   * @param {string} options.preset - 編碼預設值（NVIDIA 使用）
   * @returns {Object} FFmpeg 進程對象
   */
  startGpuEncoding(streamId, rtspInput, rtspOutput, options = {}) {
    const {
      gpuType = "nvidia",
      bitrate = "2M",
      preset = "p4",
    } = options;

    // 檢查是否已經有進程在運行
    if (this.processes.has(streamId)) {
      console.warn(
        `[FFmpeg Service] 串流 ${streamId} 的 FFmpeg 進程已存在，先停止舊進程`
      );
      this.stopGpuEncoding(streamId);
    }

    // 構建 FFmpeg 命令參數
    const args = this.buildFFmpegArgs(rtspInput, rtspOutput, {
      gpuType,
      bitrate,
      preset,
    });

    console.log(
      `[FFmpeg Service] 啟動 GPU 編碼進程: ${streamId}`,
      {
        gpuType,
        bitrate,
        preset,
        rtspInput: rtspInput.replace(/:[^:@]+@/, ":****@"), // 隱藏密碼
        rtspOutput,
      }
    );

    if (!_ffmpegPathLogged) {
      _ffmpegPathLogged = true;
      console.log(`[FFmpeg Service] 使用 FFmpeg 執行檔: ${FFMPEG_BIN}`);
    }

    // 啟動 FFmpeg 進程
    const ffmpeg = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 處理標準輸出
    ffmpeg.stdout.on("data", (data) => {
      const output = data.toString();
      console.log(`[FFmpeg ${streamId}] ${output.trim()}`);
    });

    // 處理標準錯誤輸出（FFmpeg 通常將信息輸出到 stderr）
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      // 檢查是否為嚴重錯誤訊息（排除警告）
      const isCriticalError = 
        (output.toLowerCase().includes("error initializing") ||
         output.toLowerCase().includes("error while opening encoder") ||
         output.toLowerCase().includes("unable to parse option") ||
         output.toLowerCase().includes("error setting option")) &&
        !output.toLowerCase().includes("warning");
      
      if (isCriticalError) {
        console.error(`[FFmpeg ${streamId}] ${output.trim()}`);
        // 使用 setImmediate 避免在事件處理過程中觸發錯誤
        setImmediate(() => {
          // 檢查是否有監聽器，避免未處理的錯誤導致服務器崩潰
          if (this.listenerCount("error") > 0) {
            this.emit("error", { streamId, error: output });
          } else {
            console.warn(
              `[FFmpeg Service] 嚴重錯誤但沒有錯誤監聽器: ${streamId}`
            );
          }
        });
      } else if (
        output.toLowerCase().includes("error") ||
        output.toLowerCase().includes("failed") ||
        output.toLowerCase().includes("cannot")
      ) {
        // 一般錯誤或警告，記錄但不觸發錯誤事件
        console.warn(`[FFmpeg ${streamId}] ${output.trim()}`);
      } else {
        // 一般信息輸出
        console.log(`[FFmpeg ${streamId}] ${output.trim()}`);
      }
    });

    // 處理進程退出
    ffmpeg.on("exit", (code, signal) => {
      console.log(
        `[FFmpeg Service] 進程退出: ${streamId}, 代碼: ${code}, 信號: ${signal}`
      );
      
      // 先發出 exit 事件
      this.emit("exit", { streamId, code, signal });
      
      // 如果不是正常退出（code !== 0），發出錯誤事件
      // 使用 setImmediate 確保錯誤事件在事件循環的下一個階段處理，避免未處理的錯誤導致崩潰
      if (code !== 0 && code !== null) {
        setImmediate(() => {
          // 檢查是否有監聽器，避免未處理的錯誤導致服務器崩潰
          if (this.listenerCount("error") > 0) {
            this.emit("error", {
              streamId,
              error: `FFmpeg 進程異常退出，代碼: ${code}`,
            });
          } else {
            console.warn(
              `[FFmpeg Service] 進程異常退出但沒有錯誤監聽器: ${streamId}, 代碼: ${code}`
            );
          }
        });
      }
      
      // 最後才從 Map 中移除（確保所有事件都已發出）
      this.processes.delete(streamId);
    });

    // 處理進程錯誤
    ffmpeg.on("error", (error) => {
      console.error(`[FFmpeg Service] 進程錯誤: ${streamId}`, error);
      this.processes.delete(streamId);
      // 使用 setImmediate 確保錯誤事件在事件循環的下一個階段處理
      setImmediate(() => {
        // 檢查是否有監聽器，避免未處理的錯誤導致服務器崩潰
        if (this.listenerCount("error") > 0) {
          this.emit("error", { streamId, error: error.message });
        } else {
          console.warn(
            `[FFmpeg Service] 進程錯誤但沒有錯誤監聽器: ${streamId}, ${error.message}`
          );
        }
      });
    });

    // 存儲進程信息
    this.processes.set(streamId, {
      process: ffmpeg,
      options: { gpuType, bitrate, preset },
      rtspInput,
      rtspOutput,
      startedAt: new Date(),
      killTimeout: null, // 用於存儲強制終止的 timeout ID
    });

    return ffmpeg;
  }

  /**
   * 構建 FFmpeg 命令參數
   * @param {string} rtspInput - RTSP 輸入 URL
   * @param {string} rtspOutput - RTSP 輸出 URL
   * @param {Object} options - 編碼選項
   * @returns {Array<string>} FFmpeg 參數陣列
   */
  buildFFmpegArgs(rtspInput, rtspOutput, options) {
    const { gpuType, bitrate, preset } = options;
    const args = ["-i", rtspInput];

    // 根據 GPU 類型添加視訊編碼參數
    switch (gpuType) {
      case "nvidia":
        // NVENC preset 映射：將 p1-p7 轉換為 NVENC 支援的 preset 值
        // NVENC 支援的 preset: slow, medium, fast, hp, hq, bd, ll, llhq, llhp, lossless, losslesshp
        const nvencPresetMap = {
          p1: "slow",      // 最高品質
          p2: "medium",    // 高品質
          p3: "fast",      // 平衡
          p4: "fast",      // 平衡（預設）
          p5: "hp",        // 高性能
          p6: "hp",        // 高性能
          p7: "hp",        // 最高性能
        };
        const nvencPreset = nvencPresetMap[preset] || "fast"; // 預設使用 fast
        
        args.push(
          "-c:v",
          "h264_nvenc", // NVIDIA 硬體編碼器
          "-preset",
          nvencPreset, // NVENC preset 值
          "-tune",
          "ll", // 低延遲
          "-rc",
          "vbr", // 可變位元率
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          `${parseInt(bitrate) * 2}M`,
          "-gpu",
          "0" // 使用第一個 GPU
        );
        break;

      case "intel":
        args.push(
          "-c:v",
          "h264_qsv", // Intel Quick Sync Video 硬體編碼器
          "-preset",
          "fast",
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          `${parseInt(bitrate) * 2}M`
        );
        break;

      case "amd":
        args.push(
          "-c:v",
          "h264_amf", // AMD VCE 硬體編碼器
          "-quality",
          "speed",
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          `${parseInt(bitrate) * 2}M`
        );
        break;

      default:
        throw new Error(`不支援的 GPU 類型: ${gpuType}`);
    }

    // 音訊編碼器（複製，不重新編碼）
    args.push("-c:a", "copy");

    // 添加輸出格式和 URL
    args.push("-f", "rtsp", rtspOutput);

    return args;
  }

  /**
   * 停止 FFmpeg 進程
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
    }

    try {
      // 如果進程已經退出，直接清理
      if (process.killed || process.exitCode !== null) {
        this.processes.delete(streamId);
        return true;
      }

      // 先嘗試優雅地停止（發送 SIGTERM）
      process.kill("SIGTERM");

      // 等待進程退出（最多 5 秒）
      const exitPromise = new Promise((resolve) => {
        // 如果進程已經退出，立即解決
        if (process.killed || process.exitCode !== null) {
          resolve(true);
          return;
        }

        // 監聽 exit 事件
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
        delete processInfo.killTimeout;
      }

      this.processes.delete(streamId);
      console.log(`[FFmpeg Service] 已停止串流 ${streamId} 的 FFmpeg 進程`);
      return true;
    } catch (error) {
      console.error(
        `[FFmpeg Service] 停止串流 ${streamId} 的 FFmpeg 進程失敗:`,
        error.message
      );
      // 即使出錯也從 Map 中移除
      this.processes.delete(streamId);
      return false;
    }
  }

  /**
   * 檢查 FFmpeg 進程是否正在運行
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
        rtspInput: rtspInput.replace(/:[^:@]+@/, ":****@"), // 隱藏密碼
        rtspOutput,
        startedAt,
      });
    }
    return processes;
  }

  /**
   * 停止所有 FFmpeg 進程
   * @returns {Promise<Array>} 停止結果陣列
   */
  async stopAllProcesses() {
    const streamIds = Array.from(this.processes.keys());
    const results = await Promise.allSettled(
      streamIds.map((id) => this.stopGpuEncoding(id))
    );
    return results;
  }

  /**
   * 等待 FFmpeg 進程啟動並就緒
   * @param {string} streamId - 串流 ID
   * @param {number} maxWaitMs - 最大等待時間（毫秒），預設 3000ms
   * @param {number} checkIntervalMs - 檢查間隔（毫秒），預設 200ms
   * @returns {Promise<boolean>} 是否成功啟動
   */
  async waitForProcessReady(streamId, maxWaitMs = 3000, checkIntervalMs = 200) {
    const maxAttempts = Math.floor(maxWaitMs / checkIntervalMs);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
      
      if (this.isRunning(streamId)) {
        return true;
      }
      
      // 如果進程已退出，表示啟動失敗
      const processInfo = this.processes.get(streamId);
      if (processInfo) {
        const { process } = processInfo;
        if (process.exitCode !== null && process.exitCode !== 0) {
          return false;
        }
      } else {
        // 進程已被移除，表示啟動失敗
        return false;
      }
    }
    return false;
  }
}

// 導出單例
module.exports = new FFmpegService();

