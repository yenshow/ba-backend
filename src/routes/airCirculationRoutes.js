const express = require("express");
const {
  authenticate,
  requireAdminOrOperator,
  requirePermission,
} = require("../middleware/authMiddleware");
const locationService = require("../services/systems/locationService");
const airCirculationStatusService = require("../services/systems/airCirculationStatusService");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

const router = express.Router();

// 皆需登入（系統頁）
router.use(authenticate, requirePermission("system.air_circulation"));

// Zones CRUD（沿用統一 location/zones 模型，但對外暴露獨立前綴）
router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await locationService.getZones({
      locationType: "air_circulation",
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.getZoneById(id, "air_circulation");
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

// Status snapshot（模仿 drainage/power：後端讀取 statusPoints 合成 uiStatus）
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
    const result = await airCirculationStatusService.getStatusSnapshot({
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
    const result = await airCirculationStatusService.getZoneStatusSnapshot(
      parseInt(id, 10),
      { syncAlerts },
    );
    res.sendSuccess(result);
  }),
);

module.exports = router;
