const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const asyncHandler = require("../utils/asyncHandler");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const multimediaDashboardService = require("../services/multimedia/multimediaDashboardService");
const C = require("../utils/apiErrorCodes");
const { getUploadsDir } = require("../utils/baDataPaths");

const router = express.Router();

// 需要登入（資訊牆為獨立頁面，但仍走既有登入體系）
router.use(authenticate, requirePermission("system.multimedia"));

// ========== Settings ==========

router.get(
  "/dashboard/settings",
  asyncHandler(async (_req, res) => {
    const settings = await multimediaDashboardService.getDashboardSettings();
    res.sendSuccess({ settings });
  }),
);

router.put(
  "/dashboard/settings",
  requirePermission("system.multimedia.settings.update"),
  asyncHandler(async (req, res) => {
    const nextSettings =
      await multimediaDashboardService.updateDashboardSettings(req.body || {});
    res.sendSuccess({ settings: nextSettings });
  }),
);

// ========== Env Readings (snapshot) ==========

router.get(
  "/dashboard/env-readings",
  asyncHandler(async (_req, res) => {
    const snapshot =
      await multimediaDashboardService.getMultimediaEnvReadingsSnapshot();
    res.sendSuccess({ snapshot });
  }),
);

// ========== Upload (media) ==========

const uploadsDir = getUploadsDir("multimedia");

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowedMimes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
  ];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "不支援的檔案格式，僅允許上傳圖片或影片（JPEG, PNG, GIF, WEBP, MP4, WEBM, MOV, OGG）",
      ),
      false,
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.post(
  "/dashboard/upload",
  requirePermission("system.multimedia.settings.update"),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.sendFailure(
        {
          code: C.MULTIMEDIA_UPLOAD_FILE_MISSING,
          message: "未提供檔案",
          details: null,
        },
        400,
      );
    }
    const fileUrl = `/uploads/multimedia/${path.basename(req.file.path)}`;
    res.sendSuccess({
      file: {
        originalName: req.file.originalname,
        filename: req.file.filename,
        url: fileUrl,
        size: req.file.size,
      },
    });
  }),
);

module.exports = router;
