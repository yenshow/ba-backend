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

// 管理員或操作員：建立用戶；非 admin 須帶 overrides[]（手動勾選之頁面進入權限）
router.post(
  "/",
  authenticate,
  requireAdminOrOperator,
  validateRequired("username", "password"),
  asyncHandler(async (req, res) => {
    const result = await userService.createManagedUser(req.user, req.body);
    res.sendSuccess(result, 201);
  }),
);

// 管理員或操作員：權限定義清單（建立／編輯用戶時勾選模組）
router.get(
  "/permission-definitions",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const definitions = await permissionService.getDefinitions({ tree: false });
    res.sendSuccess({ definitions });
  }),
);

// 管理員或操作員：取得用戶已儲存之頁面進入權限（overridesByPermId）
router.get(
  "/:id/permissions",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const data = await permissionService.getUserPermissionOverrides(userId);
    res.sendSuccess(data);
  }),
);

// 管理員或操作員：寫入用戶頁面進入權限（全量 overrides，與 UI 勾選一致）
router.put(
  "/:id/permissions",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const overrides = Array.isArray(req.body.overrides) ? req.body.overrides : [];
    await permissionService.setUserPermissionOverrides(userId, overrides);
    res.sendSuccess({ message: "權限已更新" });
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
  validateRequired("newPassword"),
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
