const licenseService = require("../services/licenseService");

const buildNotLicensedError = (featureKey) => ({
  success: false,
  code: "FEATURE_NOT_LICENSED",
  feature: featureKey,
  message: `未授權功能：${featureKey}`,
});

function requireFeature(featureKey) {
  if (!featureKey || typeof featureKey !== "string") {
    throw new Error("requireFeature(featureKey) 需要非空字串");
  }

  return async (req, res, next) => {
    try {
      const license = await licenseService.getLicenseState();
      const enabled = Array.isArray(license.features)
        && license.features.includes(featureKey)
        && !license.expired;

      if (enabled) return next();

      return res.status(403).json(buildNotLicensedError(featureKey));
    } catch (error) {
      // License check failures should be explicit (avoid accidental bypass)
      return res.status(503).json({
        success: false,
        code: "LICENSE_CHECK_FAILED",
        message: "授權狀態檢查失敗",
        details: error.message,
      });
    }
  };
}

module.exports = {
  requireFeature,
};

