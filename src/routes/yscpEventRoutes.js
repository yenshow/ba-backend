const express = require("express");
const router = express.Router();
const yscpEventService = require("../services/yscp/yscpEventService");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../utils/logger");

const eventLogger = logger.createLogger("YSCP Event Receiver");

/**
 * YSCP 事件接收端點
 * POST /api/yscp/event-receiver
 * 
 * 此端點用於接收 YSCP 系統推送的事件
 * 注意：此端點不需要身份驗證，因為是外部系統推送
 */
router.post(
	"/event-receiver",
	asyncHandler(async (req, res) => {
		try {
			const eventData = req.body;
			// 處理事件（服務層已記錄日誌）
			const result = await yscpEventService.handleEvent(eventData);
			// 返回成功響應
			res.status(200).json({
				code: "0",
				msg: "Success",
				data: result || {},
			});
		} catch (error) {
			// 記錄錯誤詳情
			eventLogger.error("處理 YSCP 事件失敗", {
				error: error.message,
			});
			
			// 即使處理失敗，也返回成功響應（避免 YSCP 重試）
			res.status(200).json({
				code: "0",
				msg: "Event received",
				data: {},
			});
		}
	})
);

/**
 * 健康檢查端點（可選）
 * GET /api/yscp/health
 */
router.get("/health", (req, res) => {
	res.json({
		status: "ok",
		service: "YSCP Event Receiver",
		timestamp: new Date().toISOString(),
	});
});

module.exports = router;

