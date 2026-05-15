const express = require("express");
const router = express.Router();
const locationService = require("../services/systems/locationService");
const smokeAlarmStatusService = require("../services/systems/smokeAlarmStatusService");
const {
  authenticate,
  requireAdminOrOperator,
  requirePermission,
} = require("../middleware/authMiddleware");
const { noCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const systemAlert = require("../services/alerts/systemAlertHelper");
const C = require("../utils/apiErrorCodes");

// 以下路由皆需登入且具備系統權限
router.use(authenticate, requirePermission("system.smoke_alarm"));

router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await locationService.getZones({ locationType: "smoke_alarm" });
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.getZoneById(id, "smoke_alarm");
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
    const result = await smokeAlarmStatusService.getStatusSnapshot({
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
    const result = await smokeAlarmStatusService.getZoneStatusSnapshot(parseInt(id, 10), {
      syncAlerts,
    });
    res.sendSuccess(result);
  }),
);

router.post(
  "/systems/:systemId/errors",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    const message = String(req.body?.message ?? req.body?.error ?? "").trim();
    if (!message) {
      return res.sendFailure(
        {
          code: C.SMOKE_ALARM_MESSAGE_REQUIRED,
          message: "message 為必填",
          details: null,
        },
        400,
      );
    }
    await systemAlert.recordError("smoke_alarm", Number(systemId), message, {
      origin: { channel: "manual_error_api", actorUserId: req.user?.id ?? null },
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
        "smoke_alarm",
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

    await systemAlert.recordManualAlarm("smoke_alarm", Number(systemId), { origin });
    res.sendSuccess({ ok: true, mode: "manual" });
  }),
);

router.delete(
  "/systems/:systemId/errors",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    await systemAlert.clearError("smoke_alarm", Number(systemId), {
      origin: { channel: "manual_error_api", actorUserId: req.user?.id ?? null },
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
        "smoke_alarm",
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

    await systemAlert.clearManualAlarm("smoke_alarm", Number(systemId), { origin });
    res.sendSuccess({ ok: true, mode: "manual" });
  }),
);

module.exports = router;

