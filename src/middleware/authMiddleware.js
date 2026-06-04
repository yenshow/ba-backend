const userService = require("../services/platform/userService");
const permissionService = require("../services/platform/permissionService");
const {
  getPermissionCodesForDeployment,
} = require("../config/permissionCatalog");
const C = require("../utils/apiErrorCodes");

async function attachEffectivePermissions(req) {
	if (!req.user) return [];
	if (req.user.role === "admin") {
		const codes = getPermissionCodesForDeployment();
		req.user.permissions = codes;
		return codes;
	}
	if (Array.isArray(req.user.permissions)) {
		return req.user.permissions;
	}
	const { codes } = await permissionService.getEffectivePermissionsForUser(
		req.user.id,
		req.user.role,
	);
	req.user.permissions = codes;
	return codes;
}

function sendAuthFailure(res, status, code, message) {
	return res.sendFailure({ code, message, details: null }, status);
}

function authenticate(req, res, next) {
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

/** 需具備指定權限碼（含父層模組碼 system.{module}）；admin 略過 */
function requirePermission(requiredCode) {
	return async (req, res, next) => {
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
}

const LOCATION_TYPE_MODULE = {
	vehicle_access: "system.vehicle_access",
	environment: "system.environment",
	people_counting: "system.people_counting",
};

const AREA_POINT_MAP_MODULE = "system.area_point_map";

/** 區域路由（/zones…）與地點路由（/:id）在無 locationType 時改檢查全區點位圖細項 */
function resolveAreaPointMapMutationCode(req, action) {
	const routePath = String(req.route?.path || "");
	const isZoneRoute = routePath.startsWith("/zones");
	const segment = isZoneRoute ? "zone" : "location";
	return `${AREA_POINT_MAP_MODULE}.${segment}.${action}`;
}

function requireLocationMutation(action) {
	return async (req, res, next) => {
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
}

function requireLocationTypeModuleAccess() {
	return async (req, res, next) => {
		const locationType = req.query.locationType;
		const moduleCode = locationType
			? LOCATION_TYPE_MODULE[String(locationType)]
			: null;
		if (!moduleCode) {
			return next();
		}
		return requirePermission(moduleCode)(req, res, next);
	};
}

module.exports = {
	authenticate,
	requireAdmin,
	requirePermission,
	requireLocationMutation,
	requireLocationTypeModuleAccess,
};
