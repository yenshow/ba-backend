const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const settingsService = require("../services/settingsService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const logger = require("../utils/logger");
const C = require("../utils/apiErrorCodes");

const routeLogger = logger.createLogger("settingsRoutes");

const router = express.Router();

// 確保上傳目錄存在
const uploadsDir = path.join(process.cwd(), "uploads", "settings");
if (!fs.existsSync(uploadsDir)) {
	fs.mkdirSync(uploadsDir, { recursive: true });
}

// 配置 multer 儲存設定
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, uploadsDir);
	},
	filename: (req, file, cb) => {
		// 生成唯一檔名：時間戳 + 原始檔名
		const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
		const ext = path.extname(file.originalname);
		const name = path.basename(file.originalname, ext);
		cb(null, `${name}-${uniqueSuffix}${ext}`);
	}
});

// 檔案過濾器：允許圖片與影片
const fileFilter = (req, file, cb) => {
	const allowedMimes = [
		"image/jpeg",
		"image/jpg",
		"image/png",
		"image/gif",
		"image/webp",
		"video/mp4",
		"video/webm",
		"video/ogg"
	];
	if (allowedMimes.includes(file.mimetype)) {
		cb(null, true);
	} else {
		cb(
			new Error("不支援的檔案格式，僅允許上傳圖片（JPEG, PNG, GIF, WEBP）或影片（MP4, WEBM, OGG）"),
			false
		);
	}
};

// 配置 multer（圖片 10MB、影片 100MB）
const upload = multer({
	storage,
	fileFilter,
	limits: {
		fileSize: 100 * 1024 * 1024 // 100MB（影片通常較大）
	}
});

/**
 * 取得所有系統設定
 * GET /api/settings
 * 需要認證
 */
router.get("/", authenticate, asyncHandler(async (req, res) => {
	const settings = await settingsService.getAllSettings();
	res.sendSuccess({ settings });
}));

/**
 * 取得單一系統設定
 * GET /api/settings/:key
 * 需要認證
 */
router.get("/:key", authenticate, asyncHandler(async (req, res) => {
	const { key } = req.params;
	const setting = await settingsService.getSettingByKey(key, {
		throwIfNotFound: true,
	});
	res.sendSuccess({ setting });
}));

/**
 * 批量取得系統設定
 * POST /api/settings/batch
 * Body: { keys: ["key1", "key2", ...] }
 * 需要認證
 */
router.post("/batch", authenticate, asyncHandler(async (req, res) => {
	const { keys } = req.body;
	
	if (!Array.isArray(keys) || keys.length === 0) {
		return res.sendFailure(
			{
				code: C.SETTINGS_INVALID_BATCH_KEYS,
				message: "keys 必須為非空陣列",
				details: null,
			},
			400,
		);
	}
	
	const settings = await settingsService.getSettingsByKeys(keys);
	res.sendSuccess({ settings });
}));

/**
 * 建立或更新系統設定
 * PUT /api/settings/:key
 * Body: { value: "...", description?: "..." }
 * 需要管理員權限
 */
router.put("/:key", authenticate, requireAdmin, validateRequired("value"), asyncHandler(async (req, res) => {
	const { key } = req.params;
	const { value, description } = req.body;
	
	const setting = await settingsService.upsertSetting(key, value, description);
	res.sendSuccess({ setting });
}));

/**
 * 上傳檔案並更新設定
 * POST /api/settings/upload
 * FormData: { key: "setting_key", file: <File> }
 * 需要管理員權限
 */
router.post("/upload", authenticate, requireAdmin, upload.single("file"), asyncHandler(async (req, res) => {
	if (!req.file) {
		return res.sendFailure(
			{
				code: C.SETTINGS_UPLOAD_FILE_MISSING,
				message: "未提供檔案",
				details: null,
			},
			400,
		);
	}
	
	const { key } = req.body;
	if (!key) {
		// 如果上傳成功但沒有 key，刪除已上傳的檔案
		fs.unlinkSync(req.file.path);
		return res.sendFailure(
			{
				code: C.SETTINGS_UPLOAD_KEY_MISSING,
				message: "設定鍵名 (key) 為必填",
				details: null,
			},
			400,
		);
	}
	
	// 先刪除該 key 的舊有上傳檔案，避免孤兒檔案累積
	const existingSetting = await settingsService.getSettingByKey(key);
	if (existingSetting?.value?.startsWith?.("/uploads/settings/")) {
		const oldFilePath = path.join(process.cwd(), existingSetting.value);
		if (fs.existsSync(oldFilePath)) {
			try {
				fs.unlinkSync(oldFilePath);
			} catch (err) {
				routeLogger.warn("刪除舊檔案失敗（不中斷流程）", {
					oldFilePath,
					error: err?.message || String(err),
					module: "settingsRoutes",
				});
				// 不中斷流程，繼續儲存新檔
			}
		}
	}
	
	// 生成檔案 URL（相對於伺服器根目錄）
	const fileUrl = `/uploads/settings/${path.basename(req.file.path)}`;
	
	// 儲存設定（URL）
	const setting = await settingsService.upsertSetting(key, fileUrl, `上傳的檔案: ${req.file.originalname}`);
	
	res.sendSuccess({ 
		setting,
		file: {
			originalName: req.file.originalname,
			filename: req.file.filename,
			url: fileUrl,
			size: req.file.size
		}
	});
}));

/**
 * 刪除系統設定
 * DELETE /api/settings/:key
 * 需要管理員權限
 */
router.delete("/:key", authenticate, requireAdmin, asyncHandler(async (req, res) => {
	const { key } = req.params;
	
	// 先取得設定值，如果是檔案 URL，則刪除檔案
	const setting = await settingsService.getSettingByKey(key);
	if (setting && setting.value) {
		// 檢查是否為上傳的檔案 URL
		if (setting.value.startsWith("/uploads/settings/")) {
			const filePath = path.join(process.cwd(), setting.value);
			if (fs.existsSync(filePath)) {
				try {
					fs.unlinkSync(filePath);
				} catch (error) {
					routeLogger.warn("刪除檔案失敗（不中斷流程）", {
						filePath,
						error: error?.message || String(error),
						module: "settingsRoutes",
					});
					// 繼續執行，不中斷刪除設定
				}
			}
		}
	}
	
	const deleted = await settingsService.deleteSetting(key);
	if (!deleted) {
		return res.sendFailure(
			{
				code: C.SETTINGS_KEY_NOT_FOUND,
				message: `設定不存在: ${key}`,
				details: { key },
			},
			404,
		);
	}
	
	res.sendSuccess({ message: "設定已刪除" });
}));

module.exports = router;
