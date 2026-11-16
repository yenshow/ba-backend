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
  "/locations/:locationId/schedules",
  authenticate,
  requirePermission("system.security"),
  asyncHandler(async (req, res) => {
    const rules = await securityScheduleService.listByLocationId(
      req.params.locationId,
    );
    return res.sendSuccess({ rules });
  }),
);

router.put(
  "/locations/:locationId/schedules",
  authenticate,
  requireAnyPermission([
    "system.security.schedule.edit",
    "system.security.location.update",
  ]),
  asyncHandler(async (req, res) => {
    const rules = await securityScheduleService.replaceForLocation(
      req.params.locationId,
      req.body?.rules ?? req.body,
    );
    return res.sendSuccess({ rules });
  }),
);

module.exports = router;
