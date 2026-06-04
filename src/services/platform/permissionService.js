const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const {
  getPermissionCodesForDeployment,
} = require("../../config/permissionCatalog");

const catalogCodesForDeployment = () => getPermissionCodesForDeployment();

const catalogCodeSet = () => new Set(catalogCodesForDeployment());

const CACHE_TTL_MS = 45_000;
/** @type {Map<number, { codes: string[], expiresAt: number }>} */
const effectiveCache = new Map();

const invalidateUserPermissionCache = (userId) => {
	if (userId != null) effectiveCache.delete(Number(userId));
};

/**
 * 有效權限：admin 為 catalog 全開；user 僅 overrides（granted=true）
 */
async function getEffectivePermissionsForUser(userId, role = null) {
	const uid = Number(userId);
	const cached = effectiveCache.get(uid);
	if (cached && cached.expiresAt > Date.now()) {
		return { codes: cached.codes, granted: new Set(cached.codes) };
	}
	const codes = catalogCodesForDeployment();

	let userRole = role;
	if (userRole == null) {
		const users = await db.query("SELECT role FROM users WHERE id = ?", [userId]);
		if (users.length === 0) return { codes: [], granted: new Set() };
		userRole = users[0].role;
	}

	if (userRole === "admin") {
		effectiveCache.set(uid, {
			codes,
			expiresAt: Date.now() + CACHE_TTL_MS,
		});
		return { codes, granted: new Set(codes) };
	}

	const allowed = catalogCodeSet(); // 僅本部署 profile 內的碼
	const defs = await db.query(
		"SELECT id, code FROM permission_definitions WHERE code = ANY(?::text[])",
		[codes],
	);
	const codeById = new Map(defs.map((d) => [d.id, d.code]));

	const overrides = await db.query(
		"SELECT permission_id, granted FROM user_permission_overrides WHERE user_id = ? AND granted = TRUE",
		[userId],
	);
	const granted = new Set();
	for (const o of overrides) {
		const code = codeById.get(o.permission_id);
		if (code && allowed.has(code)) granted.add(code);
	}
	const grantedCodes = Array.from(granted);
	effectiveCache.set(uid, {
		codes: grantedCodes,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
	return { codes: grantedCodes, granted: new Set(grantedCodes) };
}

const hasPermissionCode = (codes, requiredCode) =>
	Array.isArray(codes) && codes.includes(requiredCode);

async function replaceUserPermissionOverrides(userId, overrides, clientQuery) {
	await clientQuery("DELETE FROM user_permission_overrides WHERE user_id = ?", [userId]);
	for (const o of overrides) {
		if (o.permission_id == null || o.granted !== true) continue;
		await clientQuery(
			"INSERT INTO user_permission_overrides (user_id, permission_id, granted) VALUES (?, ?, TRUE)",
			[userId, Number(o.permission_id)],
		);
	}
}

async function setUserPermissionOverrides(userId, overrides) {
	await db.transaction(async (clientQuery) => {
		await replaceUserPermissionOverrides(userId, overrides, clientQuery);
	});
	invalidateUserPermissionCache(userId);
}

async function getUserPermissionOverrides(userId) {
	const users = await db.query("SELECT role FROM users WHERE id = ?", [userId]);
	if (users.length === 0) {
		throwApiError(C.USER_NOT_FOUND, "用戶不存在");
	}
	if (users[0].role === "admin") {
		return { overridesByPermId: {} };
	}
	const overrides = await db.query(
		"SELECT permission_id, granted FROM user_permission_overrides WHERE user_id = ?",
		[userId],
	);
	return {
		overridesByPermId: Object.fromEntries(
			overrides.map((o) => [o.permission_id, o.granted]),
		),
	};
}

async function getDefinitions() {
	return db.query(
		`SELECT id, code, category, parent_id, name, sort_order
		 FROM permission_definitions
		 WHERE code = ANY(?::text[])
		 ORDER BY category, sort_order, id`,
		[catalogCodesForDeployment()],
	);
}

async function clearUserPermissionOverrides(userId, clientQuery = null) {
	const run = clientQuery || db.query.bind(db);
	await run("DELETE FROM user_permission_overrides WHERE user_id = ?", [userId]);
}

/** 僅保留 catalog 內且父層已 grant 的項目 */
async function sanitizeOverrides(overrides) {
	if (!Array.isArray(overrides) || overrides.length === 0) return [];

	const defs = await db.query(
		"SELECT id, parent_id FROM permission_definitions WHERE code = ANY(?::text[])",
		[catalogCodesForDeployment()],
	);
	const byId = new Map(defs.map((d) => [d.id, d]));
	const grantedParentIds = new Set();
	const childRows = [];

	for (const o of overrides) {
		if (o.granted !== true) continue;
		const def = byId.get(Number(o.permission_id));
		if (!def) continue;
		if (def.parent_id == null) {
			grantedParentIds.add(def.id);
		} else {
			childRows.push(def);
		}
	}

	const result = [...grantedParentIds].map((permission_id) => ({
		permission_id,
		granted: true,
	}));
	for (const def of childRows) {
		if (grantedParentIds.has(def.parent_id)) {
			result.push({ permission_id: def.id, granted: true });
		}
	}
	return result;
}

module.exports = {
	getDefinitions,
	getEffectivePermissionsForUser,
	setUserPermissionOverrides,
	replaceUserPermissionOverrides,
	getUserPermissionOverrides,
	clearUserPermissionOverrides,
	hasPermissionCode,
	sanitizeOverrides,
	invalidateUserPermissionCache,
};
