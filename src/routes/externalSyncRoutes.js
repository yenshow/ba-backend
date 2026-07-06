const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const { validateRequired } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");
const externalSyncService = require("../services/externalIntegration/externalSyncService");
const { ACCESS_CONTROL_FIELD_CATALOG } = require("../services/externalIntegration/accessControlFields");

const router = express.Router();

router.use(authenticate, requireAdmin);

/**
 * GET /api/external-sync/configs?eventType=access_control
 */
router.get(
  "/configs",
  asyncHandler(async (req, res) => {
    const eventType = String(req.query?.eventType ?? "access_control").trim();
    if (eventType !== "access_control") {
      throwApiError(C.VALIDATION_CUSTOM, "目前僅支援 access_control", {
        statusCode: 400,
      });
    }
    const config = await externalSyncService.getConfig();
    res.sendSuccess({ config, fields: ACCESS_CONTROL_FIELD_CATALOG });
  }),
);

/**
 * PUT /api/external-sync/configs
 * body: { eventType, pushTime, dbType, host, port, database, username, password, targetTable, mappings }
 */
router.put(
  "/configs",
  validateRequired("eventType", "pushTime", "dbType", "host", "port", "database", "username", "password", "targetTable", "mappings"),
  asyncHandler(async (req, res) => {
    const eventType = String(req.body?.eventType ?? "").trim();
    if (eventType !== "access_control") {
      throwApiError(C.VALIDATION_CUSTOM, "目前僅支援 access_control", {
        statusCode: 400,
      });
    }
    const saved = await externalSyncService.upsertConfig(req.body || {});
    if (global.__externalSyncHandle?.reschedule) {
      global.__externalSyncHandle.reschedule();
    }
    res.sendSuccess({ id: saved.id });
  }),
);

/**
 * POST /api/external-sync/test-connection
 * body: { dbType, host, port, database, username, password }
 */
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

    await externalSyncService.testExternalDbConnection({ dbType, host, port: Math.trunc(port), database, username, password });
    res.sendSuccess({ ok: true });
  }),
);

module.exports = router;

