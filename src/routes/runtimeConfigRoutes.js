const express = require("express");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrorMeta");
const runtimeConfigService = require("../services/platform/runtimeConfigService");
const logger = require("../utils/logger");

const routeLogger = logger.createLogger("runtimeConfigRoutes");

const router = express.Router();

const FORM_SCHEMA = {
  sections: [
    {
      title: "備份排程",
      fields: [
        {
          key: "BACKUP_ROOT_DIR",
          label: "備份目錄",
          kind: "text",
        },
        {
          key: "BACKUP_ARCHIVE_AFTER_DAYS",
          label: "逾此天數寫入備份檔",
          kind: "number",
        },
        {
          key: "BACKUP_ONLINE_RETENTION_DAYS",
          label: "線上資料保留天數",
          kind: "number",
        },
      ],
    },
  ],
};

/**
 * GET /api/runtime-config
 */
router.get(
  "/",
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await runtimeConfigService.init();
    res.sendSuccess({
      schema: FORM_SCHEMA,
      values: runtimeConfigService.getValues(),
    });
  }),
);

/**
 * PUT /api/runtime-config
 * Body: { values: Record<string, string> }
 */
router.put(
  "/",
  authenticate,
  requireAdmin,
  validateRequired("values"),
  asyncHandler(async (req, res) => {
    const { values } = req.body;
    if (
      typeof values !== "object" ||
      values === null ||
      Array.isArray(values)
    ) {
      throwApiError(C.VALIDATION_CUSTOM, "values 必須為物件", {
        statusCode: 400,
      });
    }

    await runtimeConfigService.init();
    const { changedKeys } = await runtimeConfigService.updateBatch(values);
    if (changedKeys.length > 0) {
      await runtimeConfigService.applySideEffects(changedKeys);
    }

    routeLogger.info("已更新 runtime 設定", {
      userId: req.user?.id,
      changedKeys,
    });

    const applied = changedKeys.length > 0;
    res.sendSuccess({
      message: applied ? "已套用營運設定" : "設定未變更",
      applied,
      changedKeys,
    });
  }),
);

module.exports = router;
