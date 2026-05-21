const express = require("express");
const { authenticate, requireAdminOrOperator } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrorMeta");
const runtimeConfigService = require("../services/platform/runtimeConfigService");
const logger = require("../utils/logger");

const routeLogger = logger.createLogger("runtimeConfigRoutes");

const router = express.Router();

/** 表單區塊（供前端對齊 Central / Construction） */
const FORM_SCHEMA = {
  sections: [
    {
      title: "YSCP",
      fields: [
        { key: "YSCP_HOST", label: "主機", kind: "text" },
        { key: "YSCP_DB_PASSWORD", label: "資料庫密碼", kind: "password" },
        { key: "YSCP_AK", label: "存取金鑰（AK）", kind: "password" },
        { key: "YSCP_SK", label: "私密金鑰（SK）", kind: "password" },
      ],
    },
    {
      title: "警報日界線",
      fields: [
        { key: "ALERT_DAILY_ROLLOVER_TZ", label: "時區", kind: "text" },
        {
          key: "ALERT_DAILY_ROLLOVER_LOCAL_HOUR",
          label: "本地小時",
          kind: "number",
        },
        {
          key: "ALERT_DAILY_ROLLOVER_LOCAL_MINUTE",
          label: "本地分鐘",
          kind: "number",
        },
      ],
    },
    {
      title: "備份排程",
      fields: [
        {
          key: "BACKUP_ROOT_DIR",
          label: "備份目錄",
          kind: "text",
        },
        {
          key: "BACKUP_DATABASE_CUTOFF_DAYS",
          label: "線上資料保留天數",
          kind: "number",
        },
        {
          key: "BACKUP_ARCHIVE_FILE_RETENTION_DAYS",
          label: "備份檔保留天數",
          kind: "number",
        },
        {
          key: "BACKUP_SCHEDULER_INTERVAL",
          label: "排程間隔（毫秒）",
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
  requireAdminOrOperator,
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
  requireAdminOrOperator,
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
    await runtimeConfigService.applySideEffects(changedKeys);

    routeLogger.info("已更新 runtime 設定", {
      userId: req.user?.id,
      changedKeys,
    });

    res.sendSuccess({
      message: "已套用營運設定",
      applied: true,
      changedKeys,
    });
  }),
);

module.exports = router;
