/**
 * 保全時段 API：由 snapshotSystems 掛在同一 `/api/security` router 下
 */
const express = require("express");
const {
  authenticate,
  requirePermission,
  requireAnyPermission,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const securityScheduleService = require("../services/security/securityScheduleService");

const router = express.Router();

router.get(
  "/schedules",
  authenticate,
  requirePermission("system.security"),
  asyncHandler(async (_req, res) => {
    const rules = await securityScheduleService.listAll();
    return res.sendSuccess({ rules });
  }),
);

router.put(
  "/schedules",
  authenticate,
  requireAnyPermission([
    "system.security.schedule.edit",
    "system.security.location.update",
  ]),
  asyncHandler(async (req, res) => {
    const rules = await securityScheduleService.replaceAll(
      req.body?.rules ?? req.body,
    );
    return res.sendSuccess({ rules });
  }),
);

module.exports = router;
