const userService = require("../services/platform/userService");
const permissionService = require("../access/permissionService");
const { LOCATION_TYPE_MODULE } = require("../access/catalog");
const C = require("../utils/apiErrorCodes");

const sendAuthFailure = (res, status, code, message) =>
  res.sendFailure({ code, message, details: null }, status);

const { attachEffectivePermissions } = permissionService;

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return sendAuthFailure(res, 401, C.AUTH_TOKEN_MISSING, "未提供認證 Token");
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : authHeader;
    const decoded = userService.verifyToken(token);
    if (!decoded) {
      return sendAuthFailure(res, 401, C.AUTH_TOKEN_INVALID, "無效的 Token");
    }

    req.user = decoded;
    await attachEffectivePermissions(req);
    next();
  } catch (error) {
    return sendAuthFailure(res, 401, C.AUTH_FAILED, `認證失敗：${error.message}`);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return sendAuthFailure(res, 401, C.AUTH_UNAUTHENTICATED, "未認證");
  }
  if (req.user.role !== "admin") {
    return sendAuthFailure(res, 403, C.PERMISSION_DENIED, "權限不足");
  }
  next();
}

const requirePermission = (requiredCode) => async (req, res, next) => {
  if (!req.user) {
    return sendAuthFailure(res, 401, C.AUTH_UNAUTHENTICATED, "未認證");
  }
  if (req.user.role === "admin") {
    return next();
  }
  try {
    const codes = await attachEffectivePermissions(req);
    if (permissionService.hasPermissionCode(codes, requiredCode)) {
      return next();
    }
    return sendAuthFailure(res, 403, C.PERMISSION_DENIED, "權限不足");
  } catch (err) {
    return sendAuthFailure(
      res,
      500,
      C.PERMISSION_LOAD_FAILED,
      `無法取得權限：${err.message}`,
    );
  }
};

const AREA_POINT_MAP_MODULE = "system.area_point_map";

const resolveAreaPointMapMutationCode = (req, action) => {
  const routePath = String(req.route?.path || "");
  const isZoneRoute = routePath.startsWith("/zones");
  const segment = isZoneRoute ? "zone" : "location";
  return `${AREA_POINT_MAP_MODULE}.${segment}.${action}`;
};

const requireLocationMutation = (action) => async (req, res, next) => {
  const locationType =
    req.query.locationType ||
    req.body?.locationType ||
    (Array.isArray(req.body?.systems) && req.body.systems[0]?.systemType);
  const moduleCode = locationType
    ? LOCATION_TYPE_MODULE[String(locationType)]
    : null;
  if (!moduleCode) {
    return requirePermission(resolveAreaPointMapMutationCode(req, action))(
      req,
      res,
      next,
    );
  }
  return requirePermission(`${moduleCode}.location.${action}`)(req, res, next);
};

const requireLocationTypeModuleAccess = () => async (req, res, next) => {
  const locationType = req.query.locationType;
  const moduleCode = locationType
    ? LOCATION_TYPE_MODULE[String(locationType)]
    : null;
  if (!moduleCode) {
    return next();
  }
  return requirePermission(moduleCode)(req, res, next);
};

/** 警示 CSV 匯出等大量查詢（列表分頁／輪詢遠低於此門檻） */
const ALERT_EXPORT_BULK_LIMIT_THRESHOLD = 500;

const requireAlertExportIfBulk = () => async (req, res, next) => {
  const raw = req.query.limit;
  if (raw == null || raw === "") return next();
  const limit = Number.parseInt(String(raw), 10);
  if (
    !Number.isFinite(limit) ||
    limit < ALERT_EXPORT_BULK_LIMIT_THRESHOLD
  ) {
    return next();
  }
  return requirePermission("system.alert_log.report.export")(req, res, next);
};

/**
 * 環境完整報表：aggregated 須 query `reportScope=full`；
 * raw readings 帶 startTime+endTime 亦視為歷史區間查詢。
 */
const requireEnvironmentReportFullIfScoped = () => async (req, res, next) => {
  const scope = String(req.query.reportScope || "").trim().toLowerCase();
  if (scope === "full") {
    return requirePermission("system.environment.report.full")(
      req,
      res,
      next,
    );
  }
  const hasRange =
    String(req.query.startTime || "").trim() !== "" &&
    String(req.query.endTime || "").trim() !== "";
  const routePath = String(req.route?.path || "");
  const isAggregatedRoute = routePath.endsWith("/aggregated");
  if (!isAggregatedRoute && hasRange) {
    return requirePermission("system.environment.report.full")(
      req,
      res,
      next,
    );
  }
  return next();
};

const requirePlateUpsert = () => async (req, res, next) => {
  const mutation = String(req.query.mutation || "").trim().toLowerCase();
  if (mutation === "create") {
    return requirePermission("system.vehicle_access.plate.create")(
      req,
      res,
      next,
    );
  }
  if (mutation === "update") {
    return requirePermission("system.vehicle_access.plate.update")(
      req,
      res,
      next,
    );
  }
  return sendAuthFailure(
    res,
    400,
    C.VALIDATION_INVALID_ENUM,
    "需提供 mutation=create 或 mutation=update",
  );
};

module.exports = {
  authenticate,
  requireAdmin,
  attachEffectivePermissions,
  requirePermission,
  requireLocationMutation,
  requireLocationTypeModuleAccess,
  requirePlateUpsert,
  requireAlertExportIfBulk,
  requireEnvironmentReportFullIfScoped,
  ALERT_EXPORT_BULK_LIMIT_THRESHOLD,
};
