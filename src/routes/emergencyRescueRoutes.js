const express = require("express");
const router = express.Router();
const emergencyRescueService = require("../services/systems/emergencyRescueService");
const emergencyRescueStatusService = require("../services/systems/emergencyRescueStatusService");
const { authenticate } = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

router.get("/zones", noCache, authenticate, asyncHandler(async (req, res) => {
  const result = await emergencyRescueService.getZones();
  res.sendSuccess(result);
}));

router.get("/zones/:id", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await emergencyRescueService.getZoneById(parseInt(id, 10));
  res.sendSuccess(result);
}));

router.post("/zones", authenticate, asyncHandler(async (req, res) => {
  const result = await emergencyRescueService.createZone(req.body, req.user.id);
  res.sendSuccess(result, 201);
}));

router.put("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await emergencyRescueService.updateZone(parseInt(id, 10), req.body, req.user.id);
  res.sendSuccess(result);
}));

router.delete("/zones/:id", authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await emergencyRescueService.deleteZone(parseInt(id, 10));
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
  const result = await emergencyRescueStatusService.getStatusSnapshot({ zoneIds, syncAlerts: false });
  res.sendSuccess(result);
}));

router.get("/zones/:id/status", noCache, authenticate, validateIntegers("id"), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await emergencyRescueStatusService.getZoneStatusSnapshot(parseInt(id, 10), { syncAlerts: false });
  res.sendSuccess(result);
}));

module.exports = router;
