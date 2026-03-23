const db = require("../database/db");

/**
 * 取得權限定義（樹狀或扁平），供權限設定頁與 API 使用
 * @param {Object} options - { tree: boolean } 若 true 回傳樹狀（依 parent_id），否則扁平陣列
 * @returns {Promise<Array>}
 */
async function getDefinitions(options = {}) {
	const rows = await db.query(
		"SELECT id, code, category, parent_id, name, sort_order FROM permission_definitions ORDER BY category, sort_order, id"
	);
	if (!options.tree) {
		return rows;
	}
	const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
	const roots = [];
	for (const r of rows) {
		const node = byId.get(r.id);
		if (r.parent_id == null) {
			roots.push(node);
		} else {
			const parent = byId.get(r.parent_id);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}
	}
	return roots;
}

/**
 * 取得某用戶的有效權限（角色預設 + 用戶覆寫）
 * admin 視為擁有全部權限；其餘先取角色預設再套用 user_permission_overrides
 * @param {number} userId
 * @param {string} [role] - 若已查過可傳入，避免再查 users
 * @returns {Promise<{ codes: string[], granted: Set<string> }>}
 */
async function getEffectivePermissionsForUser(userId, role = null) {
	const allDefs = await db.query("SELECT id, code FROM permission_definitions");
	const allCodes = allDefs.map((d) => d.code);
	const codeById = new Map(allDefs.map((d) => [d.id, d.code]));

	let userRole = role;
	if (userRole == null) {
		const users = await db.query("SELECT role FROM users WHERE id = ?", [userId]);
		if (users.length === 0) return { codes: [], granted: new Set() };
		userRole = users[0].role;
	}

	// admin 擁有全部權限
	if (userRole === "admin") {
		return { codes: allCodes, granted: new Set(allCodes) };
	}

	// 角色預設
	const roleDefaults = await db.query(
		"SELECT permission_id, granted FROM role_default_permissions WHERE role = ?",
		[userRole]
	);
	const effective = new Map();
	for (const r of roleDefaults) {
		const code = codeById.get(r.permission_id);
		if (code) effective.set(r.permission_id, r.granted);
	}

	// 未在 role_default_permissions 的權限視為未授予（若需「預設無」可再調整）
	for (const d of allDefs) {
		if (!effective.has(d.id)) effective.set(d.id, false);
	}

	// 用戶覆寫
	const overrides = await db.query(
		"SELECT permission_id, granted FROM user_permission_overrides WHERE user_id = ?",
		[userId]
	);
	for (const o of overrides) {
		effective.set(o.permission_id, o.granted);
	}

	const granted = new Set();
	for (const [permId, grantedVal] of effective) {
		if (grantedVal && codeById.has(permId)) granted.add(codeById.get(permId));
	}
	return { codes: Array.from(granted), granted };
}

/**
 * 設定某用戶的權限覆寫（僅儲存與角色預設不同的項目；傳入完整清單時由後端比對）
 * @param {number} userId
 * @param {Array<{ permission_id: number, granted: boolean }>} overrides
 */
async function setUserPermissionOverrides(userId, overrides) {
	await db.transaction(async (clientQuery) => {
		await clientQuery("DELETE FROM user_permission_overrides WHERE user_id = ?", [userId]);
		for (const o of overrides) {
			if (o.permission_id == null || typeof o.granted !== "boolean") continue;
			await clientQuery(
				"INSERT INTO user_permission_overrides (user_id, permission_id, granted) VALUES (?, ?, ?)",
				[userId, o.permission_id, o.granted]
			);
		}
	});
}

/**
 * 取得某用戶的權限設定（含角色預設 + 覆寫），供管理員/操作員編輯頁用
 * 有效權限由 roleDefaults + overrides 本地計算，不重複呼叫 getEffectivePermissionsForUser
 */
async function getUserPermissionSettings(userId) {
	const users = await db.query("SELECT id, role FROM users WHERE id = ?", [userId]);
	if (users.length === 0) throw new Error("用戶不存在");
	const userRole = users[0].role;

	const [definitions, roleDefaults, overrides] = await Promise.all([
		getDefinitions({ tree: false }),
		db.query("SELECT permission_id, granted FROM role_default_permissions WHERE role = ?", [userRole]),
		db.query("SELECT permission_id, granted FROM user_permission_overrides WHERE user_id = ?", [userId]),
	]);

	const roleDefaultsByPermId = Object.fromEntries(roleDefaults.map((r) => [r.permission_id, r.granted]));
	const overridesByPermId = Object.fromEntries(overrides.map((o) => [o.permission_id, o.granted]));

	// admin 視為全部授予；其餘由角色預設 + 覆寫計算
	const effectiveCodes = [];
	if (userRole === "admin") {
		effectiveCodes.push(...definitions.map((d) => d.code));
	} else {
		for (const d of definitions) {
			let granted = roleDefaultsByPermId[d.id] ?? false;
			if (overridesByPermId.hasOwnProperty(d.id)) granted = overridesByPermId[d.id];
			if (granted) effectiveCodes.push(d.code);
		}
	}

	return {
		definitions,
		roleDefaultsByPermId,
		overridesByPermId,
		effectiveCodes,
		role: userRole,
	};
}

module.exports = {
	getDefinitions,
	getEffectivePermissionsForUser,
	setUserPermissionOverrides,
	getUserPermissionSettings,
};
