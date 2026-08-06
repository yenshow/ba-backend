const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const { validateRequired } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");
const externalSyncService = require("../services/externalIntegration/externalSyncService");
const {
  getAdapter,
  isValidEventType,
  listEventTypes,
} = require("../services/externalIntegration/eventTypeRegistry");

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get(
  "/event-types",
  asyncHandler(async (_req, res) => {
    res.sendSuccess({ eventTypes: listEventTypes() });
  }),
);

/**
 * GET /api/external-sync/configs?eventType=
 * 無 eventType 時回傳全部 configs + eventTypes 目錄
 */
router.get(
  "/configs",
  asyncHandler(async (req, res) => {
    const raw = req.query?.eventType;
    if (raw == null || String(raw).trim() === "") {
      const configs = await externalSyncService.listConfigs();
      res.sendSuccess({ configs, eventTypes: listEventTypes() });
      return;
    }
    const eventType = String(raw).trim();
    if (!isValidEventType(eventType)) {
      throwApiError(C.VALIDATION_CUSTOM, "不支援的 eventType", { statusCode: 400 });
    }
    const adapter = getAdapter(eventType);
    const config = await externalSyncService.getConfig(eventType);
    res.sendSuccess({
      config,
      fields: adapter.catalog,
      filterSchema: adapter.filterSchema,
      eventTypes: listEventTypes(),
    });
  }),
);

router.put(
  "/configs",
  validateRequired(
    "eventType",
    "pushTime",
    "dbType",
    "host",
    "port",
    "database",
    "username",
    "targetTable",
    "mappings",
  ),
  asyncHandler(async (req, res) => {
    const eventType = String(req.body?.eventType ?? "").trim();
    if (!isValidEventType(eventType)) {
      throwApiError(C.VALIDATION_CUSTOM, "不支援的 eventType", { statusCode: 400 });
    }
    const saved = await externalSyncService.upsertConfig(req.body || {});
    if (global.__externalSyncHandle?.reschedule) {
      global.__externalSyncHandle.reschedule();
    }
    res.sendSuccess({ id: saved.id });
  }),
);

router.delete(
  "/configs/:eventType",
  asyncHandler(async (req, res) => {
    const eventType = String(req.params.eventType ?? "").trim();
    if (!isValidEventType(eventType)) {
      throwApiError(C.VALIDATION_CUSTOM, "不支援的 eventType", { statusCode: 400 });
    }
    await externalSyncService.deleteConfig(eventType);
    if (global.__externalSyncHandle?.reschedule) {
      global.__externalSyncHandle.reschedule();
    }
    res.sendSuccess({ ok: true });
  }),
);

router.post(
  "/test-connection",
  validateRequired("dbType", "host", "port", "database", "username", "password"),
  asyncHandler(async (req, res) => {
    const dbType = String(req.body?.dbType ?? "").trim().toLowerCase();
    const host = String(req.body?.host ?? "").trim();
    const port = Number(req.body?.port);
    const database = String(req.body?.database ?? "").trim();
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throwApiError(C.VALIDATION_CUSTOM, "Port 必須為 1–65535", { statusCode: 400 });
    }

    await externalSyncService.testExternalDbConnection({
      dbType,
      host,
      port: Math.trunc(port),
      database,
      username,
      password,
    });
    res.sendSuccess({ ok: true });
  }),
);

module.exports = router;
