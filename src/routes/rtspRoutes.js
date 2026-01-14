const express = require("express");
const mediaMTXService = require("../services/communication/mediaMTXService");

const router = express.Router();

/**
 * 創建錯誤響應（統一方法）
 * @param {number} statusCode - HTTP 狀態碼
 * @param {string} message - 錯誤訊息
 * @param {string} details - 詳細訊息（可選）
 * @returns {Object} 錯誤響應對象
 */
const createErrorResponse = (statusCode, message, details = null) => ({
  error: true,
  message,
  ...(details && { details }),
  timestamp: new Date().toISOString(),
});

/**
 * 創建成功響應（統一方法）
 * @param {any} data - 響應數據
 * @param {string} message - 成功訊息
 * @returns {Object} 成功響應對象
 */
const createSuccessResponse = (data, message) => ({
  error: false,
  data,
  message,
  timestamp: new Date().toISOString(),
});

/**
 * POST /api/rtsp/start
 * 啟動 RTSP 串流轉換為 HLS
 * Body: { rtspUrl: string }
 */
router.post("/start", async (req, res, next) => {
  try {
    const { rtspUrl } = req.body;

    if (!rtspUrl) {
      return res.status(400).json(createErrorResponse(400, "RTSP URL 是必需的"));
    }

    // 驗證 RTSP URL 格式
    if (!rtspUrl.startsWith("rtsp://")) {
      return res.status(400).json(
        createErrorResponse(400, "無效的 RTSP URL 格式，必須以 rtsp:// 開頭")
      );
    }

    console.log(
      `[RTSP Routes] 收到啟動串流請求: ${rtspUrl.replace(/:[^:@]+@/, ":****@")}`
    ); // 隱藏密碼

    const result = await mediaMTXService.startStream(rtspUrl);

    console.log(`[RTSP Routes] 串流啟動成功: Stream ID = ${result.streamId}`);

    res.json(createSuccessResponse(result, "串流已啟動"));
  } catch (error) {
    console.error(`[RTSP Routes] 啟動串流失敗:`, error.message);
    next(error);
  }
});

/**
 * POST /api/rtsp/stop/:streamId
 * 停止指定的 RTSP 串流
 */
router.post("/stop/:streamId", async (req, res, next) => {
  try {
    const { streamId } = req.params;

    if (!streamId) {
      return res.status(400).json(createErrorResponse(400, "串流 ID 是必需的"));
    }

    const result = await mediaMTXService.stopStream(streamId);

    res.json(createSuccessResponse(result, result.message));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/rtsp/status
 * 獲取所有串流狀態
 */
router.get("/status", async (_req, res) => {
  try {
    const statuses = await mediaMTXService.getStreamStatus();
    res.json(createSuccessResponse(statuses, "獲取串流狀態成功"));
  } catch (error) {
    res.status(500).json(createErrorResponse(500, "獲取串流狀態失敗", error.message));
  }
});

/**
 * GET /api/rtsp/status/:streamId
 * 獲取指定串流狀態
 */
router.get("/status/:streamId", async (req, res) => {
  try {
    const { streamId } = req.params;

    if (!streamId) {
      return res.status(400).json(createErrorResponse(400, "串流 ID 是必需的"));
    }

    const status = await mediaMTXService.getStreamStatus(streamId);

    if (!status) {
      return res.status(404).json(createErrorResponse(404, `串流 ${streamId} 不存在`));
    }

    res.json(createSuccessResponse(status, "獲取串流狀態成功"));
  } catch (error) {
    res.status(500).json(createErrorResponse(500, "獲取串流狀態失敗", error.message));
  }
});

/**
 * GET /api/rtsp/refresh/:streamId
 * 獲取最新的 HLS URL（帶時間戳，防止緩存）
 * 用於前端頁面重新載入或刷新時獲取最新的播放 URL
 */
router.get("/refresh/:streamId", async (req, res) => {
  try {
    const { streamId } = req.params;

    if (!streamId) {
      return res.status(400).json(createErrorResponse(400, "串流 ID 是必需的"));
    }

    const latestUrl = await mediaMTXService.getLatestHlsUrl(streamId);

    res.json(createSuccessResponse(latestUrl, "獲取最新 URL 成功"));
  } catch (error) {
    res.status(404).json(createErrorResponse(404, error.message));
  }
});

module.exports = router;
