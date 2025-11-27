const express = require("express");
const userService = require("../services/userService");
const { authenticate, requireAdmin, requireAdminOrOperator } = require("../middleware/authMiddleware");

const router = express.Router();

// 公開路由：註冊
router.post("/register", async (req, res, next) => {
	try {
		const user = await userService.registerUser(req.body);
		res.status(201).json({
			message: "用戶註冊成功",
			user
		});
	} catch (error) {
		next(error);
	}
});

// 公開路由：登入
router.post("/login", async (req, res, next) => {
	try {
		const result = await userService.loginUser(req.body);
		res.json({
			message: "登入成功",
			...result
		});
	} catch (error) {
		next(error);
	}
});

// 需要認證：取得當前用戶資訊
router.get("/me", authenticate, async (req, res, next) => {
	try {
		const user = await userService.getUserById(req.user.id);
		res.json(user);
	} catch (error) {
		next(error);
	}
});

// 需要管理員權限：取得用戶列表
router.get("/", authenticate, requireAdmin, async (req, res, next) => {
	try {
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
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 需要管理員權限：取得單一用戶
router.get("/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const user = await userService.getUserById(parseInt(req.params.id, 10));
		res.json(user);
	} catch (error) {
		next(error);
	}
});

// 需要認證：更新用戶（用戶可以更新自己，管理員可以更新任何人）
router.put("/:id", authenticate, async (req, res, next) => {
	try {
		const userId = parseInt(req.params.id, 10);
		const user = await userService.updateUser(userId, req.body, req.user);
		res.json({
			message: "用戶已更新",
			user
		});
	} catch (error) {
		next(error);
	}
});

// 需要認證：更新密碼
router.put("/:id/password", authenticate, async (req, res, next) => {
	try {
		const userId = parseInt(req.params.id, 10);
		const { oldPassword, newPassword } = req.body;
		const result = await userService.updatePassword(userId, oldPassword, newPassword, req.user);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

// 需要管理員權限：刪除用戶
router.delete("/:id", authenticate, requireAdmin, async (req, res, next) => {
	try {
		const userId = parseInt(req.params.id, 10);
		const result = await userService.deleteUser(userId, req.user);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

module.exports = router;

