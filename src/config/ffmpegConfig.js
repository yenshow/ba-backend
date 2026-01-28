/**
 * FFmpeg GPU 編碼配置
 * 包含所有 GPU 編碼器的配置參數和映射
 */

/**
 * NVIDIA NVENC Preset 映射
 * 將前端傳入的 p1-p7 映射到 NVENC 支援的 preset 值
 * 
 * FFmpeg 8.0+ 支援的 NVENC presets:
 * - slow, medium, fast, hp, hq, bd
 * - ll (low latency), llhq (low latency high quality), llhp (low latency high performance)
 * - lossless, losslesshp
 */
const NVENC_PRESET_MAP = {
  p1: "slow",      // 最高品質，最慢速度
  p2: "medium",    // 高品質，平衡速度
  p3: "fast",      // 平衡品質和速度
  p4: "llhp",      // 低延遲高性能（適合實時串流，預設）
  p5: "llhq",      // 低延遲高品質（適合串流）
  p6: "llhp",      // 低延遲高性能（適合串流）
  p7: "hp",        // 最高性能，較低品質
};

/**
 * 預設配置值
 */
const DEFAULT_CONFIG = {
  gpuType: "nvidia",
  bitrate: "2M",
  preset: "p4",
  gpuIndex: 0, // GPU 索引（用於多 GPU 系統）
};

/**
 * 位元率緩衝區倍數
 * 用於計算 bufsize = bitrate * BUFFER_MULTIPLIER
 */
const BUFFER_MULTIPLIER = 2;

/**
 * RTSP 輸入選項（基本選項，兼容 FFmpeg 5.0+）
 * 用於優化 RTSP 輸入的穩定性和性能
 */
const RTSP_INPUT_OPTIONS_BASIC = [
  "-rtsp_transport", "tcp", // 使用 TCP 傳輸（更穩定）
  "-timeout", "5000000",    // 5 秒超時（FFmpeg 5.0+ 使用 -timeout，舊版使用 -stimeout）
];

// 注意：先只保留「所有版本都兼容」的基本選項。
// 如需重連相關的進階選項，後續可在確認 FFmpeg 版本/參數支援後再加回。

/**
 * 錯誤關鍵字列表
 * 用於識別 FFmpeg 輸出中的嚴重錯誤
 */
const CRITICAL_ERROR_KEYWORDS = [
  "error initializing",
  "error while opening encoder",
  "InitializeEncoder failed", // NVENC 編碼器初始化失敗
  "invalid param", // 無效參數（如 Invalid Level）
  "Invalid Level", // H.264 level 無效
  "unable to parse option",
  "error setting option",
  "cannot get the preset",
  "unsupported param",
  "cannot load",
  "could not write header",
  "invalid data found when processing",
  "nothing was written into output file",
  "Could not open encoder", // 編碼器無法打開
];

/**
 * 警告關鍵字列表
 * 用於識別非關鍵的警告訊息
 */
const WARNING_KEYWORDS = [
  "warning",
  "deprecated",
  "circular_buffer_size",
];

/**
 * 計算位元率緩衝區大小
 * @param {string} bitrate - 位元率（如 '2M'）
 * @returns {string} 緩衝區大小（如 '4M'）
 */
function calculateBufsize(bitrate) {
  const bitrateNum = parseInt(bitrate);
  return `${bitrateNum * BUFFER_MULTIPLIER}M`;
}

/**
 * 構建 NVIDIA NVENC 編碼參數
 * @param {Object} options - 編碼選項
 * @param {string} options.bitrate - 位元率（如 '2M'）
 * @param {string} options.preset - Preset 值（p1-p7）
 * @param {number} options.gpuIndex - GPU 索引（預設 0）
 * @param {string} options.scale - 縮放解析度（如 '1920:1080' 或 '1280:720'），預設不縮放
 * @returns {Array<string>} FFmpeg 參數陣列
 */
function buildNvencArgs(options = {}) {
  const {
    bitrate = DEFAULT_CONFIG.bitrate,
    preset = DEFAULT_CONFIG.preset,
    gpuIndex = DEFAULT_CONFIG.gpuIndex,
    scale = null, // 可選的解析度縮放
  } = options;

  const nvencPreset = NVENC_PRESET_MAP[preset] || NVENC_PRESET_MAP.p4;
  const bufsize = calculateBufsize(bitrate);

  const args = [];

  // ⭐ 關鍵優化：如果指定了縮放，添加視頻過濾器（在編碼前縮放，大幅降低編碼負擔）
  if (scale) {
    args.push("-vf", `scale=${scale}`); // 例如：scale=1920:1080 或 scale=1280:720
    console.log(`[FFmpeg Config] 啟用解析度縮放: ${scale}（降低編碼負擔，提升速度）`);
  }

  // 使用映射後的 preset 值（FFmpeg 8.0+ 兼容）
  // 優化為低延遲配置，提升編碼速度並減少延遲
  args.push(
    "-c:v",
    "h264_nvenc",
    "-preset",
    nvencPreset, // 使用映射後的 preset（預設為 llhp，低延遲高性能）
    "-rc",
    "cbr", // 使用 CBR（固定位元率）而非 VBR，更穩定且低延遲
    "-b:v",
    bitrate, // 使用傳入的位元率
    "-maxrate",
    bitrate,
    "-bufsize",
    bufsize,
    "-g",
    "30", // 降低 GOP size（30fps 時 1 秒一個關鍵幀），減少緩衝延遲
    "-bf",
    "0", // 禁用 B-frames（減少延遲）
    "-tune",
    "ll", // 低延遲調優
    "-pix_fmt",
    "yuv420p", // 確保像素格式兼容
    "-color_range",
    "tv", // 設置顏色範圍為 TV（解決 deprecated pixel format 警告）
    "-profile:v",
    "main", // 使用 main profile（適合高解析度，比 baseline 更高效）
    "-level",
    "5.0" // 明確設置 Level 5.0（2560x1440 需要 Level 5.0+，縮放後可能需要調整）
  );

  // 如果縮放到較低解析度，調整 level
  if (scale) {
    const [width] = scale.split(":");
    const widthNum = parseInt(width);
    if (widthNum <= 1920) {
      // 1080p 或更低，使用 Level 4.0 即可
      args[args.length - 1] = "4.0"; // 替換最後一個 level 參數
    }
  }

  // 只在多 GPU 系統中指定 GPU 索引（gpuIndex > 0）
  if (gpuIndex > 0) {
    args.push("-gpu", gpuIndex.toString());
  }

  return args;
}

/**
 * 構建 Intel QSV 編碼參數
 * @param {Object} options - 編碼選項
 * @param {string} options.bitrate - 位元率（如 '2M'）
 * @returns {Array<string>} FFmpeg 參數陣列
 */
function buildQsvArgs(options = {}) {
  const { bitrate = DEFAULT_CONFIG.bitrate } = options;
  const bufsize = calculateBufsize(bitrate);

  return [
    "-c:v",
    "h264_qsv",
    "-preset",
    "fast",
    "-b:v",
    bitrate,
    "-maxrate",
    bitrate,
    "-bufsize",
    bufsize,
  ];
}

/**
 * 構建 AMD AMF 編碼參數
 * @param {Object} options - 編碼選項
 * @param {string} options.bitrate - 位元率（如 '2M'）
 * @returns {Array<string>} FFmpeg 參數陣列
 */
function buildAmfArgs(options = {}) {
  const { bitrate = DEFAULT_CONFIG.bitrate } = options;
  const bufsize = calculateBufsize(bitrate);

  return [
    "-c:v",
    "h264_amf",
    "-quality",
    "speed",
    "-b:v",
    bitrate,
    "-maxrate",
    bitrate,
    "-bufsize",
    bufsize,
  ];
}

/**
 * 檢查輸出是否包含嚴重錯誤
 * @param {string} output - FFmpeg 輸出文本
 * @returns {boolean} 是否為嚴重錯誤
 */
function isCriticalError(output) {
  const lowerOutput = output.toLowerCase();
  
  // 先檢查是否包含警告關鍵字（排除警告）
  if (WARNING_KEYWORDS.some((keyword) => lowerOutput.includes(keyword))) {
    return false;
  }

  // 檢查是否包含嚴重錯誤關鍵字
  return CRITICAL_ERROR_KEYWORDS.some((keyword) =>
    lowerOutput.includes(keyword)
  );
}

/**
 * 檢查輸出是否為一般錯誤或警告
 * @param {string} output - FFmpeg 輸出文本
 * @returns {boolean} 是否為一般錯誤或警告
 */
function isWarningOrError(output) {
  const lowerOutput = output.toLowerCase();
  return (
    lowerOutput.includes("error") ||
    lowerOutput.includes("failed") ||
    lowerOutput.includes("cannot") ||
    lowerOutput.includes("warning")
  );
}

/**
 * 根據錯誤訊息生成友好的錯誤提示
 * @param {string} error - 原始錯誤訊息
 * @returns {string} 友好的錯誤提示
 */
function formatFfmpegError(error) {
  if (!error || typeof error !== "string") {
    return "FFmpeg GPU 編碼失敗";
  }

  const lowerError = error.toLowerCase();

  if (
    lowerError.includes("nvcuda.dll") ||
    lowerError.includes("cannot load nvcuda")
  ) {
    return (
      "無法載入 NVIDIA CUDA 運行時庫 (nvcuda.dll)。\n" +
      "可能原因：\n" +
      "1. 未安裝 NVIDIA GPU 驅動程式\n" +
      "2. 未安裝 CUDA Toolkit\n" +
      "3. FFmpeg 版本與驅動程式不匹配\n" +
      "建議：安裝最新版本的 NVIDIA 驅動程式或使用 CPU 編碼"
    );
  }

  if (
    lowerError.includes("cannot get the preset") ||
    lowerError.includes("unsupported param")
  ) {
    return (
      "FFmpeg NVENC 編碼器參數不支援。\n" +
      "可能原因：\n" +
      "1. FFmpeg 版本過舊，不支援某些 NVENC 參數\n" +
      "2. NVIDIA 驅動程式版本與 FFmpeg 不匹配\n" +
      "建議：\n" +
      "1. 執行 `npm run ffmpeg:download` 下載最新版本的 FFmpeg\n" +
      "2. 或更新 NVIDIA 驅動程式\n" +
      "3. 或使用 CPU 編碼（不勾選「啟用 GPU 編碼」）"
    );
  }

  if (lowerError.includes("cannot load")) {
    return `GPU 編碼器載入失敗: ${error}`;
  }

  if (
    lowerError.includes("error initializing") ||
    lowerError.includes("error while opening encoder")
  ) {
    return `FFmpeg GPU 編碼器初始化失敗: ${error}`;
  }

  if (
    lowerError.includes("could not write header") ||
    lowerError.includes("invalid data found when processing")
  ) {
    return (
      "FFmpeg RTSP 輸出失敗（編碼參數或格式問題）。\n" +
      "可能原因：\n" +
      "1. 編碼器參數與 RTSP 容器不兼容\n" +
      "2. 像素格式轉換失敗\n" +
      "3. MediaMTX 尚未準備好接收 RTSP 輸入\n" +
      "建議：檢查 FFmpeg 日誌以獲取詳細錯誤信息"
    );
  }

  return `FFmpeg GPU 編碼錯誤: ${error}`;
}

/**
 * 根據錯誤上下文生成錯誤訊息
 * @param {Object} context - 錯誤上下文
 * @param {string|null} context.ffmpegError - FFmpeg 錯誤訊息
 * @param {boolean} context.isStillRunning - 進程是否仍在運行
 * @param {boolean} context.ffmpegReady - 進程是否就緒
 * @returns {string} 錯誤訊息
 */
function generateErrorMessage(context) {
  const { ffmpegError, isStillRunning, ffmpegReady } = context;

  if (ffmpegError) {
    return formatFfmpegError(ffmpegError);
  }

  if (!isStillRunning) {
    return "FFmpeg GPU 編碼進程已退出（可能因為編碼器初始化失敗）";
  }

  if (!ffmpegReady) {
    return "FFmpeg GPU 編碼進程啟動失敗或超時";
  }

  return "FFmpeg GPU 編碼失敗";
}

/**
 * 獲取 RTSP 輸入選項（根據 FFmpeg 版本自動選擇）
 * @param {string} ffmpegPath - FFmpeg 執行檔路徑（用於檢測版本）
 * @returns {Array<string>} RTSP 輸入選項陣列
 */
function getRtspInputOptions(_ffmpegPath = null) {
  return RTSP_INPUT_OPTIONS_BASIC;
}

module.exports = {
  DEFAULT_CONFIG,
  NVENC_PRESET_MAP,
  RTSP_INPUT_OPTIONS_BASIC,
  getRtspInputOptions,
  BUFFER_MULTIPLIER,
  buildNvencArgs,
  buildQsvArgs,
  buildAmfArgs,
  isCriticalError,
  isWarningOrError,
  formatFfmpegError,
  generateErrorMessage,
};
