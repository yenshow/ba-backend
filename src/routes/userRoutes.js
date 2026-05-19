const express = require("express");
const router = express.Router();
const userService = require("../services/platform/userService");
const permissionService = require("../services/platform/permissionService");
const {
  authenticate,
  requireAdmin,
  requireAdminOrOperator,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const {
  validateRequired,
  validateIntegers,
} = require("../middleware/validation");

// 公開路由：註冊（無 email；登入僅以用戶名辨識）
router.post(
  "/register",
  validateRequired("username", "password"),
  asyncHandler(async (req, res) => {
    const user = await userService.registerUser(req.body);
    res.sendSuccess({ user }, 201);
  }),
);

// 公開路由：登入
router.post(
  "/login",
  validateRequired("username", "password"),
  asyncHandler(async (req, res) => {
    const result = await userService.loginUser(req.body);
    res.sendSuccess(result);
  }),
);

// 需要認證：取得當前用戶資訊（含有效權限 permissions）
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await userService.getUserById(req.user.id);
    const { codes: permissions } =
      await permissionService.getEffectivePermissionsForUser(
        req.user.id,
        user.role,
      );
    res.sendSuccess({ user: { ...user, permissions } });
  }),
);

// 管理員或操作員：取得用戶列表
router.get(
  "/",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { role, status, limit, offset, orderBy, order } = req.query;
    const result = await userService.getUsers({
      role,
      status,
      limit,
      offset,
      orderBy,
      order,
    });
    res.sendSuccess(result);
  }),
);

// 管理員或操作員：取得／寫入某用戶的權限設定
router.get(
  "/:id/permissions",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const settings = await permissionService.getUserPermissionSettings(userId);
    res.sendSuccess(settings);
  }),
);

router.put(
  "/:id/permissions",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const overrides = Array.isArray(req.body.overrides)
      ? req.body.overrides
      : [];
    await permissionService.setUserPermissionOverrides(userId, overrides);
    const settings = await permissionService.getUserPermissionSettings(userId);
    res.sendSuccess(settings);
  }),
);

// 管理員或操作員：取得單一用戶
router.get(
  "/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const user = await userService.getUserById(parseInt(req.params.id, 10));
    res.sendSuccess({ user });
  }),
);

// 需要認證：更新用戶（用戶可更新自己；管理員或操作員可更新任何人）
router.put(
  "/:id",
  authenticate,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const user = await userService.updateUser(userId, req.body, req.user);
    res.sendSuccess({ user });
  }),
);

// 需要認證：更新密碼
router.put(
  "/:id/password",
  authenticate,
  validateIntegers("id"),
  validateRequired("oldPassword", "newPassword"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { oldPassword, newPassword } = req.body;
    const result = await userService.updatePassword(
      userId,
      oldPassword,
      newPassword,
      req.user,
    );
    res.sendSuccess(result);
  }),
);

// 管理員或操作員：刪除用戶
router.delete(
  "/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const result = await userService.deleteUser(userId, req.user);
    res.sendSuccess(result);
  }),
);

module.exports = router;
