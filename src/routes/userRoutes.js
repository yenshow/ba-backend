const express = require("express");
const router = express.Router();
const userService = require("../services/platform/userService");
const permissionService = require("../access/permissionService");
const {
  authenticate,
  requireAdmin,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const websocketService = require("../services/websocket/websocketService");
const {
  loginRateLimiter,
} = require("../middleware/rateLimitMiddleware");
const {
  validateRequired,
  validateIntegers,
} = require("../middleware/validation");

router.post(
  "/login",
  loginRateLimiter,
  validateRequired("username", "password"),
  asyncHandler(async (req, res) => {
    const result = await userService.loginUser(req.body);
    res.sendSuccess(result);
  }),
);

router.post(
  "/logout",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await userService.logoutUser(req.user.id);
    res.sendSuccess(result);
  }),
);

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

router.get(
  "/",
  authenticate,
  requireAdmin,
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

router.post(
  "/",
  authenticate,
  requireAdmin,
  validateRequired("username", "password"),
  asyncHandler(async (req, res) => {
    const result = await userService.createManagedUser(req.user, req.body);
    res.sendSuccess(result, 201);
  }),
);

router.get(
  "/permission-definitions",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const definitions = await permissionService.getDefinitions();
    res.sendSuccess({ definitions });
  }),
);

router.get(
  "/:id/permissions",
  authenticate,
  requireAdmin,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const data = await permissionService.getUserPermissionOverrides(userId);
    res.sendSuccess(data);
  }),
);

router.put(
  "/:id/permissions",
  authenticate,
  requireAdmin,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const overrides = Array.isArray(req.body.overrides) ? req.body.overrides : [];
    const sanitized = await permissionService.sanitizeOverrides(overrides);
    await permissionService.setUserPermissionOverrides(userId, sanitized);
    websocketService.emitPermissionsUpdated(userId);
    res.sendSuccess({ message: "權限已更新" });
  }),
);

router.get(
  "/:id",
  authenticate,
  requireAdmin,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const user = await userService.getUserById(parseInt(req.params.id, 10));
    res.sendSuccess({ user });
  }),
);

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

router.delete(
  "/:id",
  authenticate,
  requireAdmin,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const result = await userService.deleteUser(userId, req.user);
    res.sendSuccess(result);
  }),
);

module.exports = router;
