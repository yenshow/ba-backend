const express = require("express");
const router = express.Router();
const userService = require("../services/userService");
const { authenticate, requireAdmin, requireAdminOrOperator } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired, validateIntegers } = require("../middleware/validation");

// 公開路由：註冊
router.post("/register", validateRequired("username", "email", "password"), asyncHandler(async (req, res) => {
	const user = await userService.registerUser(req.body);
	res.sendSuccess({ user }, 201);
}));

// 公開路由：登入
router.post("/login", validateRequired("username", "password"), asyncHandler(async (req, res) => {
	const result = await userService.loginUser(req.body);
	res.sendSuccess(result);
}));

// 需要認證：取得當前用戶資訊
router.get("/me", authenticate, asyncHandler(async (req, res) => {
	const user = await userService.getUserById(req.user.id);
	res.sendSuccess({ user });
}));

// 需要管理員權限：取得用戶列表
router.get("/", authenticate, requireAdmin, asyncHandler(async (req, res) => {
	const { role, status, limit, offset, orderBy, order } = req.query;
	// 所有參數驗證和轉換由 service 層統一處理
	const result = await userService.getUsers({
		role,
		status,
		limit,
		offset,
		orderBy,
		order
	});
	res.sendSuccess(result);
}));

// 需要管理員權限：取得單一用戶
router.get("/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const user = await userService.getUserById(parseInt(req.params.id, 10));
	res.sendSuccess({ user });
}));

// 需要認證：更新用戶（用戶可以更新自己，管理員可以更新任何人）
router.put("/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
	const userId = parseInt(req.params.id, 10);
	const user = await userService.updateUser(userId, req.body, req.user);
	res.sendSuccess({ user });
}));

// 需要認證：更新密碼
router.put("/:id/password", authenticate, validateIntegers("id"), validateRequired("oldPassword", "newPassword"), asyncHandler(async (req, res) => {
	const userId = parseInt(req.params.id, 10);
	const { oldPassword, newPassword } = req.body;
	const result = await userService.updatePassword(userId, oldPassword, newPassword, req.user);
	res.sendSuccess(result);
}));

// 需要管理員權限：刪除用戶
router.delete("/:id", authenticate, requireAdmin, validateIntegers("id"), asyncHandler(async (req, res) => {
	const userId = parseInt(req.params.id, 10);
	const result = await userService.deleteUser(userId, req.user);
	res.sendSuccess(result);
}));

module.exports = router;

