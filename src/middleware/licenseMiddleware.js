const licenseService = require("../services/license/licenseService");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");

function requireFeature(featureKey) {
  if (!featureKey || typeof featureKey !== "string") {
    throwApiError(
      C.LICENSE_FEATURE_KEY_REQUIRED,
      "requireFeature(featureKey) 需要非空字串",
      { statusCode: 500 },
    );
  }

  return async (req, res, next) => {
    try {
      const license = await licenseService.getLicenseState();
      const enabled = Array.isArray(license.features)
        && license.features.includes(featureKey);

      if (enabled) return next();

      return res.sendFailure(
        {
          code: C.FEATURE_NOT_LICENSED,
          message: `未授權功能：${featureKey}`,
          details: { feature: featureKey },
        },
        403,
      );
    } catch (error) {
      // License check failures should be explicit (avoid accidental bypass)
      return res.sendFailure(
        {
          code: C.LICENSE_CHECK_FAILED,
          message: "授權狀態檢查失敗",
          details: error.message,
        },
        503,
      );
    }
  };
}

module.exports = {
  requireFeature,
};
