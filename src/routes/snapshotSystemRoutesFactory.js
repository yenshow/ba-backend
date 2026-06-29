/**
 * 快照子系統路由工廠（lighting / hvac / drainage …）
 * 保留既有 URL 與權限字串；zones CRUD 委派 locationService。
 *
 * @see docs/30-contracts/api-surface.md「工地管理平台實際消費」
 */

const express = require("express");
const locationService = require("../services/location/locationService");
const {
  authenticate,
  requireAdmin,
  requirePermission,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const systemAlert = require("../services/alerts/systemAlertHelper");
const C = require("../utils/apiErrorCodes");
const {
  parseZoneIdsQuery,
} = require("../services/snapshotStatus/modbusSnapshotHelpers");

/**
 * @param {object} config
 * @param {string} config.permissionCode 例如 system.lighting
 * @param {string} config.locationType 例如 lighting、air_circulation
 * @param {string} config.alertSource 傳入 systemAlert.* 的來源鍵
 * @param {{ getStatusSnapshot: Function, getZoneStatusSnapshot: Function }} config.statusService
 * @param {number} [config.createZoneHttpStatus] POST /zones 成功狀態碼（預設 200）
 * @param {boolean} [config.manualErrorRequiresMessage=false] 煙霧警報：POST errors 需 body.message
 */
function createSnapshotSystemRouter(config) {
  const {
    permissionCode,
    locationType,
    alertSource,
    statusService,
    createZoneHttpStatus,
    manualErrorRequiresMessage = false,
  } = config;

  const router = express.Router();
  router.use(authenticate, requirePermission(permissionCode));

  const zoneCreateGuard = requirePermission(`${permissionCode}.location.create`);
  const zoneUpdateGuard = requirePermission(`${permissionCode}.location.update`);
  const zoneDeleteGuard = requirePermission(`${permissionCode}.location.delete`);

  router.get(
    "/zones",
    disableHttpCache,
    asyncHandler(async (req, res) => {
      const result = await locationService.getZones({ locationType });
      res.sendSuccess(result);
    }),
  );

  router.get(
    "/zones/:id",
    disableHttpCache,
    validateIntegers("id"),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const result = await locationService.getZoneById(id, locationType);
      res.sendSuccess(result);
    }),
  );

  router.post(
    "/zones",
    zoneCreateGuard,
    asyncHandler(async (req, res) => {
      const userId = req.user?.id ?? null;
      const result = await locationService.createZone(req.body, userId);
      if (createZoneHttpStatus === 201) {
        res.sendSuccess(result, 201);
      } else {
        res.sendSuccess(result);
      }
    }),
  );

  router.put(
    "/zones/:id",
    zoneUpdateGuard,
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
    zoneDeleteGuard,
    validateIntegers("id"),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const result = await locationService.deleteZone(id);
      res.sendSuccess(result);
    }),
  );

  router.get(
    "/status",
    disableHttpCache,
    asyncHandler(async (req, res) => {
      const zoneIds = parseZoneIdsQuery(req.query.zoneIds);
      const result = await statusService.getStatusSnapshot({
        zoneIds,
      });
      res.sendSuccess(result);
    }),
  );

  router.get(
    "/zones/:id/status",
    disableHttpCache,
    validateIntegers("id"),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const result = await statusService.getZoneStatusSnapshot(
        parseInt(id, 10),
        {},
      );
      res.sendSuccess(result);
    }),
  );

  const manualAlertOrigin = (req) => ({
    channel: "manual_alert_api",
    actorUserId: req.user?.id ?? null,
  });

  router.post(
    "/systems/:systemId/errors",
    validateIntegers("systemId"),
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { systemId } = req.params;
      if (manualErrorRequiresMessage) {
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
        await systemAlert.recordError(alertSource, Number(systemId), message, {
          origin: { channel: "manual_error_api", actorUserId: req.user?.id ?? null },
        });
      } else {
        await systemAlert.recordError(alertSource, Number(systemId), "手動警報測試", {
          origin: manualAlertOrigin(req),
        });
      }
      res.sendSuccess({ ok: true });
    }),
  );

  router.post(
    "/systems/:systemId/alarms",
    validateIntegers("systemId"),
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { systemId } = req.params;
      const mode = String(req.body?.mode ?? "manual").trim().toLowerCase();
      const origin = { channel: "manual_alarm_api", actorUserId: req.user?.id ?? null };

      if (mode === "rule") {
        const ruleAlertType = String(req.body?.rule?.alert_type ?? "")
          .trim()
          .toLowerCase();
        const bitKey = String(req.body?.rule?.bit_key ?? "").trim();
        const detail = await systemAlert.recordRuleBitStateAlarm(
          alertSource,
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

      await systemAlert.recordManualAlarm(alertSource, Number(systemId), { origin });
      res.sendSuccess({ ok: true, mode: "manual" });
    }),
  );

  router.delete(
    "/systems/:systemId/errors",
    validateIntegers("systemId"),
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { systemId } = req.params;
      const clearOrigin = manualErrorRequiresMessage
        ? { channel: "manual_error_api", actorUserId: req.user?.id ?? null }
        : manualAlertOrigin(req);
      await systemAlert.clearError(alertSource, Number(systemId), {
        origin: clearOrigin,
      });
      res.sendSuccess({ ok: true });
    }),
  );

  router.delete(
    "/systems/:systemId/alarms",
    validateIntegers("systemId"),
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { systemId } = req.params;
      const mode = String(req.body?.mode ?? "manual").trim().toLowerCase();
      const origin = { channel: "manual_alarm_api", actorUserId: req.user?.id ?? null };

      if (mode === "rule") {
        const ruleAlertType = String(req.body?.rule?.alert_type ?? "")
          .trim()
          .toLowerCase();
        const bitKey = String(req.body?.rule?.bit_key ?? "").trim();
        const detail = await systemAlert.clearRuleBitStateAlarm(
          alertSource,
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

      await systemAlert.clearManualAlarm(alertSource, Number(systemId), { origin });
      res.sendSuccess({ ok: true, mode: "manual" });
    }),
  );

  return router;
}

module.exports = { createSnapshotSystemRouter };
