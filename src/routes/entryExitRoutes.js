/**
 * 人流／車輛進出共用 API（營運日時間範圍）
 */
const express = require("express");
const { authenticate } = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const {
  getOperationalDayRangeResponse,
  ENTRY_EXIT_MAX_RECORDS,
} = require("../services/entryExit/resolveTimeOptions");

const router = express.Router();

router.use(authenticate);

/**
 * GET /api/entry-exit/time-range?preset=today|yesterday|last7days|last_7_days
 */
router.get(
  "/time-range",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const preset = req.query.preset || "today";
    res.sendSuccess({
      ...getOperationalDayRangeResponse(preset),
      maxRecords: ENTRY_EXIT_MAX_RECORDS,
    });
  }),
);

module.exports = router;
