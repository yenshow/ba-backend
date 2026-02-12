/**
 * 人員主檔與門禁權限 API
 * 人員群組、人員、門禁權限（地點）、設備同步（同步執行）、可同步地點列表、批次匯入
 */
const express = require("express");
const personnelService = require("../services/personnel/personnelService");
const personSyncJobService = require("../services/personnel/personSyncJobService");
const { authenticate, requireAdminOrOperator } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");

const router = express.Router();

// ========== 人員群組 ==========

router.get(
  "/groups",
  authenticate,
  asyncHandler(async (req, res) => {
    const list = await personnelService.getPersonGroups(req.query || {});
    res.sendSuccess(list);
  })
);

router.get(
  "/groups/:id",
  authenticate,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.getPersonGroupById(parseInt(req.params.id, 10));
    res.sendSuccess(item);
  })
);

router.post(
  "/groups",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const createdBy = req.user?.id ?? null;
    const item = await personnelService.createPersonGroup(req.body || {}, createdBy);
    res.sendSuccess(item, 201);
  })
);

router.put(
  "/groups/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.updatePersonGroup(parseInt(req.params.id, 10), req.body || {});
    res.sendSuccess(item);
  })
);

router.delete(
  "/groups/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePersonGroup(parseInt(req.params.id, 10));
    res.sendSuccess({ success: true });
  })
);

// ========== 人員 ==========

router.get(
  "/persons",
  authenticate,
  asyncHandler(async (req, res) => {
    const filters = {};
    if (req.query.personGroupId != null) filters.personGroupId = parseInt(req.query.personGroupId, 10);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.employeeNo) filters.employeeNo = req.query.employeeNo;
    if (req.query.fullName) filters.fullName = req.query.fullName;
    const list = await personnelService.getPersons(filters);
    res.sendSuccess(list);
  })
);

router.get(
  "/persons/by-employee-no/:employeeNo",
  authenticate,
  asyncHandler(async (req, res) => {
    const person = await personnelService.getPersonByEmployeeNo(req.params.employeeNo);
    if (!person) {
      const err = new Error("人員不存在");
      err.statusCode = 404;
      throw err;
    }
    res.sendSuccess(person);
  })
);

router.get(
  "/persons/:id",
  authenticate,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.getPersonById(parseInt(req.params.id, 10));
    res.sendSuccess(item);
  })
);

router.post(
  "/persons",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const createdBy = req.user?.id ?? null;
    const item = await personnelService.createPerson(req.body || {}, createdBy);
    res.sendSuccess(item, 201);
  })
);

router.put(
  "/persons/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.updatePerson(parseInt(req.params.id, 10), req.body || {});
    res.sendSuccess(item);
  })
);

router.delete(
  "/persons/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePerson(parseInt(req.params.id, 10));
    res.sendSuccess({ success: true });
  })
);

// ========== 門禁權限（人員 ↔ 地點） ==========

router.get(
  "/persons/:personId/access-locations",
  authenticate,
  validateIntegers("personId"),
  asyncHandler(async (req, res) => {
    const result = await personnelService.getAccessLocationsByPersonId(parseInt(req.params.personId, 10));
    res.sendSuccess(result);
  })
);

router.put(
  "/persons/:personId/access-locations",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("personId"),
  asyncHandler(async (req, res) => {
    const locationIds = req.body?.locationIds;
    const result = await personnelService.setAccessLocationsForPerson(
      parseInt(req.params.personId, 10),
      Array.isArray(locationIds) ? locationIds : []
    );
    res.sendSuccess(result);
  })
);

// ========== 可同步地點列表 ==========

router.get(
  "/syncable-locations",
  authenticate,
  asyncHandler(async (req, res) => {
    const list = await personSyncJobService.getSyncableLocations();
    res.sendSuccess(list);
  })
);

// ========== 設備同步（同步執行） ==========

router.post(
  "/sync-location/:locationId",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    await personSyncJobService.syncLocation(parseInt(req.params.locationId, 10));
    res.sendSuccess({ success: true });
  })
);

router.post(
  "/sync-all-locations",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const synced = await personSyncJobService.syncAllLocations();
    res.sendSuccess({ synced });
  })
);

// ========== 批次匯入（JSON） ==========

router.post(
  "/import",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const list = Array.isArray(body.persons) ? body.persons : Array.isArray(body) ? body : [];
    const createdBy = req.user?.id ?? null;
    const created = [];
    const errors = [];
    const allLocationIds = new Set();

    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const employeeNo = row.employeeNo ?? row.employee_no;
      const fullName = row.fullName ?? row.full_name ?? null;
      const personGroupId = row.personGroupId ?? row.person_group_id ?? null;
      const locationIds = row.locationIds ?? row.location_ids ?? [];
      if (!employeeNo || String(employeeNo).trim() === "") {
        errors.push({ row: i + 1, message: "員工編號不能為空" });
        continue;
      }
      try {
        const person = await personnelService.createPerson(
          { employeeNo: String(employeeNo).trim(), fullName: fullName ? String(fullName).trim() : null, personGroupId },
          createdBy
        );
        created.push({ id: person.id, employeeNo: person.employee_no });
        const locIds = Array.isArray(locationIds) ? locationIds.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x)) : [];
        if (locIds.length > 0) {
          await personnelService.setAccessLocationsForPerson(person.id, locIds);
          locIds.forEach((id) => allLocationIds.add(id));
        }
      } catch (err) {
        errors.push({ row: i + 1, employeeNo: String(employeeNo), message: err.message || String(err) });
      }
    }

    res.sendSuccess({
      created: created.length,
      createdIds: created,
      errors: errors.length > 0 ? errors : undefined,
    }, 201);
  })
);

module.exports = router;
