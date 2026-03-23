const express = require("express");
const router = express.Router();
const drainageService = require("../services/systems/drainageService");
const drainageStatusService = require("../services/systems/drainageStatusService");
const systemAlert = require("../services/alerts/systemAlertHelper");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

router.get("/zones", noCache, authenticate, asyncHandler(async (req, res) => {
  const result = await drainageService.getZones();
  res.sendSuccess(result);
}));

router.get("/zones/:id", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await drainageService.getZoneById(parseInt(id, 10));
  res.sendSuccess(result);
}));

router.post("/zones", authenticate, asyncHandler(async (req, res) => {
  const result = await drainageService.createZone(req.body, req.user.id);
  res.sendSuccess(result, 201);
}));

router.put("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await drainageService.updateZone(parseInt(id, 10), req.body, req.user.id);
  res.sendSuccess(result);
}));

router.delete("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await drainageService.deleteZone(parseInt(id, 10));
  res.sendSuccess(result);
}));

router.get("/status", noCache, authenticate, asyncHandler(async (req, res) => {
  let zoneIds;
  const raw = req.query.zoneIds;
  if (raw != null && raw !== "") {
    const parts = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    zoneIds = parts.map((p) => parseInt(p, 10)).filter((n) => !Number.isNaN(n));
  }
  const result = await drainageStatusService.getStatusSnapshot({ zoneIds });
  res.sendSuccess(result);
}));

router.get("/zones/:id/status", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await drainageStatusService.getZoneStatusSnapshot(parseInt(id, 10));
  res.sendSuccess(result);
}));

router.post("/systems/:systemId/errors", noCache, validateIntegers("systemId"), asyncHandler(async (req, res) => {
  const { systemId } = req.params;
  const { errorMessage } = req.body;

  const alertCreated = await systemAlert.recordError(
    "drainage",
    parseInt(systemId, 10),
    errorMessage || "無法讀取排水設備資料",
  );

  res.sendSuccess({ alertCreated });
}));

router.delete("/systems/:systemId/errors", noCache, validateIntegers("systemId"), asyncHandler(async (req, res) => {
  const { systemId } = req.params;

  await systemAlert.clearError("drainage", parseInt(systemId, 10));
  res.sendSuccess({ success: true });
}));

module.exports = router;
