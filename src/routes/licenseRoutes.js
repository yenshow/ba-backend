const crypto = require("crypto");
const os = require("os");
const express = require("express");
const router = express.Router();

const licenseService = require("../services/licenseService");
const licensePlatformService = require("../services/licensePlatformService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { verifyLicensePayload } = require("../utils/licenseSign");
const config = require("../config");

const toPlatformErrorStatus = (error) => {
  const status = error?.statusCode;
  return Number.isFinite(status) ? status : 502;
};

/** 優先使用平台回傳的 code，否則依 HTTP／訊息推斷 */
const toPlatformErrorCode = (error) => {
  const data = error?.data;
  const code = data && typeof data.code === "string" ? data.code.trim() : "";
  if (code) return code;

  const status = toPlatformErrorStatus(error);
  const msg = String(error?.message || "");

  if (status === 403 && msg.includes("使用過")) return "LICENSE_ALREADY_USED";
  if (status === 403 && msg.includes("停用")) return "LICENSE_INACTIVE";

  return "LICENSE_PLATFORM_ERROR";
};

/** GET /api/license 需認證；回傳本地授權狀態 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const license = await licenseService.getLicenseState();
    const canActivate = req.user?.role === "admin";

    res.sendSuccess({
      features: license.features || [],
      expired: license.expired,
      canActivate,
      serialNumber: license.serialNumber ?? null,
      licenseKey: license.licenseKey ?? null,
      activationMethod: license.activationMethod ?? null,
      deviceFingerprint: license.deviceFingerprint ?? null,
      extensionKeys: license.extensionKeys ?? [],
    });
  }),
);

/**
 * POST /api/license/activate（需 admin）
 * - 線上模式：{ licenseKey } → 後端產生 deviceFingerprint → 呼叫授權平台 /activate → 存本地
 * - 相容舊模式（手動寫入）：{ features: string[] }
 */
router.post(
  "/activate",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { licenseKey, features } = req.body || {};

    if (licenseKey && typeof licenseKey === "string") {
      const trimmedKey = licenseKey.trim();
      const deviceFingerprint = getDeviceFingerprint();
      let result;
      try {
        result = await licensePlatformService.activateOnline({
          licenseKey: trimmedKey,
          deviceFingerprint,
        });
      } catch (error) {
        return res.status(toPlatformErrorStatus(error)).json({
          success: false,
          code: toPlatformErrorCode(error),
          message: error.message || "授權平台啟用失敗",
          details: error.data,
        });
      }

      if (!result || !Array.isArray(result.features)) {
        return res.status(502).json({
          success: false,
          code: "LICENSE_PLATFORM_INVALID_RESPONSE",
          message: "授權平台回傳格式不正確",
        });
      }

      const current = await licenseService.getLicenseState({ bypassCache: true });
      const serialEmpty = result.serialNumber == null
        || (typeof result.serialNumber === "string" && !String(result.serialNumber).trim());
      const isExtensionActivation =
        result.isExtension === true
        || (serialEmpty && current.licenseKey);

      if (isExtensionActivation) {
        const license = await licenseService.setLicenseState({
          mergeFeatures: true,
          features: result.features,
          preserveMainLicenseKey: true,
          appendExtensionKey: trimmedKey,
          deviceFingerprint: result.deviceFingerprint != null
            ? result.deviceFingerprint
            : undefined,
          description: `授權啟用（online 副LK, by user:${req.user?.id ?? "unknown"}）`,
        });

        return res.sendSuccess({
          features: license.features || [],
          expired: license.expired,
          serialNumber: license.serialNumber ?? null,
          licenseKey: license.licenseKey ?? null,
          activationMethod: license.activationMethod ?? null,
          deviceFingerprint: license.deviceFingerprint ?? null,
          extensionKeys: license.extensionKeys ?? [],
        });
      }

      const license = await licenseService.setLicenseState({
        features: result.features,
        serialNumber: result.serialNumber ?? null,
        licenseKey: result.licenseKey ?? trimmedKey,
        activationMethod: "online",
        deviceFingerprint: result.deviceFingerprint ?? deviceFingerprint,
        extensionKeys: [],
        description: `授權啟用（online 主LK, by user:${req.user?.id ?? "unknown"}）`,
      });

      return res.sendSuccess({
        features: license.features || [],
        expired: license.expired,
        serialNumber: license.serialNumber ?? null,
        licenseKey: license.licenseKey ?? null,
        activationMethod: license.activationMethod ?? null,
        deviceFingerprint: license.deviceFingerprint ?? null,
        extensionKeys: license.extensionKeys ?? [],
      });
    }

    if (!Array.isArray(features) || features.length === 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_LICENSE_PAYLOAD",
        message: "請提供 licenseKey 或非空 features 陣列",
      });
    }

    const license = await licenseService.setLicenseState({
      features,
      activationMethod: "manual",
      description: `授權啟用（manual, by user:${req.user?.id ?? "unknown"}）`,
    });

    return res.sendSuccess({
      features: license.features || [],
      expired: license.expired,
      serialNumber: license.serialNumber ?? null,
      licenseKey: license.licenseKey ?? null,
      activationMethod: license.activationMethod ?? null,
      deviceFingerprint: license.deviceFingerprint ?? null,
      extensionKeys: license.extensionKeys ?? [],
    });
  }),
);

/**
 * 產生設備指紋（hostname + 第一個非內部 MAC 的 hash），供線上／離線與平台比對一致
 */
const getDeviceFingerprint = () => {
  const hostname = os.hostname() || "unknown";
  let mac = "";
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal && iface.mac) {
        mac = (iface.mac || "").replace(/:/g, "").toLowerCase();
        if (mac && mac !== "000000000000") break;
      }
    }
    if (mac) break;
  }
  const raw = `${hostname}:${mac || "nomac"}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
};

/**
 * POST /api/license/offline-request-file（需 admin）
 * body: { licenseKey }
 * 回傳 { requestFileBase64 } — Base64(JSON.stringify([licenseKey, deviceFingerprint]))
 */
router.post(
  "/offline-request-file",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const lk = typeof req.body?.licenseKey === "string" ? req.body.licenseKey.trim() : null;
    if (!lk) {
      return res.status(400).json({
        success: false,
        code: "INVALID_LICENSE_PAYLOAD",
        message: "請提供 licenseKey",
      });
    }

    const deviceFingerprint = getDeviceFingerprint();
    const json = JSON.stringify([lk, deviceFingerprint]);
    const requestFileBase64 = Buffer.from(json, "utf8").toString("base64");

    return res.sendSuccess({ requestFileBase64 });
  }),
);

/**
 * POST /api/license/reset（需 admin）
 */
router.post(
  "/reset",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const next = await licenseService.resetLicenseState({
      description: `授權重置（by user:${req.user?.id ?? "unknown"}）`,
    });

    return res.sendSuccess({
      features: next.features || [],
      expired: next.expired,
      serialNumber: next.serialNumber ?? null,
      licenseKey: next.licenseKey ?? null,
      activationMethod: next.activationMethod ?? null,
      deviceFingerprint: next.deviceFingerprint ?? null,
      extensionKeys: next.extensionKeys ?? [],
    });
  }),
);

/**
 * POST /api/license/offline-import（需 admin）
 * body = 離線回應檔完整 JSON（含 signature）
 * - 以 isExtension 區分主／副（無 isExtension 時 fallback：refreshedAt == null 視為首次）
 */
router.post(
  "/offline-import",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const secret = config.license?.signSecret;
    if (!secret) {
      return res.status(500).json({
        success: false,
        code: "LICENSE_SIGN_SECRET_MISSING",
        message: "未設定 LICENSE_SIGN_SECRET，無法驗簽離線授權檔",
      });
    }

    const verified = verifyLicensePayload(payload, secret);
    if (!verified.ok) {
      return res.status(403).json({
        success: false,
        code: "INVALID_OFFLINE_LICENSE_SIGNATURE",
        message: "離線授權檔驗簽失敗",
        details: verified.reason,
      });
    }

    const product = payload?.product;
    if (product && product !== "BA-system") {
      return res.status(400).json({
        success: false,
        code: "INVALID_LICENSE_PRODUCT",
        message: "授權產品不匹配",
      });
    }

    if (!Array.isArray(payload?.features) || payload.features.length === 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_LICENSE_PAYLOAD",
        message: "離線授權檔缺少 features",
      });
    }

    let isExtension;
    if (payload.isExtension === true) isExtension = true;
    else if (payload.isExtension === false) isExtension = false;
    else isExtension = payload.refreshedAt != null;

    const activatedKey = typeof payload.licenseKey === "string" ? payload.licenseKey.trim() : null;

    if (!isExtension) {
      const license = await licenseService.setLicenseState({
        features: payload.features,
        serialNumber: payload.serialNumber ?? null,
        licenseKey: payload.licenseKey ?? null,
        activationMethod: "offline",
        deviceFingerprint: payload.deviceFingerprint ?? null,
        extensionKeys: [],
        description: `授權匯入（offline 首次, by user:${req.user?.id ?? "unknown"}）`,
      });

      return res.sendSuccess({
        features: license.features || [],
        expired: license.expired,
        serialNumber: license.serialNumber ?? null,
        licenseKey: license.licenseKey ?? null,
        activationMethod: license.activationMethod ?? null,
        deviceFingerprint: license.deviceFingerprint ?? null,
        extensionKeys: license.extensionKeys ?? [],
      });
    }

    const license = await licenseService.setLicenseState({
      mergeFeatures: true,
      features: payload.features,
      preserveMainLicenseKey: true,
      appendExtensionKey: activatedKey || undefined,
      deviceFingerprint: payload.deviceFingerprint != null
        ? payload.deviceFingerprint
        : undefined,
      description: `授權匯入（offline 追加, by user:${req.user?.id ?? "unknown"}）`,
    });

    return res.sendSuccess({
      features: license.features || [],
      expired: license.expired,
      serialNumber: license.serialNumber ?? null,
      licenseKey: license.licenseKey ?? null,
      activationMethod: license.activationMethod ?? null,
      deviceFingerprint: license.deviceFingerprint ?? null,
      extensionKeys: license.extensionKeys ?? [],
    });
  }),
);

module.exports = router;
