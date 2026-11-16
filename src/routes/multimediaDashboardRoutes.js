const express = require("express");
const multer = require("multer");
const path = require("path");
const asyncHandler = require("../utils/asyncHandler");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const multimediaDashboardService = require("../services/multimedia/multimediaDashboardService");
const multimediaWallSeatService = require("../services/multimedia/multimediaWallSeatService");
const permissionService = require("../access/permissionService");
const C = require("../utils/apiErrorCodes");
const { getUploadsDir } = require("../utils/baDataPaths");

const router = express.Router();

/**
 * 牆面唯讀：指紋＋seatToken 驗證（免登入；不自動開席）。
 * Central 設定：JWT + system.multimedia（不佔席）。
 */
const requireWallSeatOrMultimediaAuth = async (req, res, next) => {
  try {
    if (req.user) {
      if (req.user.role === "admin") return next();
      const codes = await permissionService.attachEffectivePermissions(req);
      if (permissionService.hasPermissionCode(codes, "system.multimedia")) {
        return next();
      }
      return res.sendFailure(
        {
          code: C.PERMISSION_DENIED,
          message: "權限不足",
          details: null,
        },
        403,
      );
    }

    await multimediaWallSeatService.verifySeatAndTouch({
      fingerprint:
        multimediaWallSeatService.resolveFingerprintFromRequest(req),
      seatToken: multimediaWallSeatService.resolveSeatTokenFromRequest(req),
      hostname: multimediaWallSeatService.resolveHostnameFromRequest(req),
    });
    return next();
  } catch (error) {
    const status = error?.statusCode || 500;
    return res.sendFailure(
      {
        code: error?.code || C.INTERNAL_ERROR,
        message: error?.message || "牆面席次檢查失敗",
        details: error?.details ?? null,
      },
      status,
    );
  }
};

/** 可選解析 JWT（失敗不擋；供唯讀雙模式） */
const optionalAuthenticate = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return next();
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7).trim()
      : authHeader.trim();
    if (!token) return next();
    const userService = require("../services/platform/userService");
    const decoded = userService.verifyToken(token);
    if (!decoded) return next();
    const versionCheck = await userService.verifyTokenVersion(decoded);
    if (!versionCheck.ok) return next();
    req.user = decoded;
  } catch {
    /* ignore */
  }
  return next();
};

// ========== Wall seats（啟用／管理） ==========

/** 牆面程式首次／回收後啟用：核發 seatToken（明文僅此回應） */
router.post(
  "/wall/activate",
  asyncHandler(async (req, res) => {
    const result = await multimediaWallSeatService.activateSeat({
      fingerprint:
        multimediaWallSeatService.resolveFingerprintFromRequest(req),
      seatToken:
        multimediaWallSeatService.resolveSeatTokenFromRequest(req) ||
        undefined,
      hostname: multimediaWallSeatService.resolveHostnameFromRequest(req),
    });
    res.sendSuccess({
      fingerprint: result.fingerprint,
      seatToken: result.seatToken,
      existing: Boolean(result.existing),
    });
  }),
);

router.get(
  "/wall/seats",
  authenticate,
  requirePermission("system.multimedia"),
  asyncHandler(async (_req, res) => {
    const seats = await multimediaWallSeatService.listSeats();
    res.sendSuccess({ seats });
  }),
);

router.delete(
  "/wall/seats/:fingerprint",
  authenticate,
  requirePermission("system.multimedia.settings.update"),
  asyncHandler(async (req, res) => {
    const result = await multimediaWallSeatService.revokeSeat(
      req.params.fingerprint,
    );
    if (!result.deleted) {
      return res.sendFailure(
        {
          code: C.NOT_FOUND,
          message: "找不到該牆面席次",
          details: { fingerprint: result.fingerprint },
        },
        404,
      );
    }
    res.sendSuccess({ revoked: true, fingerprint: result.fingerprint });
  }),
);

// ========== Settings ==========

router.get(
  "/dashboard/settings",
  optionalAuthenticate,
  requireWallSeatOrMultimediaAuth,
  asyncHandler(async (_req, res) => {
    const settings = await multimediaDashboardService.getDashboardSettings();
    res.sendSuccess({ settings });
  }),
);

router.put(
  "/dashboard/settings",
  authenticate,
  requirePermission("system.multimedia"),
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
  optionalAuthenticate,
  requireWallSeatOrMultimediaAuth,
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
  authenticate,
  requirePermission("system.multimedia"),
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
