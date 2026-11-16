/**
 * 照明時間排程 API：由 snapshotSystems 掛在同一 `/api/lighting` router 下
 */
const express = require("express");
const {
  authenticate,
  requirePermission,
  requireAnyPermission,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const lightingScheduleService = require("../services/lighting/lightingScheduleService");

const router = express.Router();

router.get(
  "/schedules",
  authenticate,
  requirePermission("system.lighting"),
  asyncHandler(async (_req, res) => {
    const rules = await lightingScheduleService.listAll();
    return res.sendSuccess({ rules });
  }),
);

router.put(
  "/schedules",
  authenticate,
  requireAnyPermission([
    "system.lighting.schedule.edit",
    "system.lighting.location.update",
  ]),
  asyncHandler(async (req, res) => {
    const rules = await lightingScheduleService.replaceAll(
      req.body?.rules ?? req.body,
    );
    return res.sendSuccess({ rules });
  }),
);

module.exports = router;
