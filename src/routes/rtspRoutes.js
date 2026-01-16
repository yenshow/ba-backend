const express = require("express");
const router = express.Router();
const mediaMTXService = require("../services/communication/mediaMTXService");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const logger = require("../utils/logger");

const rtspLogger = logger.createLogger("RTSP Routes");

/**
 * POST /api/rtsp/start
 * 啟動 RTSP 串流轉換為 HLS
 * Body: { rtspUrl: string }
 */
router.post("/start", validateRequired("rtspUrl"), asyncHandler(async (req, res) => {
  const { rtspUrl } = req.body;

  // 驗證 RTSP URL 格式
  if (!rtspUrl.startsWith("rtsp://")) {
    return res.sendError("無效的 RTSP URL 格式，必須以 rtsp:// 開頭", 400);
  }

  rtspLogger.info("收到啟動串流請求", { 
    rtspUrl: rtspUrl.replace(/:[^:@]+@/, ":****@") // 隱藏密碼
  });

  const result = await mediaMTXService.startStream(rtspUrl);

  rtspLogger.info("串流啟動成功", { streamId: result.streamId });

  res.sendSuccess(result);
}));

/**
 * POST /api/rtsp/stop/:streamId
 * 停止指定的 RTSP 串流
 */
router.post("/stop/:streamId", validateRequired("streamId"), asyncHandler(async (req, res) => {
  const { streamId } = req.params;
  const result = await mediaMTXService.stopStream(streamId);
  res.sendSuccess(result);
}));

/**
 * GET /api/rtsp/status
 * 獲取所有串流狀態
 */
router.get("/status", asyncHandler(async (req, res) => {
  const statuses = await mediaMTXService.getStreamStatus();
  res.sendSuccess(statuses);
}));

/**
 * GET /api/rtsp/status/:streamId
 * 獲取指定串流狀態
 */
router.get("/status/:streamId", validateRequired("streamId"), asyncHandler(async (req, res) => {
  const { streamId } = req.params;
  const status = await mediaMTXService.getStreamStatus(streamId);

  if (!status) {
    return res.sendError(`串流 ${streamId} 不存在`, 404);
  }

  res.sendSuccess(status);
}));

/**
 * GET /api/rtsp/refresh/:streamId
 * 獲取最新的 HLS URL（帶時間戳，防止緩存）
 * 用於前端頁面重新載入或刷新時獲取最新的播放 URL
 */
router.get("/refresh/:streamId", validateRequired("streamId"), asyncHandler(async (req, res) => {
  const { streamId } = req.params;
  const latestUrl = await mediaMTXService.getLatestHlsUrl(streamId);
  res.sendSuccess(latestUrl);
}));

module.exports = router;
