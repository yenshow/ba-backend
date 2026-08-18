/**
 * 營運事件 API（無 License feature；Permission system.operational_log）
 * 匯出由前端以列表 limit≥500 + report.export（比照警示紀錄）
 */
const express = require("express");
const router = express.Router();
const operationalEventService = require("../services/operationalEvents/operationalEventService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");

const EXPORT_BULK_LIMIT_THRESHOLD = 500;

const requireOperationalExportIfBulk = () => async (req, res, next) => {
  const raw = req.query.limit;
  if (raw == null || raw === "") return next();
  const limit = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit < EXPORT_BULK_LIMIT_THRESHOLD) {
    return next();
  }
  return requirePermission("system.operational_log.report.export")(
    req,
    res,
    next,
  );
};

router.use(authenticate);
router.use(requirePermission("system.operational_log"));

router.get(
  "/",
  requireOperationalExportIfBulk(),
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const { source, event_kind, start_date, end_date, location_id, limit, offset } =
      req.query;

    const result = await operationalEventService.listEvents({
      source,
      event_kind,
      start_date,
      end_date,
      location_id,
      limit: limit != null ? Number.parseInt(String(limit), 10) : undefined,
      offset: offset != null ? Number.parseInt(String(offset), 10) : undefined,
    });

    res.sendSuccess(result);
  }),
);

module.exports = router;
