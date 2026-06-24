const express = require("express");
const { authenticate, requireAdmin } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateRequired } = require("../middleware/validation");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrorMeta");
const runtimeConfigService = require("../services/platform/runtimeConfigService");
const { isDatabaseEnabled } = require("../utils/yscpSystemFeature");
const logger = require("../utils/logger");

const routeLogger = logger.createLogger("runtimeConfigRoutes");

const router = express.Router();

const BASE_FORM_SCHEMA = {
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
      title: "警報日界線（亦為人流／車輛進出營運日）",
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

const buildFormSchema = () => {
  if (isDatabaseEnabled()) {
    return BASE_FORM_SCHEMA;
  }
  return {
    sections: BASE_FORM_SCHEMA.sections.filter((s) => s.title !== "YSCP"),
  };
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
      schema: buildFormSchema(),
      values: runtimeConfigService.getValuesForClient(),
      capabilities: {
        yscpDatabase: isDatabaseEnabled(),
      },
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
    const sideEffects =
      changedKeys.length > 0
        ? await runtimeConfigService.applySideEffects(changedKeys)
        : {};

    routeLogger.info("已更新 runtime 設定", {
      userId: req.user?.id,
      changedKeys,
    });

    const applied = changedKeys.length > 0;
    res.sendSuccess({
      message: applied ? "已套用營運設定" : "設定未變更",
      applied,
      changedKeys,
      sideEffects,
      capabilities: {
        yscpDatabase: isDatabaseEnabled(),
      },
    });
  }),
);

module.exports = router;
