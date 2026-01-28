const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const settingsService = require("../services/settingsService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const config = require("../config");

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

// 檔案過濾器：只允許圖片
const fileFilter = (req, file, cb) => {
	const allowedMimes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
	if (allowedMimes.includes(file.mimetype)) {
		cb(null, true);
	} else {
		cb(new Error("不支援的檔案格式，僅允許上傳圖片（JPEG, PNG, GIF, WEBP）"), false);
	}
};

// 配置 multer（限制 10MB）
const upload = multer({
	storage,
	fileFilter,
	limits: {
		fileSize: 10 * 1024 * 1024 // 10MB
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
	const setting = await settingsService.getSettingByKey(key);
	
	if (!setting) {
		return res.status(404).json({ error: `設定不存在: ${key}` });
	}
	
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
		return res.status(400).json({ error: "keys 必須為非空陣列" });
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
		return res.status(400).json({ error: "未提供檔案" });
	}
	
	const { key } = req.body;
	if (!key) {
		// 如果上傳成功但沒有 key，刪除已上傳的檔案
		fs.unlinkSync(req.file.path);
		return res.status(400).json({ error: "設定鍵名 (key) 為必填" });
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
					console.error(`[settingsRoutes] 刪除檔案失敗: ${filePath}`, error);
					// 繼續執行，不中斷刪除設定
				}
			}
		}
	}
	
	const deleted = await settingsService.deleteSetting(key);
	if (!deleted) {
		return res.status(404).json({ error: `設定不存在: ${key}` });
	}
	
	res.sendSuccess({ message: "設定已刪除" });
}));

module.exports = router;
