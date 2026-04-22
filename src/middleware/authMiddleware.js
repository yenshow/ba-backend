const userService = require("../services/userService");
const permissionService = require("../services/permissionService");

// 驗證 JWT Token 中間件
function authenticate(req, res, next) {
	try {
		const authHeader = req.headers.authorization;

		if (!authHeader) {
			return res.status(401).json({ error: "未提供認證 Token" });
		}

		// 支援 "Bearer <token>" 格式
		const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;

		// 驗證 Token
		const decoded = userService.verifyToken(token);
		if (!decoded) {
			return res.status(401).json({ error: "無效的 Token" });
		}

		// 將用戶資訊附加到 request
		req.user = decoded;
		next();
	} catch (error) {
		return res.status(401).json({ error: "認證失敗", details: error.message });
	}
}

// 檢查角色權限中間件
function authorize(...allowedRoles) {
	return (req, res, next) => {
		if (!req.user) {
			return res.status(401).json({ error: "未認證" });
		}

		if (!allowedRoles.includes(req.user.role)) {
			return res.status(403).json({ error: "權限不足" });
		}

		next();
	};
}

// 檢查是否為管理員
function requireAdmin(req, res, next) {
	return authorize("admin")(req, res, next);
}

// 檢查是否為管理員或操作員
function requireAdminOrOperator(req, res, next) {
	return authorize("admin", "operator")(req, res, next);
}

/**
 * 檢查是否具備指定權限（精細權限）
 * 若 req.user 無 permissions 則自 DB 解析後掛上；admin 視為擁有全部權限
 * @param {string} requiredCode - 權限代碼，如 'system.area_point_map'
 */
function requirePermission(requiredCode) {
	return async (req, res, next) => {
		if (!req.user) {
			return res.status(401).json({ error: "未認證" });
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
				return res.status(500).json({ error: "無法取得權限", details: err.message });
			}
		}
		if (codes.includes(requiredCode)) {
			return next();
		}
		return res.status(403).json({ error: "權限不足" });
	};
}

module.exports = {
	authenticate,
	authorize,
	requireAdmin,
	requireAdminOrOperator,
	requirePermission
};

