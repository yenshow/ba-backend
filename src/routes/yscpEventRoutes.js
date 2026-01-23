const express = require("express");
const router = express.Router();
const yscpEventService = require("../services/yscp/yscpEventService");
const yscpPersonService = require("../services/yscp/yscpPersonService");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../utils/logger");
const { authenticate } = require("../middleware/authMiddleware");

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

/**
 * 從文件讀取人員 ID 列表
 * GET /api/yscp/person/ids-from-file
 * 
 * 查詢參數:
 * - filePath: 文件路徑（相對於 output 目錄或絕對路徑）
 */
router.get(
	"/person/ids-from-file",
	authenticate,
	asyncHandler(async (req, res) => {
		try {
			const { filePath } = req.query;

			if (!filePath) {
				return res.status(400).json({
					code: "400",
					msg: "缺少必要參數: filePath",
					data: null,
				});
			}

			const personIds = await yscpPersonService.getPersonIdsFromFile(
				filePath
			);

			res.json({
				code: "0",
				msg: "Success",
				data: {
					personIds,
					count: personIds.length,
				},
			});
		} catch (error) {
			eventLogger.error("讀取人員 ID 失敗", {
				error: error.message,
			});

			res.status(500).json({
				code: "500",
				msg: error.message || "讀取人員 ID 失敗",
				data: null,
			});
		}
	})
);

/**
 * 獲取單個人員資訊
 * GET /api/yscp/person/info
 * 
 * 查詢參數:
 * - personId: 人員 ID
 */
router.get(
	"/person/info",
	authenticate,
	asyncHandler(async (req, res) => {
		try {
			const { personId } = req.query;

			if (!personId) {
				return res.status(400).json({
					code: "400",
					msg: "缺少必要參數: personId",
					data: null,
				});
			}

			const result = await yscpPersonService.getPersonInfo(personId);

			if (!result.success) {
				return res.status(result.status || 500).json({
					code: String(result.status || 500),
					msg: result.error?.msg || "獲取人員資訊失敗",
					data: null,
				});
			}

			res.json({
				code: "0",
				msg: "Success",
				data: result.data,
			});
		} catch (error) {
			eventLogger.error("獲取人員資訊失敗", {
				error: error.message,
			});

			res.status(500).json({
				code: "500",
				msg: error.message || "獲取人員資訊失敗",
				data: null,
			});
		}
	})
);

/**
 * 獲取人員圖片（Base64）
 * GET /api/yscp/person/picture
 * 
 * 查詢參數:
 * - personId: 人員 ID
 * - picUri: 圖片 URI
 */
router.get(
	"/person/picture",
	authenticate,
	asyncHandler(async (req, res) => {
		try {
			const { personId, picUri } = req.query;

			if (!personId || !picUri) {
				return res.status(400).json({
					code: "400",
					msg: "缺少必要參數: personId 或 picUri",
					data: null,
				});
			}

			const result = await yscpPersonService.getPersonPicture(
				personId,
				picUri
			);

			if (!result.success) {
				return res.status(result.status || 500).json({
					code: String(result.status || 500),
					msg: result.error?.msg || "獲取人員圖片失敗",
					data: null,
				});
			}

			res.json({
				code: "0",
				msg: "Success",
				data: result.data,
			});
		} catch (error) {
			eventLogger.error("獲取人員圖片失敗", {
				error: error.message,
			});

			res.status(500).json({
				code: "500",
				msg: error.message || "獲取人員圖片失敗",
				data: null,
			});
		}
	})
);

/**
 * 批量獲取人員資訊
 * POST /api/yscp/person/batch-info
 * 
 * 請求體:
 * {
 *   "personIds": [1, 2, 3],
 *   "includePicture": false  // 可選，是否包含圖片
 * }
 */
router.post(
	"/person/batch-info",
	authenticate,
	asyncHandler(async (req, res) => {
		try {
			const { personIds, includePicture = false } = req.body;

			if (!personIds || !Array.isArray(personIds) || personIds.length === 0) {
				return res.status(400).json({
					code: "400",
					msg: "缺少必要參數: personIds (必須為非空陣列)",
					data: null,
				});
			}

			const results = await yscpPersonService.getBatchPersonInfo(
				personIds,
				{ includePicture }
			);

			res.json({
				code: "0",
				msg: "Success",
				data: {
					results,
					total: personIds.length,
					success: results.filter((r) => r.success).length,
					failed: results.filter((r) => !r.success).length,
				},
			});
		} catch (error) {
			eventLogger.error("批量獲取人員資訊失敗", {
				error: error.message,
			});

			res.status(500).json({
				code: "500",
				msg: error.message || "批量獲取人員資訊失敗",
				data: null,
			});
		}
	})
);

/**
 * 從文件讀取人員 ID 並批量獲取資訊
 * POST /api/yscp/person/info-from-file
 * 
 * 請求體:
 * {
 *   "filePath": "people_counting-platform-person-2026-01-23T03-49-57-011Z.txt",
 *   "includePicture": false  // 可選，是否包含圖片
 * }
 */
router.post(
	"/person/info-from-file",
	authenticate,
	asyncHandler(async (req, res) => {
		try {
			const { filePath, includePicture = false } = req.body;

			if (!filePath) {
				return res.status(400).json({
					code: "400",
					msg: "缺少必要參數: filePath",
					data: null,
				});
			}

			const results = await yscpPersonService.getPersonInfoFromFile(
				filePath,
				{ includePicture }
			);

			res.json({
				code: "0",
				msg: "Success",
				data: {
					results,
					total: results.length,
					success: results.filter((r) => r.success).length,
					failed: results.filter((r) => !r.success).length,
				},
			});
		} catch (error) {
			eventLogger.error("從文件獲取人員資訊失敗", {
				error: error.message,
			});

			res.status(500).json({
				code: "500",
				msg: error.message || "從文件獲取人員資訊失敗",
				data: null,
			});
		}
	})
);

module.exports = router;

