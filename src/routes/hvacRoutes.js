const express = require("express");
const {
  authenticate,
  requireAdminOrOperator,
  requirePermission,
} = require("../middleware/authMiddleware");
const locationService = require("../services/systems/locationService");
const hvacStatusService = require("../services/systems/hvacStatusService");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

/**
 * HVAC 路由（對齊 /api/lighting|drainage 的獨立前綴）
 *
 * 註：本 repo 前端 HVAC 主要走 /api/locations 的統一 CRUD；
 *      此檔提供向後兼容與一致的 REST 入口，避免 server.js 掛載缺檔。
 */

const router = express.Router();
router.use(authenticate, requirePermission("system.hvac"));

router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await locationService.getZones({ locationType: "hvac" });
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.getZoneById(id, "hvac");
    res.sendSuccess(result);
  }),
);

router.post(
  "/zones",
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? null;
    const result = await locationService.createZone(req.body, userId);
    res.sendSuccess(result);
  }),
);

router.put(
  "/zones/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id ?? null;
    const result = await locationService.updateZone(id, req.body, userId);
    res.sendSuccess(result);
  }),
);

router.delete(
  "/zones/:id",
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.deleteZone(id);
    res.sendSuccess(result);
  }),
);

router.get(
  "/status",
  noCache,
  asyncHandler(async (req, res) => {
    let zoneIds;
    const raw = req.query.zoneIds;
    if (raw != null && raw !== "") {
      const parts = String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      zoneIds = parts
        .map((p) => parseInt(p, 10))
        .filter((n) => !Number.isNaN(n));
    }
    const syncAlerts = String(req.query.syncAlerts ?? "true") !== "false";
    const result = await hvacStatusService.getStatusSnapshot({
      zoneIds,
      syncAlerts,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id/status",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const syncAlerts = String(req.query.syncAlerts ?? "true") !== "false";
    const result = await hvacStatusService.getZoneStatusSnapshot(
      parseInt(id, 10),
      {
        syncAlerts,
      },
    );
    res.sendSuccess(result);
  }),
);

module.exports = router;
