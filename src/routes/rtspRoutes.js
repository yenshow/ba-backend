const express = require("express");
const rtspStreamService = require("../services/rtspStreamService");

const router = express.Router();

/**
 * POST /api/rtsp/start
 * 啟動 RTSP 串流轉換為 HLS
 * Body: { rtspUrl: string }
 */
router.post("/start", async (req, res, next) => {
	try {
		const { rtspUrl } = req.body;

		if (!rtspUrl) {
			return res.status(400).json({
				error: true,
				message: "RTSP URL 是必需的",
				timestamp: new Date().toISOString()
			});
		}

		const result = await rtspStreamService.startStream(rtspUrl);

		res.json({
			error: false,
			data: result,
			message: "串流已啟動",
			timestamp: new Date().toISOString()
		});
	} catch (error) {
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
			return res.status(400).json({
				error: true,
				message: "串流 ID 是必需的",
				timestamp: new Date().toISOString()
			});
		}

		const result = await rtspStreamService.stopStream(streamId);

		res.json({
			error: false,
			data: result,
			message: result.message,
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		next(error);
	}
});

/**
 * GET /api/rtsp/status
 * 獲取所有串流狀態
 */
router.get("/status", (_req, res) => {
	try {
		const statuses = rtspStreamService.getStreamStatus();

		res.json({
			error: false,
			data: statuses,
			message: "獲取串流狀態成功",
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		res.status(500).json({
			error: true,
			message: "獲取串流狀態失敗",
			details: error.message,
			timestamp: new Date().toISOString()
		});
	}
});

/**
 * GET /api/rtsp/status/:streamId
 * 獲取指定串流狀態
 */
router.get("/status/:streamId", (req, res) => {
	try {
		const { streamId } = req.params;

		if (!streamId) {
			return res.status(400).json({
				error: true,
				message: "串流 ID 是必需的",
				timestamp: new Date().toISOString()
			});
		}

		const status = rtspStreamService.getStreamStatus(streamId);

		if (!status) {
			return res.status(404).json({
				error: true,
				message: `串流 ${streamId} 不存在`,
				timestamp: new Date().toISOString()
			});
		}

		res.json({
			error: false,
			data: status,
			message: "獲取串流狀態成功",
			timestamp: new Date().toISOString()
		});
	} catch (error) {
		res.status(500).json({
			error: true,
			message: "獲取串流狀態失敗",
			details: error.message,
			timestamp: new Date().toISOString()
		});
	}
});

module.exports = router;
