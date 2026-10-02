const express = require("express");
const router = express.Router();
const rollCallService = require("../services/rollCall/rollCallService");
const {
  authenticate,
  requirePermission,
} = require("../middleware/authMiddleware");
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");

router.use(authenticate, requirePermission("system.roll_call"));

router.get(
  "/rules",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const locationId = req.query.locationId
      ? Number(req.query.locationId)
      : null;
    const rules = await rollCallService.listRules(
      Number.isFinite(locationId) && locationId > 0 ? locationId : null,
    );
    res.sendSuccess({ rules });
  }),
);

router.post(
  "/rules",
  requirePermission("system.roll_call.rule.edit"),
  asyncHandler(async (req, res) => {
    const rule = await rollCallService.createRule(req.body || {});
    res.sendSuccess({ rule });
  }),
);

router.put(
  "/rules/:id",
  requirePermission("system.roll_call.rule.edit"),
  asyncHandler(async (req, res) => {
    const rule = await rollCallService.updateRule(
      Number(req.params.id),
      req.body || {},
    );
    res.sendSuccess({ rule });
  }),
);

router.put(
  "/locations/:locationId/rules",
  requirePermission("system.roll_call.rule.edit"),
  asyncHandler(async (req, res) => {
    const rules = await rollCallService.replaceLocationRules(
      Number(req.params.locationId),
      req.body?.rules,
    );
    res.sendSuccess({ rules });
  }),
);

router.delete(
  "/rules/:id",
  requirePermission("system.roll_call.rule.edit"),
  asyncHandler(async (req, res) => {
    const result = await rollCallService.deleteRule(Number(req.params.id));
    res.sendSuccess(result);
  }),
);

router.get(
  "/today",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const today = await rollCallService.getToday();
    res.sendSuccess(today);
  }),
);

router.post(
  "/locations/:locationId/reset",
  requirePermission("system.roll_call.statistics.reset"),
  asyncHandler(async (req, res) => {
    const result = await rollCallService.resetLocationToday(
      Number(req.params.locationId),
    );
    res.sendSuccess(result);
  }),
);

router.get(
  "/history",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const history = await rollCallService.getHistory({
      limit: req.query.limit,
      offset: req.query.offset,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      locationId: req.query.locationId,
    });
    res.sendSuccess(history);
  }),
);

router.get(
  "/report",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const report = await rollCallService.getReport({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      locationId: req.query.locationId,
    });
    res.sendSuccess(report);
  }),
);

router.get(
  "/sessions/:id",
  disableHttpCache,
  asyncHandler(async (req, res) => {
    const session = await rollCallService.getSession(Number(req.params.id));
    res.sendSuccess({ session });
  }),
);

router.put(
  "/sessions/:id/attendance/:personId",
  requirePermission("system.roll_call.attendance.mark"),
  asyncHandler(async (req, res) => {
    const session = await rollCallService.markAttendance(
      Number(req.params.id),
      Number(req.params.personId),
      req.body?.status,
    );
    res.sendSuccess({ session });
  }),
);

module.exports = router;
