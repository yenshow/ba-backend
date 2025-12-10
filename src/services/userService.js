const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../database/db");
const config = require("../config");

// 密碼雜湊
async function hashPassword(password) {
	const saltRounds = 10;
	return await bcrypt.hash(password, saltRounds);
}

// 驗證密碼
async function verifyPassword(password, hash) {
	return await bcrypt.compare(password, hash);
}

// 產生 JWT Token
function generateToken(user) {
	const payload = {
		id: user.id,
		username: user.username,
		role: user.role
	};
	return jwt.sign(payload, config.jwt.secret, {
		expiresIn: config.jwt.expiresIn
	});
}

// 驗證 JWT Token
function verifyToken(token) {
	try {
		return jwt.verify(token, config.jwt.secret);
	} catch (error) {
		return null;
	}
}

// 驗證 email 格式
function validateEmail(email) {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailRegex.test(email)) {
		throw new Error("email 格式不正確");
	}
}

// 驗證角色
function validateRole(role) {
	const validRoles = ["admin", "operator", "viewer"];
	if (!validRoles.includes(role)) {
		throw new Error("角色必須為 admin, operator 或 viewer");
	}
}

// 驗證狀態
function validateStatus(status) {
	const validStatuses = ["active", "inactive", "suspended"];
	if (!validStatuses.includes(status)) {
		throw new Error("狀態必須為 active, inactive 或 suspended");
	}
}

// 構建用戶查詢條件（用於 getUsers）
function buildUserQueryConditions(filters) {
	let whereClause = "WHERE 1=1";
	const params = [];

	if (filters.role) {
		whereClause += " AND role = ?";
		params.push(filters.role);
	}

	if (filters.status) {
		whereClause += " AND status = ?";
		params.push(filters.status);
	}

	return { whereClause, params };
}

// 註冊用戶
async function registerUser(userData) {
	const { username, email, password, role = "viewer" } = userData;

	// 驗證必填欄位
	if (!username || !email || !password) {
		throw new Error("username, email, password 為必填欄位");
	}

	// 驗證 email 格式
	validateEmail(email);

	// 驗證密碼長度
	if (password.length < 6) {
		throw new Error("密碼長度至少需要 6 個字元");
	}

	// 驗證角色
	validateRole(role);

	// 檢查用戶名是否已存在
	const existingUser = await db.query("SELECT id FROM users WHERE username = ?", [username]);
	if (existingUser.length > 0) {
		throw new Error("用戶名已存在");
	}

	// 檢查 email 是否已存在
	const existingEmail = await db.query("SELECT id FROM users WHERE email = ?", [email]);
	if (existingEmail.length > 0) {
		throw new Error("email 已存在");
	}

	// 雜湊密碼
	const passwordHash = await hashPassword(password);

	// 建立用戶
	const result = await db.query("INSERT INTO users (username, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'active') RETURNING id", [
		username,
		email,
		passwordHash,
		role
	]);

	// 取得建立的用戶（不包含密碼）
	const user = await db.query("SELECT id, username, email, role, status, created_at, updated_at FROM users WHERE id = ?", [result[0].id]);

	return user[0];
}

// 用戶登入
async function loginUser(credentials) {
	const { username, password } = credentials;

	if (!username || !password) {
		throw new Error("username 和 password 為必填欄位");
	}

	// 查詢用戶
	const users = await db.query("SELECT * FROM users WHERE username = ? OR email = ?", [username, username]);
	if (users.length === 0) {
		throw new Error("用戶名或密碼錯誤");
	}

	const user = users[0];

	// 檢查帳號狀態
	if (user.status !== "active") {
		throw new Error("帳號已被停用或暫停");
	}

	// 驗證密碼
	const isValidPassword = await verifyPassword(password, user.password_hash);
	if (!isValidPassword) {
		throw new Error("用戶名或密碼錯誤");
	}

	// 產生 Token
	const token = generateToken(user);

	// 回傳用戶資訊（不包含密碼）和 Token
	const userInfo = {
		id: user.id,
		username: user.username,
		email: user.email,
		role: user.role,
		status: user.status
	};

	return {
		user: userInfo,
		token
	};
}

// 取得用戶列表
async function getUsers(filters = {}) {
	const { role, status, limit, offset, orderBy, order } = filters;

	// 確保 limit 和 offset 是有效的整數
	const parsedLimit = limit !== undefined && limit !== null ? Math.max(1, Math.floor(Number(limit))) : 100;
	const parsedOffset = offset !== undefined && offset !== null ? Math.max(0, Math.floor(Number(offset))) : 0;

	// 構建查詢條件
	const { whereClause, params } = buildUserQueryConditions({ role, status });

	// 處理排序：預設按 created_at 降序（新到舊）
	const validOrderBy = ["id", "created_at", "username", "email"].includes(orderBy) ? orderBy : "created_at";
	const validOrder = order === "asc" || order === "desc" ? order : "desc";

	// 查詢用戶列表
	const query = `SELECT id, username, email, role, status, created_at, updated_at FROM users ${whereClause} ORDER BY ${validOrderBy} ${validOrder} LIMIT ${parsedLimit} OFFSET ${parsedOffset}`;
	const users = await db.query(query, params);

	// 取得總數
	const countQuery = `SELECT COUNT(*) as total FROM users ${whereClause}`;
	const countResult = await db.query(countQuery, params);
	const total = countResult[0].total;

	return {
		users,
		total,
		limit: parsedLimit,
		offset: parsedOffset
	};
}

// 取得單一用戶
async function getUserById(userId) {
	const users = await db.query("SELECT id, username, email, role, status, created_at, updated_at FROM users WHERE id = ?", [userId]);
	if (users.length === 0) {
		throw new Error("用戶不存在");
	}
	return users[0];
}

// 更新用戶
async function updateUser(userId, updateData, currentUser) {
	const { username, email, role, status } = updateData;

	// 檢查用戶是否存在
	const existingUser = await getUserById(userId);

	// 只有 admin 可以修改角色和狀態
	if ((role !== undefined || status !== undefined) && currentUser.role !== "admin") {
		throw new Error("只有管理員可以修改角色和狀態");
	}

	// 一般用戶只能修改自己的 username 和 email
	if (currentUser.role !== "admin" && currentUser.id !== userId) {
		throw new Error("只能修改自己的資料");
	}

	const updates = [];
	const params = [];

	if (username !== undefined) {
		// 檢查用戶名是否已被其他用戶使用
		const existing = await db.query("SELECT id FROM users WHERE username = ? AND id != ?", [username, userId]);
		if (existing.length > 0) {
			throw new Error("用戶名已被使用");
		}
		updates.push("username = ?");
		params.push(username);
	}

	if (email !== undefined) {
		// 驗證 email 格式
		validateEmail(email);
		// 檢查 email 是否已被其他用戶使用
		const existing = await db.query("SELECT id FROM users WHERE email = ? AND id != ?", [email, userId]);
		if (existing.length > 0) {
			throw new Error("email 已被使用");
		}
		updates.push("email = ?");
		params.push(email);
	}

	if (role !== undefined) {
		validateRole(role);
		updates.push("role = ?");
		params.push(role);
	}

	if (status !== undefined) {
		validateStatus(status);
		updates.push("status = ?");
		params.push(status);
	}

	if (updates.length === 0) {
		return await getUserById(userId);
	}

	params.push(userId);
	await db.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);

	return await getUserById(userId);
}

// 更新密碼
async function updatePassword(userId, oldPassword, newPassword, currentUser) {
	// 一般用戶只能修改自己的密碼
	if (currentUser.role !== "admin" && currentUser.id !== userId) {
		throw new Error("只能修改自己的密碼");
	}

	// 驗證新密碼長度
	if (newPassword.length < 6) {
		throw new Error("新密碼長度至少需要 6 個字元");
	}

	// 檢查用戶是否存在（需要包含 password_hash）
	const users = await db.query("SELECT * FROM users WHERE id = ?", [userId]);
	if (users.length === 0) {
		throw new Error("用戶不存在");
	}
	const user = users[0];

	// 如果不是 admin，需要驗證舊密碼
	if (currentUser.role !== "admin") {
		const isValidPassword = await verifyPassword(oldPassword, user.password_hash);
		if (!isValidPassword) {
			throw new Error("舊密碼不正確");
		}
	}

	// 雜湊新密碼
	const passwordHash = await hashPassword(newPassword);

	// 更新密碼
	await db.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, userId]);

	return { message: "密碼已更新" };
}

// 刪除用戶
async function deleteUser(userId, currentUser) {
	// 只有 admin 可以刪除用戶
	if (currentUser.role !== "admin") {
		throw new Error("只有管理員可以刪除用戶");
	}

	// 不能刪除自己
	if (currentUser.id === userId) {
		throw new Error("不能刪除自己的帳號");
	}

	// 檢查用戶是否存在
	await getUserById(userId);

	// 刪除用戶（外鍵約束會自動處理相關資料）
	await db.query("DELETE FROM users WHERE id = ?", [userId]);

	return { message: "用戶已刪除" };
}

module.exports = {
	registerUser,
	loginUser,
	getUsers,
	getUserById,
	updateUser,
	updatePassword,
	deleteUser,
	verifyToken,
	generateToken
};
