const userService = require("../services/platform/userService");
const permissionService = require("../services/platform/permissionService");
const C = require("../utils/apiErrorCodes");

// 驗證 JWT Token 中間件
function authenticate(req, res, next) {
	try {
		const authHeader = req.headers.authorization;

		if (!authHeader) {
			return res.sendFailure(
				{
					code: C.AUTH_TOKEN_MISSING,
					message: "未提供認證 Token",
					details: null,
				},
				401,
			);
		}

		// 支援 "Bearer <token>" 格式
		const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;

		// 驗證 Token
		const decoded = userService.verifyToken(token);
		if (!decoded) {
			return res.sendFailure(
				{
					code: C.AUTH_TOKEN_INVALID,
					message: "無效的 Token",
					details: null,
				},
				401,
			);
		}

		// 將用戶資訊附加到 request
		req.user = decoded;
		next();
	} catch (error) {
		return res.sendFailure(
			{
				code: C.AUTH_FAILED,
				message: "認證失敗",
				details: error.message,
			},
			401,
		);
	}
}

// 檢查角色權限中間件
function authorize(...allowedRoles) {
	return (req, res, next) => {
		if (!req.user) {
			return res.sendFailure(
				{
					code: C.AUTH_UNAUTHENTICATED,
					message: "未認證",
					details: null,
				},
				401,
			);
		}

		if (!allowedRoles.includes(req.user.role)) {
			return res.sendFailure(
				{
					code: C.PERMISSION_DENIED,
					message: "權限不足",
					details: null,
				},
				403,
			);
		}

		next();
	};
}

// 檢查是否為管理員
function requireAdmin(req, res, next) {
	return authorize("admin")(req, res, next);
}

// 檢查是否為管理員或操作員（頁面寫入操作：CRUD、設定儲存等）
function requireAdminOrOperator(req, res, next) {
	return authorize("admin", "operator")(req, res, next);
}

/** 語意別名：與 requireAdminOrOperator 相同，表示「可寫入」角色 */
const requireWriteRole = requireAdminOrOperator;

/**
 * 檢查是否具備指定權限（精細權限）
 * 若 req.user 無 permissions 則自 DB 解析後掛上；admin 視為擁有全部權限
 * @param {string} requiredCode - 權限代碼，如 'system.area_point_map'
 */
function requirePermission(requiredCode) {
	return async (req, res, next) => {
		if (!req.user) {
			return res.sendFailure(
				{
					code: C.AUTH_UNAUTHENTICATED,
					message: "未認證",
					details: null,
				},
				401,
			);
		}
		if (req.user.role === "admin") {
			return next();
		}
		let codes = req.user.permissions;
		if (!Array.isArray(codes)) {
			try {
				const result = await permissionService.getEffectivePermissionsForUser(req.user.id, req.user.role);
				codes = result.codes;
				req.user.permissions = codes;
			} catch (err) {
				return res.sendFailure(
					{
						code: C.PERMISSION_LOAD_FAILED,
						message: "無法取得權限",
						details: err.message,
					},
					500,
				);
			}
		}
		if (codes.includes(requiredCode)) {
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
	};
}

module.exports = {
	authenticate,
	authorize,
	requireAdmin,
	requireAdminOrOperator,
	requireWriteRole,
	requirePermission,
};
