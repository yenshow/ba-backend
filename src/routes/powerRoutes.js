const express = require("express");
const router = express.Router();
const powerService = require("../services/systems/powerService");
const powerStatusService = require("../services/systems/powerStatusService");
const { authenticate, requirePermission } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

// 以下路由皆需登入且具備系統權限
router.use(authenticate, requirePermission("system.power"));

router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await powerService.getZones();
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await powerService.getZoneById(parseInt(id, 10));
    res.sendSuccess(result);
  }),
);

router.post(
  "/zones",
  asyncHandler(async (req, res) => {
    const result = await powerService.createZone(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

router.put(
  "/zones/:id",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await powerService.updateZone(
      parseInt(id, 10),
      req.body,
      req.user.id,
    );
    res.sendSuccess(result);
  }),
);

router.delete(
  "/zones/:id",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await powerService.deleteZone(parseInt(id, 10));
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
    const result = await powerStatusService.getStatusSnapshot({
      zoneIds,
      syncAlerts: false,
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
    const result = await powerStatusService.getZoneStatusSnapshot(
      parseInt(id, 10),
      { syncAlerts: false },
    );
    res.sendSuccess(result);
  }),
);

module.exports = router;
