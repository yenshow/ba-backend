const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../../database/db");
const config = require("../../config");
const permissionService = require("../../access/permissionService");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

async function hashPassword(password) {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

function generateToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    tokenVersion: Number(user.token_version) || 0,
  };
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (error) {
    return null;
  }
}

async function getUserTokenVersion(userId) {
  const rows = await db.query(
    "SELECT token_version FROM users WHERE id = ?",
    [userId],
  );
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0].token_version) || 0;
}

/**
 * 驗證 JWT 內 tokenVersion 是否與 DB 一致
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
async function verifyTokenVersion(decoded) {
  if (!decoded?.id) {
    return {
      ok: false,
      code: C.AUTH_TOKEN_INVALID,
      message: "無效的 Token",
    };
  }
  const dbVersion = await getUserTokenVersion(decoded.id);
  if (dbVersion === null) {
    return {
      ok: false,
      code: C.AUTH_TOKEN_INVALID,
      message: "無效的 Token",
    };
  }
  const tokenVersion =
    decoded.tokenVersion !== undefined && decoded.tokenVersion !== null
      ? Number(decoded.tokenVersion)
      : 0;
  if (tokenVersion !== dbVersion) {
    return {
      ok: false,
      code: C.AUTH_TOKEN_REVOKED,
      message: "登入已失效，請重新登入",
    };
  }
  return { ok: true };
}

async function revokeUserTokens(userId) {
  await db.query(
    "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
    [userId],
  );
}

async function logoutUser(userId) {
  await revokeUserTokens(userId);
  return { message: "已登出" };
}

function validateRole(role) {
  const validRoles = ["admin", "user"];
  if (!validRoles.includes(role)) {
    throwApiError(C.USER_ROLE_INVALID, "角色必須為 admin 或 user");
  }
}

function validateStatus(status) {
  const validStatuses = ["active", "inactive"];
  if (!validStatuses.includes(status)) {
    throwApiError(C.USER_STATUS_INVALID, "狀態必須為 active 或 inactive");
  }
}

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

/** 僅安裝腳本用：建立首位 admin（無 HTTP 端點；role 固定 admin） */
async function createBootstrapAdminUser({ username, password }) {
  if (!username || !password) {
    throwApiError(C.USER_CREDENTIALS_REQUIRED, "username、password 為必填欄位");
  }
  if (password.length < 6) {
    throwApiError(C.USER_PASSWORD_TOO_SHORT, "密碼長度至少需要 6 個字元");
  }

  const existingUser = await db.query("SELECT id FROM users WHERE username = ?", [
    username,
  ]);
  if (existingUser.length > 0) {
    throwApiError(C.USER_USERNAME_EXISTS, "用戶名已存在");
  }

  const passwordHash = await hashPassword(password);
  const result = await db.query(
    "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'admin', 'active') RETURNING id",
    [username, passwordHash],
  );
  const user = await db.query(
    "SELECT id, username, role, status, created_at, updated_at FROM users WHERE id = ?",
    [result[0].id],
  );
  return user[0];
}

async function loginUser(credentials) {
  const { username, password } = credentials;

  if (!username || !password) {
    throwApiError(C.USER_CREDENTIALS_REQUIRED, "username 和 password 為必填欄位");
  }

  const users = await db.query("SELECT * FROM users WHERE username = ?", [
    username,
  ]);
  if (users.length === 0) {
    throwApiError(C.USER_AUTH_FAILED, "用戶名或密碼錯誤");
  }

  const user = users[0];
  if (user.status !== "active") {
    throwApiError(C.USER_AUTH_FAILED, "用戶名或密碼錯誤");
  }

  const isValidPassword = await verifyPassword(password, user.password_hash);
  if (!isValidPassword) {
    throwApiError(C.USER_AUTH_FAILED, "用戶名或密碼錯誤");
  }

  const token = generateToken(user);
  const { codes: permissions } =
    await permissionService.getEffectivePermissionsForUser(user.id, user.role);
  const userInfo = {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    permissions,
  };

  return { user: userInfo, token };
}

async function getUsers(filters = {}) {
  const { role, status, limit, offset, orderBy, order } = filters;

  const parsedLimit =
    limit !== undefined && limit !== null
      ? Math.max(1, Math.floor(Number(limit)))
      : 100;
  const parsedOffset =
    offset !== undefined && offset !== null
      ? Math.max(0, Math.floor(Number(offset)))
      : 0;

  const { whereClause, params } = buildUserQueryConditions({ role, status });
  const validOrderBy = ["id", "created_at", "username"].includes(orderBy)
    ? orderBy
    : "created_at";
  const validOrder = order === "asc" || order === "desc" ? order : "desc";

  const query = `SELECT id, username, role, status, created_at, updated_at FROM users ${whereClause} ORDER BY ${validOrderBy} ${validOrder} LIMIT ${parsedLimit} OFFSET ${parsedOffset}`;
  const users = await db.query(query, params);
  const total = (
    await db.query(`SELECT COUNT(*) as total FROM users ${whereClause}`, params)
  )[0].total;

  return { users, total, limit: parsedLimit, offset: parsedOffset };
}

async function getUserById(userId) {
  const users = await db.query(
    "SELECT id, username, role, status, created_at, updated_at FROM users WHERE id = ?",
    [userId],
  );
  if (users.length === 0) {
    throwApiError(C.USER_NOT_FOUND, "用戶不存在");
  }
  return users[0];
}

async function createManagedUser(creator, body) {
  const { username, password, role = "user", overrides = [] } = body;

  if (!username || !password) {
    throwApiError(C.USER_CREDENTIALS_REQUIRED, "username、password 為必填欄位");
  }
  if (password.length < 6) {
    throwApiError(C.USER_PASSWORD_TOO_SHORT, "密碼長度至少需要 6 個字元");
  }
  validateRole(role);

  if (creator.role !== "admin") {
    throwApiError(C.USER_FORBIDDEN_ROLE_STATUS, "只有管理員可以建立用戶");
  }

  const existingUser = await db.query("SELECT id FROM users WHERE username = ?", [
    username,
  ]);
  if (existingUser.length > 0) {
    throwApiError(C.USER_USERNAME_EXISTS, "用戶名已存在");
  }

  const passwordHash = await hashPassword(password);
  const userId = await db.transaction(async (clientQuery) => {
    const result = await clientQuery(
      "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, 'active') RETURNING id",
      [username, passwordHash, role],
    );
    const id = result[0].id;
    if (role !== "admin" && Array.isArray(overrides)) {
      const sanitized = await permissionService.sanitizeOverrides(overrides);
      await permissionService.replaceUserPermissionOverrides(
        id,
        sanitized,
        clientQuery,
      );
    }
    return id;
  });
  const user = await getUserById(userId);
  return { user };
}

async function updateUser(userId, updateData, currentUser) {
  const { username, role, status } = updateData;

  const existingRows = await db.query("SELECT id, role FROM users WHERE id = ?", [
    userId,
  ]);
  if (existingRows.length === 0) {
    throwApiError(C.USER_NOT_FOUND, "用戶不存在");
  }
  const previousRole = existingRows[0].role;

  if (currentUser.role !== "admin") {
    throwApiError(C.USER_FORBIDDEN_ROLE_STATUS, "只有管理員可以修改用戶資料");
  }

  const updates = [];
  const params = [];

  if (username !== undefined) {
    const existing = await db.query(
      "SELECT id FROM users WHERE username = ? AND id != ?",
      [username, userId],
    );
    if (existing.length > 0) {
      throwApiError(C.USER_USERNAME_TAKEN, "用戶名已被使用");
    }
    updates.push("username = ?");
    params.push(username);
  }

  if (role !== undefined) {
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

  if (role !== undefined && role !== previousRole) {
    await permissionService.clearUserPermissionOverrides(userId);
    permissionService.invalidateUserPermissionCache(userId);
  }

  return await getUserById(userId);
}

function assertPasswordChangeAllowed(currentUser, targetUser) {
  const isSelf = currentUser.id === targetUser.id;

  if (isSelf) {
    if (currentUser.role === "admin") {
      throwApiError(
        C.USER_FORBIDDEN_PASSWORD_SELF,
        "管理員無法自行變更密碼，請由其他管理員於用戶管理重設",
      );
    }
    return { requireOldPassword: true };
  }

  if (currentUser.role === "admin") {
    if (targetUser.role === "admin") {
      throwApiError(
        C.USER_FORBIDDEN_PASSWORD_TARGET,
        "無法重設其他管理員密碼",
      );
    }
    return { requireOldPassword: false };
  }

  throwApiError(C.USER_FORBIDDEN_PASSWORD_OTHERS, "只能修改自己的密碼");
}

async function updatePassword(userId, oldPassword, newPassword, currentUser) {
  if (!newPassword || typeof newPassword !== "string") {
    throwApiError(C.USER_CREDENTIALS_REQUIRED, "newPassword 為必填欄位");
  }
  if (newPassword.length < 6) {
    throwApiError(C.USER_PASSWORD_TOO_SHORT, "新密碼長度至少需要 6 個字元");
  }

  const users = await db.query("SELECT * FROM users WHERE id = ?", [userId]);
  if (users.length === 0) {
    throwApiError(C.USER_NOT_FOUND, "用戶不存在");
  }
  const targetUser = users[0];

  const { requireOldPassword } = assertPasswordChangeAllowed(
    currentUser,
    targetUser,
  );

  if (requireOldPassword) {
    if (!oldPassword || typeof oldPassword !== "string" || !oldPassword.trim()) {
      throwApiError(C.USER_OLD_PASSWORD_REQUIRED, "請提供舊密碼");
    }
    const isValidPassword = await verifyPassword(
      oldPassword,
      targetUser.password_hash,
    );
    if (!isValidPassword) {
      throwApiError(C.USER_OLD_PASSWORD_INVALID, "舊密碼不正確");
    }
  }

  const passwordHash = await hashPassword(newPassword);
  await db.query("UPDATE users SET password_hash = ? WHERE id = ?", [
    passwordHash,
    userId,
  ]);
  await revokeUserTokens(userId);

  return { message: "密碼已更新" };
}

async function deleteUser(userId, currentUser) {
  if (currentUser.role !== "admin") {
    throwApiError(C.USER_FORBIDDEN_DELETE, "只有管理員可以刪除用戶");
  }

  if (currentUser.id === userId) {
    throwApiError(C.USER_FORBIDDEN_DELETE_SELF, "不能刪除自己的帳號");
  }

  const existing = await db.query("SELECT id, role FROM users WHERE id = ?", [
    userId,
  ]);
  if (existing.length === 0) {
    throwApiError(C.USER_NOT_FOUND, "用戶不存在");
  }

  await db.query("DELETE FROM users WHERE id = ?", [userId]);

  return { message: "用戶已刪除" };
}

module.exports = {
  createBootstrapAdminUser,
  createManagedUser,
  loginUser,
  getUsers,
  getUserById,
  updateUser,
  updatePassword,
  deleteUser,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  verifyTokenVersion,
  revokeUserTokens,
  logoutUser,
  getUserTokenVersion,
};
