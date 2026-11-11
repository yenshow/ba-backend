const express = require("express");
const multer = require("multer");
const router = express.Router();
const rollCallService = require("../services/rollCall/rollCallService");
const rollCallAssignmentService = require("../services/rollCall/rollCallAssignmentService");
const rollCallAssignmentImportService = require("../services/rollCall/rollCallAssignmentImportService");
const {
  authenticate,
  requirePermission,
  requireAnyPermission,
} = require("../middleware/authMiddleware");

const requireAssignmentRead = requireAnyPermission([
  "system.roll_call.assignment.view",
  "system.roll_call.assignment.edit",
]);
const { disableHttpCache } = require("../middleware/common");
const asyncHandler = require("../utils/asyncHandler");
const C = require("../utils/apiErrorCodes");
const { throwApiError } = require("../utils/apiErrors");

const assignmentUpload = multer({ storage: multer.memoryStorage() });

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
  requirePermission("system.roll_call.location.update"),
  asyncHandler(async (req, res) => {
    const rule = await rollCallService.createRule(req.body || {});
    res.sendSuccess({ rule });
  }),
);

router.put(
  "/rules/:id",
  requirePermission("system.roll_call.location.update"),
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
  requirePermission("system.roll_call.location.update"),
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
  requirePermission("system.roll_call.location.update"),
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
      { actorUserId: req.user?.id ?? null },
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

router.post(
  "/sessions/:id/attendance/:personId/leave",
  requirePermission("system.roll_call.assignment.edit"),
  asyncHandler(async (req, res) => {
    const session = await rollCallService.setAttendanceLeave(
      Number(req.params.id),
      Number(req.params.personId),
      req.body?.onLeave !== false && req.body?.on_leave !== false,
      { actorUserId: req.user?.id ?? null },
    );
    res.sendSuccess({ session });
  }),
);

router.get(
  "/locations/:locationId/assignments",
  disableHttpCache,
  requireAssignmentRead,
  asyncHandler(async (req, res) => {
    const assignments = await rollCallAssignmentService.listAssignments(
      Number(req.params.locationId),
      req.query.startDate,
      req.query.endDate,
    );
    res.sendSuccess({ assignments });
  }),
);

router.put(
  "/locations/:locationId/assignments",
  requirePermission("system.roll_call.assignment.edit"),
  asyncHandler(async (req, res) => {
    const assignments = await rollCallAssignmentService.replaceAssignments(
      Number(req.params.locationId),
      req.body || {},
    );
    res.sendSuccess({ assignments });
  }),
);

router.get(
  "/locations/:locationId/assignments/import-template",
  requirePermission("system.roll_call.assignment.edit"),
  asyncHandler(async (req, res) => {
    const locationId = Number(req.params.locationId);
    const buffer =
      await rollCallAssignmentImportService.buildImportTemplateBuffer(
        locationId,
      );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="roll_call_assignments_template.xlsx"',
    );
    res.status(200).send(buffer);
  }),
);

router.post(
  "/locations/:locationId/assignments/import",
  requirePermission("system.roll_call.assignment.edit"),
  assignmentUpload.fields([{ name: "excel", maxCount: 1 }]),
  asyncHandler(async (req, res) => {
    const excelFile = req.files?.excel?.[0];
    if (!excelFile) {
      throwApiError(
        C.VALIDATION_REQUIRED,
        "請上傳 Excel 檔（欄位名稱：excel）",
      );
    }
    const result =
      await rollCallAssignmentImportService.importAssignmentsFromExcel(
        Number(req.params.locationId),
        excelFile.buffer,
      );
    res.sendSuccess(result);
  }),
);

module.exports = router;
