const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

/**
 * 有效權限：admin 全部 permission_definitions；其餘僅 user_permission_overrides（granted=true）
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

	if (userRole === "admin") {
		return { codes: allCodes, granted: new Set(allCodes) };
	}

	const overrides = await db.query(
		"SELECT permission_id, granted FROM user_permission_overrides WHERE user_id = ? AND granted = TRUE",
		[userId],
	);
	const granted = new Set();
	for (const o of overrides) {
		const code = codeById.get(o.permission_id);
		if (code) granted.add(code);
	}
	return { codes: Array.from(granted), granted };
}

async function replaceUserPermissionOverrides(userId, overrides, clientQuery) {
	await clientQuery("DELETE FROM user_permission_overrides WHERE user_id = ?", [userId]);
	for (const o of overrides) {
		if (o.permission_id == null) continue;
		const granted = o.granted === true || o.granted === 1 || o.granted === "true";
		await clientQuery(
			"INSERT INTO user_permission_overrides (user_id, permission_id, granted) VALUES (?, ?, ?)",
			[userId, Number(o.permission_id), granted],
		);
	}
}

async function setUserPermissionOverrides(userId, overrides) {
	await db.transaction(async (clientQuery) => {
		await replaceUserPermissionOverrides(userId, overrides, clientQuery);
	});
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

async function getDefinitions(options = {}) {
	const rows = await db.query(
		"SELECT id, code, category, parent_id, name, sort_order FROM permission_definitions ORDER BY category, sort_order, id",
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

async function clearUserPermissionOverrides(userId, clientQuery = null) {
	const run = clientQuery || db.query.bind(db);
	await run("DELETE FROM user_permission_overrides WHERE user_id = ?", [userId]);
}

module.exports = {
	getDefinitions,
	getEffectivePermissionsForUser,
	setUserPermissionOverrides,
	replaceUserPermissionOverrides,
	getUserPermissionOverrides,
	clearUserPermissionOverrides,
};
