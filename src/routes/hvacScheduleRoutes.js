/**
 * 空調時間排程 API：由 snapshotSystems 掛在同一 `/api/hvac` router 下
 */
const express = require("express");
const {
  authenticate,
  requirePermission,
  requireAnyPermission,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const hvacScheduleService = require("../services/hvac/hvacScheduleService");

const router = express.Router();

router.get(
  "/schedules",
  authenticate,
  requirePermission("system.hvac"),
  asyncHandler(async (_req, res) => {
    const rules = await hvacScheduleService.listAll();
    return res.sendSuccess({ rules });
  }),
);

router.put(
  "/schedules",
  authenticate,
  requireAnyPermission([
    "system.hvac.schedule.edit",
    "system.hvac.location.update",
  ]),
  asyncHandler(async (req, res) => {
    const rules = await hvacScheduleService.replaceAll(
      req.body?.rules ?? req.body,
    );
    return res.sendSuccess({ rules });
  }),
);

module.exports = router;
