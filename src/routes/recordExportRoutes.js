const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const { validateRequired, validateIntegers } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrorMeta");
const recordExportService = require("../services/externalIntegration/recordExportService");
const { ACCESS_CONTROL_FIELD_CATALOG } = require("../services/externalIntegration/accessControlFields");

const router = express.Router();

router.use(authenticate, requireAdmin);

/**
 * GET /api/record-export/rules?eventType=access_control
 */
router.get(
  "/rules",
  asyncHandler(async (req, res) => {
    const eventType = String(req.query?.eventType ?? "access_control").trim();
    if (eventType !== "access_control") {
      throwApiError(C.VALIDATION_CUSTOM, "目前僅支援 access_control", {
        statusCode: 400,
      });
    }
    const rules = await recordExportService.listRules();
    res.sendSuccess({ rules, fields: ACCESS_CONTROL_FIELD_CATALOG });
  }),
);

/**
 * POST /api/record-export/rules
 */
router.post(
  "/rules",
  validateRequired("name", "filenamePrefix", "dateFormat", "timeFormat", "exportTime", "storageType", "outputFormat", "groupIds", "fields"),
  asyncHandler(async (req, res) => {
    const saved = await recordExportService.upsertRule(null, req.body || {});
    if (global.__recordExportHandle?.reschedule) {
      global.__recordExportHandle.reschedule();
    }
    res.sendSuccess({ id: saved.id }, 201);
  }),
);

/**
 * PUT /api/record-export/rules/:id
 */
router.put(
  "/rules/:id",
  validateIntegers("id"),
  validateRequired("name", "filenamePrefix", "dateFormat", "timeFormat", "exportTime", "storageType", "outputFormat", "groupIds", "fields"),
  asyncHandler(async (req, res) => {
    const saved = await recordExportService.upsertRule(Number(req.params.id), req.body || {});
    if (global.__recordExportHandle?.reschedule) {
      global.__recordExportHandle.reschedule();
    }
    res.sendSuccess({ id: saved.id });
  }),
);

/**
 * DELETE /api/record-export/rules/:id
 */
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

