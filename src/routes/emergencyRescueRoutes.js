const express = require("express");
const router = express.Router();
const locationService = require("../services/location/locationService");
const emergencyRescueStatusService = require("../services/snapshotStatus/emergencyRescueStatusService");
const {
  authenticate,
  requireAdminOrOperator,
  requirePermission,
} = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const systemAlert = require("../services/alerts/systemAlertHelper");

// 以下路由皆需登入且具備系統權限
router.use(authenticate, requirePermission("system.emergency_rescue"));

router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await locationService.getZones({
      locationType: "emergency_rescue",
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
    const result = await locationService.getZoneById(id, "emergency_rescue");
    res.sendSuccess(result);
  }),
);

router.post(
  "/zones",
  asyncHandler(async (req, res) => {
    const result = await locationService.createZone(req.body, req.user.id);
    res.sendSuccess(result, 201);
  }),
);

router.put(
  "/zones/:id",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.updateZone(id, req.body, req.user.id);
    res.sendSuccess(result);
  }),
);

router.delete(
  "/zones/:id",
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
    const syncAlerts = String(req.query.syncAlerts ?? "false") === "true";
    const result = await emergencyRescueStatusService.getStatusSnapshot({
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
    const syncAlerts = String(req.query.syncAlerts ?? "false") === "true";
    const result = await emergencyRescueStatusService.getZoneStatusSnapshot(
      parseInt(id, 10),
      { syncAlerts },
    );
    res.sendSuccess(result);
  }),
);

router.post(
  "/systems/:systemId/errors",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    await systemAlert.recordError("emergency_rescue", Number(systemId), "手動警報測試", {
      origin: { channel: "manual_alert_api", actorUserId: req.user?.id ?? null },
    });
    res.sendSuccess({ ok: true });
  }),
);

router.post(
  "/systems/:systemId/alarms",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    const mode = String(req.body?.mode ?? "manual").trim().toLowerCase();
    const origin = { channel: "manual_alarm_api", actorUserId: req.user?.id ?? null };

    if (mode === "rule") {
      const ruleAlertType = String(req.body?.rule?.alert_type ?? "").trim().toLowerCase();
      const bitKey = String(req.body?.rule?.bit_key ?? "").trim();
      const detail = await systemAlert.recordRuleBitStateAlarm(
        "emergency_rescue",
        Number(systemId),
        {
          alertType: ruleAlertType,
          bitKey,
          origin,
        },
      );
      res.sendSuccess({ ok: true, mode: "rule", ...detail });
      return;
    }

    await systemAlert.recordManualAlarm("emergency_rescue", Number(systemId), { origin });
    res.sendSuccess({ ok: true, mode: "manual" });
  }),
);

router.delete(
  "/systems/:systemId/errors",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    await systemAlert.clearError("emergency_rescue", Number(systemId), {
      origin: { channel: "manual_alert_api", actorUserId: req.user?.id ?? null },
    });
    res.sendSuccess({ ok: true });
  }),
);

router.delete(
  "/systems/:systemId/alarms",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    const mode = String(req.body?.mode ?? "manual").trim().toLowerCase();
    const origin = { channel: "manual_alarm_api", actorUserId: req.user?.id ?? null };

    if (mode === "rule") {
      const ruleAlertType = String(req.body?.rule?.alert_type ?? "").trim().toLowerCase();
      const bitKey = String(req.body?.rule?.bit_key ?? "").trim();
      const detail = await systemAlert.clearRuleBitStateAlarm(
        "emergency_rescue",
        Number(systemId),
        {
          alertType: ruleAlertType,
          bitKey,
          origin,
        },
      );
      res.sendSuccess({ ok: true, mode: "rule", ...detail });
      return;
    }

    await systemAlert.clearManualAlarm("emergency_rescue", Number(systemId), { origin });
    res.sendSuccess({ ok: true, mode: "manual" });
  }),
);

module.exports = router;
