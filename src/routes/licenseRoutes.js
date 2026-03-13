const express = require("express");
const router = express.Router();

const licenseService = require("../services/licenseService");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");

/** GET /api/license 需認證；回傳 features、expiresAt、expired、canActivate */
router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const license = await licenseService.getLicenseState();
    const canActivate = req.user?.role === "admin";

    res.sendSuccess({
      features: license.features || [],
      expiresAt: license.expiresAt,
      expired: license.expired,
      canActivate,
    });
  }),
);

/** POST /api/license/activate 需 admin；body: { features: string[], expiresAt? }；僅儲存合法 feature key */
router.post(
  "/activate",
  authenticate,
  requireAdmin,
  validateRequired("features"),
  asyncHandler(async (req, res) => {
    const { features, expiresAt } = req.body || {};
    if (!Array.isArray(features) || features.length === 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_LICENSE_PAYLOAD",
        message: "features 必須為非空陣列",
      });
    }
    const license = await licenseService.setLicenseState({
      features,
      expiresAt,
      description: `授權啟用（by user:${req.user?.id ?? "unknown"}）`,
    });

    res.sendSuccess({
      features: license.features || [],
      expiresAt: license.expiresAt,
      expired: license.expired,
    });
  }),
);

module.exports = router;

