const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const { validateRequired, validateIntegers } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");
const recordExportService = require("../services/externalIntegration/recordExportService");
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
 * GET /api/record-export/rules?eventType=
 */
router.get(
  "/rules",
  asyncHandler(async (req, res) => {
    const raw = req.query?.eventType;
    let eventType = null;
    let fields = [];
    let filterSchema = null;
    if (raw != null && String(raw).trim() !== "") {
      eventType = String(raw).trim();
      if (!isValidEventType(eventType)) {
        throwApiError(C.VALIDATION_CUSTOM, "不支援的 eventType", { statusCode: 400 });
      }
      const adapter = getAdapter(eventType);
      fields = adapter.catalog;
      filterSchema = adapter.filterSchema;
    }
    const rules = await recordExportService.listRules(eventType || undefined);
    res.sendSuccess({
      rules,
      fields,
      filterSchema,
      eventTypes: listEventTypes(),
    });
  }),
);

router.post(
  "/rules",
  validateRequired(
    "name",
    "eventType",
    "filenamePrefix",
    "dateFormat",
    "timeFormat",
    "exportTime",
    "storageType",
    "outputFormat",
    "fields",
  ),
  asyncHandler(async (req, res) => {
    const saved = await recordExportService.upsertRule(null, req.body || {});
    if (global.__recordExportHandle?.reschedule) {
      global.__recordExportHandle.reschedule();
    }
    res.sendSuccess({ id: saved.id }, 201);
  }),
);

router.put(
  "/rules/:id",
  validateIntegers("id"),
  validateRequired(
    "name",
    "eventType",
    "filenamePrefix",
    "dateFormat",
    "timeFormat",
    "exportTime",
    "storageType",
    "outputFormat",
    "fields",
  ),
  asyncHandler(async (req, res) => {
    const saved = await recordExportService.upsertRule(
      Number(req.params.id),
      req.body || {},
    );
    if (global.__recordExportHandle?.reschedule) {
      global.__recordExportHandle.reschedule();
    }
    res.sendSuccess({ id: saved.id });
  }),
);

router.delete(
  "/rules/:id",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await recordExportService.deleteRule(Number(req.params.id));
    if (global.__recordExportHandle?.reschedule) {
      global.__recordExportHandle.reschedule();
    }
    res.sendSuccess({ ok: true });
  }),
);

module.exports = router;
