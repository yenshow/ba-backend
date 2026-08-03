const userService = require("../services/platform/userService");
const permissionService = require("../access/permissionService");
const { LOCATION_TYPE_MODULE } = require("../access/catalog");
const C = require("../utils/apiErrorCodes");

const sendAuthFailure = (res, status, code, message) =>
  res.sendFailure({ code, message, details: null }, status);

const { attachEffectivePermissions } = permissionService;

/**
 * 從 Authorization header 或（可選）query access_token 解析 JWT 字串
 * @param {import('express').Request} req
 * @param {{ allowQuery?: boolean }} [options]
 */
function resolveRequestToken(req, options = {}) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    return authHeader.startsWith("Bearer ")
      ? authHeader.substring(7).trim()
      : authHeader.trim();
  }
  if (options.allowQuery) {
    const fromQuery = String(req.query?.access_token || "").trim();
    if (fromQuery) return fromQuery;
  }
  return null;
}

/**
 * 驗證 token 並回傳 decoded user；失敗時回傳 { error: { status, code, message } }
 */
async function authenticateToken(token) {
  if (!token) {
    return {
      error: {
        status: 401,
        code: C.AUTH_TOKEN_MISSING,
        message: "未提供認證 Token",
      },
    };
  }

  const decoded = userService.verifyToken(token);
  if (!decoded) {
    return {
      error: {
        status: 401,
        code: C.AUTH_TOKEN_INVALID,
        message: "無效的 Token",
      },
    };
  }

  const versionCheck = await userService.verifyTokenVersion(decoded);
  if (!versionCheck.ok) {
    return {
      error: {
        status: 401,
        code: versionCheck.code,
        message: versionCheck.message,
      },
    };
  }

  return { user: decoded };
}

async function applyAuthentication(req, res, options = {}) {
  const token = resolveRequestToken(req, options);
  const result = await authenticateToken(token);
  if (result.error) {
    sendAuthFailure(
      res,
      result.error.status,
      result.error.code,
      result.error.message,
    );
    return false;
  }
  req.user = result.user;
  return true;
}

async function authenticate(req, res, next) {
  try {
    if (!(await applyAuthentication(req, res))) return;
    await attachEffectivePermissions(req);
    next();
  } catch (error) {
    return sendAuthFailure(res, 401, C.AUTH_FAILED, `認證失敗：${error.message}`);
  }
}

/** GET /api/uploads/*：允許 query access_token（供 img 標籤） */
async function authenticateUploadRead(req, res, next) {
  try {
    if (!(await applyAuthentication(req, res, { allowQuery: true }))) return;
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

function requirePlatformAdmin(req, res, next) {
  if (!req.user) {
    return sendAuthFailure(res, 401, C.AUTH_UNAUTHENTICATED, "未認證");
  }
  if (!userService.isPlatformAdminUser(req.user)) {
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

/** 具備任一權限碼即可通過（用於跨模組別名，如車牌設備同步） */
const requireAnyPermission = (requiredCodes) => async (req, res, next) => {
  const codes = Array.isArray(requiredCodes) ? requiredCodes : [requiredCodes];
  if (codes.length === 0) {
    return sendAuthFailure(res, 500, C.PERMISSION_LOAD_FAILED, "未設定權限檢查");
  }
  if (!req.user) {
    return sendAuthFailure(res, 401, C.AUTH_UNAUTHENTICATED, "未認證");
  }
  if (req.user.role === "admin") {
    return next();
  }
  try {
    const effective = await attachEffectivePermissions(req);
    if (codes.some((code) => permissionService.hasPermissionCode(effective, code))) {
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

const resolveAreaPointMapDeleteCode = (req) => {
  const routePath = String(req.route?.path || "");
  const segment = routePath.startsWith("/zones") ? "zone" : "location";
  return `${AREA_POINT_MAP_MODULE}.${segment}.delete`;
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
    if (action !== "delete") {
      return sendAuthFailure(
        res,
        400,
        C.VALIDATION_CUSTOM,
        "區域／地點新增與編輯須指定 locationType，請於各系統模組內操作",
      );
    }
    return requirePermission(resolveAreaPointMapDeleteCode(req))(
      req,
      res,
      next,
    );
  }
  if (action === "update" && req.query.locationType) {
    return requireAnyPermission([
      `${moduleCode}.location.update`,
      `${moduleCode}.location.delete`,
    ])(req, res, next);
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

const requireEnergyReportFullIfScoped = () => async (req, res, next) => {
  const scope = String(req.query.reportScope || "").trim().toLowerCase();
  if (scope === "full") {
    return requirePermission("system.energy.report.full")(req, res, next);
  }
  const hasRange =
    String(req.query.startTime || "").trim() !== "" &&
    String(req.query.endTime || "").trim() !== "";
  const routePath = String(req.route?.path || "");
  const isAggregatedRoute =
    routePath.endsWith("/aggregated") || routePath.includes("/usage/aggregated");
  if (!isAggregatedRoute && hasRange) {
    return requirePermission("system.energy.report.full")(req, res, next);
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
  authenticateUploadRead,
  requireAdmin,
  requirePlatformAdmin,
  attachEffectivePermissions,
  requirePermission,
  requireAnyPermission,
  requireLocationMutation,
  requireLocationTypeModuleAccess,
  requirePlateUpsert,
  requireAlertExportIfBulk,
  requireEnvironmentReportFullIfScoped,
  requireEnergyReportFullIfScoped,
  ALERT_EXPORT_BULK_LIMIT_THRESHOLD,
};
