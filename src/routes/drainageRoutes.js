const express = require("express");
const router = express.Router();
const drainageStatusService = require("../services/snapshotStatus/drainageStatusService");
const locationService = require("../services/location/locationService");
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
router.use(authenticate, requirePermission("system.drainage"));

router.get(
  "/zones",
  noCache,
  asyncHandler(async (req, res) => {
    const result = await locationService.getZones({ locationType: "drainage" });
    res.sendSuccess(result);
  }),
);

router.get(
  "/zones/:id",
  noCache,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await locationService.getZoneById(id, "drainage");
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
    // UI 即時狀態查詢：預設純讀取不同步警報（警報由背景監控任務負責）
    // 允許帶 syncAlerts=true 強制併入 alerts（例如手動測試/操作後立即刷新）
    const syncAlerts = String(req.query.syncAlerts ?? "false") === "true";
    const result = await drainageStatusService.getStatusSnapshot({
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
    const result = await drainageStatusService.getZoneStatusSnapshot(
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
    await systemAlert.recordError(
      "drainage",
      Number(systemId),
      "手動警報測試",
      {
        origin: {
          channel: "manual_alert_api",
          actorUserId: req.user?.id ?? null,
        },
      },
    );
    res.sendSuccess({ ok: true });
  }),
);

router.post(
  "/systems/:systemId/alarms",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    const mode = String(req.body?.mode ?? "manual")
      .trim()
      .toLowerCase();
    const origin = {
      channel: "manual_alarm_api",
      actorUserId: req.user?.id ?? null,
    };

    if (mode === "rule") {
      const ruleAlertType = String(req.body?.rule?.alert_type ?? "")
        .trim()
        .toLowerCase();
      const bitKey = String(req.body?.rule?.bit_key ?? "").trim();
      const detail = await systemAlert.recordRuleBitStateAlarm(
        "drainage",
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

    await systemAlert.recordManualAlarm("drainage", Number(systemId), {
      origin,
    });
    res.sendSuccess({ ok: true, mode: "manual" });
  }),
);

router.delete(
  "/systems/:systemId/errors",
  validateIntegers("systemId"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { systemId } = req.params;
    await systemAlert.clearError("drainage", Number(systemId), {
      origin: {
        channel: "manual_alert_api",
        actorUserId: req.user?.id ?? null,
      },
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
    const mode = String(req.body?.mode ?? "manual")
      .trim()
      .toLowerCase();
    const origin = {
      channel: "manual_alarm_api",
      actorUserId: req.user?.id ?? null,
    };

    if (mode === "rule") {
      const ruleAlertType = String(req.body?.rule?.alert_type ?? "")
        .trim()
        .toLowerCase();
      const bitKey = String(req.body?.rule?.bit_key ?? "").trim();
      const detail = await systemAlert.clearRuleBitStateAlarm(
        "drainage",
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

    await systemAlert.clearManualAlarm("drainage", Number(systemId), {
      origin,
    });
    res.sendSuccess({ ok: true, mode: "manual" });
  }),
);

module.exports = router;
