const crypto = require("crypto");
const os = require("os");
const express = require("express");
const router = express.Router();

const licenseService = require("../services/license/licenseService");
const licensePlatformService = require("../services/license/licensePlatformService");
const licenseQuotaService = require("../services/license/licenseQuotaService");
const licenseRuntimeService = require("../services/license/licenseRuntimeService");
const { authenticate, requireAdmin, requirePlatformAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { verifyLicensePayload } = require("../utils/licenseSign");
const config = require("../config");
const C = require("../utils/apiErrorCodes");

const toLicenseApiPayload = async (license) => ({
  features: license.features || [],
  quotas: license.quotas || {},
  usage: await licenseQuotaService.getUsageMap(
    Object.keys(license.quotas || {}),
  ),
  expired: license.expired,
  serialNumber: license.serialNumber ?? null,
  licenseKey: license.licenseKey ?? null,
  activationMethod: license.activationMethod ?? null,
  deviceFingerprint: license.deviceFingerprint ?? null,
  extensionKeys: license.extensionKeys ?? [],
  licenseEntitlements: license.licenseEntitlements ?? [],
});

const trimLicenseKey = (raw) => {
  if (raw == null || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
};

const sendInvalidLicenseKey = (res) =>
  res.sendFailure(
    {
      code: C.INVALID_LICENSE_PAYLOAD,
      message: "請提供 licenseKey",
      details: null,
    },
    400,
  );

const sendLicenseMutationSuccess = async (res, license, reason) => {
  await licenseRuntimeService.reconcileBackgroundServices({
    reason,
    licensedFeatures: licenseService.filterEffectiveFeatures(license.features),
  });
  return res.sendSuccess({
    ...(await toLicenseApiPayload(license)),
    canActivate: true,
  });
};

/** GET /api/license 需認證；回傳本地授權狀態 */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const license = await licenseService.getLicenseState();
    const canActivate = req.user?.role === "admin";

    res.sendSuccess({
      ...(await toLicenseApiPayload(license)),
      canActivate,
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

    if (licenseKey != null && typeof licenseKey === "string") {
      const trimmedKey = trimLicenseKey(licenseKey);
      if (!trimmedKey) {
        return sendInvalidLicenseKey(res);
      }
      const deviceFingerprint = getDeviceFingerprint();
      const result = await licensePlatformService.activateOnline({
        licenseKey: trimmedKey,
        deviceFingerprint,
      });

      const current = await licenseService.getLicenseState({
        bypassCache: true,
      });
      const serialEmpty =
        result.serialNumber == null ||
        (typeof result.serialNumber === "string" &&
          !String(result.serialNumber).trim());
      const isExtensionActivation =
        result.isExtension === true || (serialEmpty && current.licenseKey);

      if (isExtensionActivation) {
        const license = await licenseService.setLicenseState({
          mergeFeatures: true,
          features: result.features,
          mergeQuotas: true,
          quotas: result.quotas || {},
          preserveMainLicenseKey: true,
          appendExtensionKey: trimmedKey,
          appendLicenseEntitlement: {
            licenseKey: trimmedKey,
            features: result.features,
            quotas: result.quotas || {},
          },
          deviceFingerprint:
            result.deviceFingerprint != null
              ? result.deviceFingerprint
              : undefined,
          description: `授權啟用（online 副LK, by user:${req.user?.id ?? "unknown"}）`,
        });

        return sendLicenseMutationSuccess(res, license, "license_activate_extension");
      }

      const mainKey = result.licenseKey ?? trimmedKey;
      const license = await licenseService.setLicenseState({
        features: result.features,
        quotas: result.quotas || {},
        serialNumber: result.serialNumber ?? null,
        licenseKey: mainKey,
        activationMethod: "online",
        deviceFingerprint: result.deviceFingerprint ?? deviceFingerprint,
        extensionKeys: [],
        replaceLicenseEntitlements: [
          {
            licenseKey: mainKey,
            features: result.features,
            quotas: result.quotas || {},
          },
        ],
        description: `授權啟用（online 主LK, by user:${req.user?.id ?? "unknown"}）`,
      });

      return sendLicenseMutationSuccess(res, license, "license_activate_main");
    }

    if (!Array.isArray(features) || features.length === 0) {
      return res.sendFailure(
        {
          code: C.INVALID_LICENSE_PAYLOAD,
          message: "請提供 licenseKey 或非空 features 陣列",
          details: null,
        },
        400,
      );
    }

    const license = await licenseService.setLicenseState({
      features,
      activationMethod: "manual",
      replaceLicenseEntitlements: [],
      description: `授權啟用（manual, by user:${req.user?.id ?? "unknown"}）`,
    });

    return sendLicenseMutationSuccess(res, license, "license_activate_manual");
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
    const trimmedKey = trimLicenseKey(req.body?.licenseKey);
    if (!trimmedKey) {
      return sendInvalidLicenseKey(res);
    }

    const deviceFingerprint = getDeviceFingerprint();
    const json = JSON.stringify([trimmedKey, deviceFingerprint]);
    const requestFileBase64 = Buffer.from(json, "utf8").toString("base64");

    return res.sendSuccess({ requestFileBase64 });
  }),
);

/**
 * POST /api/license/reset（需 platform admin，username=admin）
 */
router.post(
  "/reset",
  authenticate,
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const next = await licenseService.resetLicenseState({
      description: `授權重置（by user:${req.user?.id ?? "unknown"}）`,
    });

    return sendLicenseMutationSuccess(res, next, "license_reset");
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
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.sendFailure(
        {
          code: C.INVALID_LICENSE_PAYLOAD,
          message: "離線授權檔格式不正確",
          details: null,
        },
        400,
      );
    }

    const secret = config.license?.signSecret;
    if (!secret) {
      return res.sendFailure(
        {
          code: C.LICENSE_SIGN_SECRET_MISSING,
          message: "未設定 LICENSE_SIGN_SECRET，無法驗簽離線授權檔",
          details: null,
        },
        500,
      );
    }

    const verified = verifyLicensePayload(payload, secret);
    if (!verified.ok) {
      return res.sendFailure(
        {
          code: C.INVALID_OFFLINE_LICENSE_SIGNATURE,
          message: "離線授權檔驗簽失敗",
          details: verified.reason,
        },
        403,
      );
    }

    const product = payload?.product;
    if (product && product !== "BA-system") {
      return res.sendFailure(
        {
          code: C.INVALID_LICENSE_PRODUCT,
          message: "授權產品不匹配",
          details: null,
        },
        400,
      );
    }

    if (!Array.isArray(payload?.features) || payload.features.length === 0) {
      return res.sendFailure(
        {
          code: C.INVALID_LICENSE_PAYLOAD,
          message: "離線授權檔缺少 features",
          details: null,
        },
        400,
      );
    }

    let isExtension;
    if (payload.isExtension === true) isExtension = true;
    else if (payload.isExtension === false) isExtension = false;
    else isExtension = payload.refreshedAt != null;

    const activatedKey =
      typeof payload.licenseKey === "string" ? payload.licenseKey.trim() : null;

    if (!isExtension) {
      const mainLk =
        typeof payload.licenseKey === "string"
          ? payload.licenseKey.trim()
          : null;
      const license = await licenseService.setLicenseState({
        features: payload.features,
        quotas: payload.quotas || {},
        serialNumber: payload.serialNumber ?? null,
        licenseKey: payload.licenseKey ?? null,
        activationMethod: "offline",
        deviceFingerprint: payload.deviceFingerprint ?? null,
        extensionKeys: [],
        replaceLicenseEntitlements: mainLk
          ? [
              {
                licenseKey: mainLk,
                features: payload.features,
                quotas: payload.quotas || {},
              },
            ]
          : [],
        description: `授權匯入（offline 首次, by user:${req.user?.id ?? "unknown"}）`,
      });

      return sendLicenseMutationSuccess(res, license, "license_offline_import_main");
    }

    const license = await licenseService.setLicenseState({
      mergeFeatures: true,
      features: payload.features,
      mergeQuotas: true,
      quotas: payload.quotas || {},
      preserveMainLicenseKey: true,
      appendExtensionKey: activatedKey || undefined,
      appendLicenseEntitlement: activatedKey
        ? {
            licenseKey: activatedKey,
            features: payload.features,
            quotas: payload.quotas || {},
          }
        : undefined,
      deviceFingerprint:
        payload.deviceFingerprint != null
          ? payload.deviceFingerprint
          : undefined,
      description: `授權匯入（offline 追加, by user:${req.user?.id ?? "unknown"}）`,
    });

    return sendLicenseMutationSuccess(res, license, "license_offline_import_extension");
  }),
);

module.exports = router;
