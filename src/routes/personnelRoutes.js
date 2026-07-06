/**
 * 人員主檔與門禁權限 API（門禁設備本系統）
 * 人員群組、人員、門禁權限（可進出地點）、可同步地點、設備同步、批次匯入。與 YSCP 資料庫流程分離。
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const personnelService = require("../services/personnel/personnelService");
const personLicensePlateService = require("../services/personnel/personLicensePlateService");
const personSyncJobService = require("../services/personnel/personSyncJobService");
const { finalizeFaceUpload } = require("../services/personnel/personFaceUploadService");
const personImportService = require("../services/personnel/personImportService");
const virtualCardService = require("../services/personnel/virtualCardService");
const {
  PERSONNEL_FACE_MAX_BYTES,
  PERSONNEL_FACE_ALLOWED_MIME,
} = require("../services/personnel/personnelFileHelpers");
const { getUploadsDir } = require("../utils/baDataPaths");
const {
  authenticate,
  requirePermission,
  requireAnyPermission,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const logger = require("../utils/logger");
const C = require("../utils/apiErrorCodes");
const { createApiError, throwApiError } = require("../utils/apiErrors");

const router = express.Router();

/** 人員主檔寫入（含平台門禁設定）；建立後首寫亦可用 create */
const requirePersonWrite = requireAnyPermission([
  "system.personnel.person.create",
  "system.personnel.person.update",
]);

router.use(authenticate, requirePermission("system.personnel"));
const isapiEventLogger = logger.createLogger("ISAPI Event");

const personnelUploadsDir = getUploadsDir("personnel");

const personnelUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, personnelUploadsDir),
    filename: (_req, _file, cb) =>
      cb(
        null,
        `temp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.jpg`,
      ),
  }),
  fileFilter: (_req, file, cb) => {
    if (PERSONNEL_FACE_ALLOWED_MIME.has(String(file.mimetype || "").toLowerCase())) {
      cb(null, true);
      return;
    }
    cb(
      createApiError(
        C.PERSONNEL_FACE_UPLOAD_INVALID_FILE_FORMAT,
        "圖片格式不正確：僅允許 JPEG（JPG）",
      ),
      false,
    );
  },
  limits: { fileSize: PERSONNEL_FACE_MAX_BYTES },
});

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ========== 人員群組 ==========

router.get(
  "/groups",
  asyncHandler(async (req, res) => {
    const list = await personnelService.getPersonGroups(req.query || {});
    res.sendSuccess(list);
  }),
);

router.get(
  "/groups/:id",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.getPersonGroupById(
      parseInt(req.params.id, 10),
    );
    res.sendSuccess(item);
  }),
);

router.post(
  "/groups",
  requirePermission("system.personnel.group.create"),
  asyncHandler(async (req, res) => {
    const createdBy = req.user?.id ?? null;
    const item = await personnelService.createPersonGroup(
      req.body || {},
      createdBy,
    );
    res.sendSuccess(item, 201);
  }),
);

router.put(
  "/groups/:id",
  requirePermission("system.personnel.group.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.updatePersonGroup(
      parseInt(req.params.id, 10),
      req.body || {},
    );
    res.sendSuccess(item);
  }),
);

router.delete(
  "/groups/:id",
  requirePermission("system.personnel.group.delete"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePersonGroup(parseInt(req.params.id, 10));
    res.sendSuccess({ ok: true });
  }),
);

// ========== 人員群組成員（SSOT：persons.person_group_id） ==========

router.get(
  "/groups/:id/members",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const limit =
      req.query.limit != null && String(req.query.limit).trim() !== ""
        ? parseInt(String(req.query.limit), 10)
        : 200;
    const offset =
      req.query.offset != null && String(req.query.offset).trim() !== ""
        ? parseInt(String(req.query.offset), 10)
        : 0;
    const status =
      req.query.status != null ? String(req.query.status) : undefined;
    const q = req.query.q != null ? String(req.query.q) : undefined;
    const result = await personnelService.getPersonsByGroupId(id, {
      limit,
      offset,
      status,
      q,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/groups/:id/member-ids",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const ids = await personnelService.getPersonGroupMemberIds(id);
    res.sendSuccess({ ids });
  }),
);

/**
 * 取代該群組的成員清單（批次移入/移出；以 persons.person_group_id 為 SSOT）
 * PUT /api/personnel/groups/:id/members
 * Body: { memberPersonIds: number[] }
 */
router.put(
  "/groups/:id/members",
  requirePermission("system.personnel.group.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const memberPersonIds = req.body?.memberPersonIds;
    const result = await personnelService.replacePersonGroupMembers(
      id,
      Array.isArray(memberPersonIds) ? memberPersonIds : [],
    );
    res.sendSuccess(result);
  }),
);

// ========== 人員 ==========

router.get(
  "/persons",
  asyncHandler(async (req, res) => {
    const filters = {};
    if (req.query.personGroupId != null)
      filters.personGroupId = parseInt(req.query.personGroupId, 10);
    if (req.query.personGroupIds != null)
      filters.personGroupIds = String(req.query.personGroupIds);
    if (req.query.mainGroupId != null)
      filters.mainGroupId = parseInt(req.query.mainGroupId, 10);
    if (req.query.ungroupedOnly != null)
      filters.ungroupedOnly = req.query.ungroupedOnly;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.employeeNo) filters.employeeNo = req.query.employeeNo;
    if (req.query.fullName) filters.fullName = req.query.fullName;
    if (req.query.q) filters.q = String(req.query.q);
    const sortOrder =
      req.query.sortOrder != null ? String(req.query.sortOrder) : undefined;
    const limit =
      req.query.limit != null && String(req.query.limit).trim() !== ""
        ? parseInt(String(req.query.limit), 10)
        : 10;
    const offset =
      req.query.offset != null && String(req.query.offset).trim() !== ""
        ? parseInt(String(req.query.offset), 10)
        : 0;

    const result = await personnelService.getPersonsPaged(filters, {
      limit,
      offset,
      sortOrder,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/persons/by-employee-no/:employeeNo",
  asyncHandler(async (req, res) => {
    const person = await personnelService.getPersonByEmployeeNo(
      req.params.employeeNo,
    );
    if (!person) {
      throwApiError(C.PERSONNEL_PERSON_NOT_FOUND, "人員不存在", {
        statusCode: 404,
      });
    }
    res.sendSuccess(person);
  }),
);

router.get(
  "/persons/:id",
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.getPersonById(
      parseInt(req.params.id, 10),
    );
    res.sendSuccess(item);
  }),
);

router.post(
  "/persons",
  requirePermission("system.personnel.person.create"),
  asyncHandler(async (req, res) => {
    const createdBy = req.user?.id ?? null;
    const item = await personnelService.createPerson(req.body || {}, createdBy);
    res.sendSuccess(item, 201);
  }),
);

/**
 * 依車牌查詢人員主檔綁定（車牌管理 UI 顯示用）
 * GET /api/personnel/license-plates/bindings?plates=ABC1234,XYZ
 */
router.get(
  "/license-plates/bindings",
  asyncHandler(async (req, res) => {
    const raw = req.query?.plates ?? req.query?.plate ?? "";
    const plates = String(raw)
      .split(/[,;，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const items = await personLicensePlateService.findBindingsByPlates(plates);
    res.sendSuccess({ items });
  }),
);

router.put(
  "/persons/:id",
  requirePermission("system.personnel.person.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.updatePerson(
      parseInt(req.params.id, 10),
      req.body || {},
    );
    res.sendSuccess(item);
  }),
);

router.put(
  "/persons/:id/license-plates",
  requirePermission("system.personnel.person.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const personId = parseInt(req.params.id, 10);
    const plates = req.body?.licensePlates ?? req.body?.plates ?? [];
    const syncToDevices = req.body?.syncToDevices === true;
    const result = await personnelService.replacePersonLicensePlates(
      personId,
      plates,
      { syncToDevices },
    );
    res.sendSuccess(result);
  }),
);

/**
 * 更新人員梯控卡片主檔（僅存平台；下發設備由同步 job 處理）
 * PUT /api/personnel/persons/:id/ladder-card
 * Body: { floors: { byLocation: { "<locationId>": number[] } } }；卡號／密碼／有效期取自人員主檔 access_control
 * DELETE body 或 cardNo 空字串可清除
 */
router.put(
  "/persons/:id/ladder-card",
  requirePermission("system.personnel.person.update"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const personId = parseInt(req.params.id, 10);
    const body = req.body || {};
    const shouldClear =
      body.clear === true ||
      body.ladderCard === null ||
      (body.cardNo != null && String(body.cardNo).trim() === "");
    const result = await personnelService.replacePersonLadderCard(
      personId,
      shouldClear ? null : body.ladderCard ?? body,
    );
    res.sendSuccess(result);
  }),
);

/**
 * 一次更新人員門禁設定（整合卡片/指紋/密碼/validity；僅存平台）
 * PUT /api/personnel/persons/:personId/access-control-config
 * Body（節錄）:
 * - validity: { longTerm, beginTime, endTime }
 * - cards?: Array<{ cardNo: string, source?: "manual"|"captured"|"virtual" }>
 * - cardNo?: string | null (deprecated)
 * - fingerData?: string | null
 * - password?: string | null
 */
router.put(
  "/persons/:personId/access-control-config",
  requirePersonWrite,
  validateIntegers("personId"),
  asyncHandler(async (req, res) => {
    const personId = parseInt(req.params.personId, 10);
    const person = await personnelService.setPersonAccessControlConfig(
      personId,
      req.body || {},
    );
    res.sendSuccess({ person });
  }),
);

/**
 * 產生虛擬卡號（10 碼：9 + 9 位隨機數字；全系統虛擬卡去重）
 * POST /api/personnel/virtual-card/generate
 */
router.post(
  "/virtual-card/generate",
  requirePersonWrite,
  asyncHandler(async (_req, res) => {
    const result = await virtualCardService.generateVirtualCard();
    res.sendSuccess(result);
  }),
);

router.delete(
  "/persons/:id",
  requirePermission("system.personnel.person.delete"),
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePerson(parseInt(req.params.id, 10));
    res.sendSuccess({ ok: true });
  }),
);

// ========== 人員大頭照上傳 ==========
// POST /persons/:personId/upload-face：檔名由 DB 的姓名/員工編號組成，並自動更新該人員 face_url。
// 修改時會先刪除該人員原有的圖片檔，再儲存新圖（真正取代舊圖，不累積孤兒檔）。

router.post(
  "/persons/:personId/upload-face",
  requirePersonWrite,
  validateIntegers("personId"),
  personnelUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throwApiError(C.PERSONNEL_FACE_UPLOAD_FILE_MISSING, "請選擇圖片檔案");
    }

    const tempPath = path.join(personnelUploadsDir, req.file.filename);
    const personId = parseInt(req.params.personId, 10);

    const payload = await finalizeFaceUpload({
      tempPath,
      personnelUploadsDir,
      personId,
      warnLogger: (msg, meta) => isapiEventLogger.warn(msg, meta),
    });

    res.sendSuccess(payload, 201);
  }),
);

// ========== 可同步地點列表 ==========

router.get(
  "/syncable-locations",
  asyncHandler(async (req, res) => {
    const list = await personSyncJobService.getSyncableLocations();
    res.sendSuccess(list);
  }),
);

/**
 * 取得某地點「應同步至設備」的人員清單（含人臉/卡/指紋是否有值），供 UI 顯示步驟欄
 * GET /api/personnel/locations/:locationId/sync-candidates
 */
router.get(
  "/locations/:locationId/sync-candidates",
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const rows = await personSyncJobService.getSyncCandidatesForLocation(
      parseInt(req.params.locationId, 10),
    );
    res.sendSuccess({ persons: rows });
  }),
);

// ========== 地點成員管理（門禁權限名單；SSOT：person_location_access） ==========

router.get(
  "/locations/:locationId/members",
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.locationId, 10);
    const limit =
      req.query.limit != null && String(req.query.limit).trim() !== ""
        ? parseInt(String(req.query.limit), 10)
        : 20;
    const offset =
      req.query.offset != null && String(req.query.offset).trim() !== ""
        ? parseInt(String(req.query.offset), 10)
        : 0;
    const status =
      req.query.status != null ? String(req.query.status) : undefined;
    const q = req.query.q != null ? String(req.query.q) : undefined;

    const result = await personnelService.getPersonsByLocationIdPaged(
      locationId,
      {
        limit,
        offset,
        status,
        q,
      },
    );
    res.sendSuccess(result);
  }),
);

router.get(
  "/locations/:locationId/member-ids",
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.locationId, 10);
    const ids = await personnelService.getLocationMemberIds(locationId);
    res.sendSuccess({ ids });
  }),
);

/**
 * 地點名單內人員車牌（平台 SSOT；供車牌管理 UI）
 * GET /api/personnel/locations/:locationId/license-plates
 */
router.get(
  "/locations/:locationId/license-plates",
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.locationId, 10);
    const items = await personnelService.listLicensePlatesByLocationId(locationId);
    res.sendSuccess({ items });
  }),
);

/**
 * 重新將此地點名單內車牌推送至攝影機（不變更 person_location_access）
 * POST /api/personnel/locations/:locationId/sync-plates
 */
router.post(
  "/locations/:locationId/sync-plates",
  requireAnyPermission([
    "system.vehicle_access.plate.manage",
    "system.people_counting.device_sync",
  ]),
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.locationId, 10);
    const result = await personnelService.syncLicensePlatesForLocation(locationId);
    res.sendSuccess(result);
  }),
);

/**
 * 取代該地點的門禁名單（批次加入/移除；SSOT：person_location_access）
 * PUT /api/personnel/locations/:locationId/members
 * Body: { memberPersonIds: number[] }
 */
router.put(
  "/locations/:locationId/members",
  requireAnyPermission([
    "system.people_counting.sync.edit",
    "system.vehicle_access.plate.manage",
  ]),
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const locationId = parseInt(req.params.locationId, 10);
    const memberPersonIds = req.body?.memberPersonIds;
    const result = await personnelService.replaceLocationMembers(
      locationId,
      Array.isArray(memberPersonIds) ? memberPersonIds : [],
    );
    res.sendSuccess(result);
  }),
);

// ========== 設備同步（同步執行） ==========

router.post(
  "/sync-location/:locationId",
  requirePermission("system.people_counting.device_sync"),
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const { warnings } = await personSyncJobService.syncLocation(
      parseInt(req.params.locationId, 10),
    );
    res.sendSuccess({ warnings });
  }),
);

// ========== 設備同步（單一地點；背景 job） ==========
// POST /sync-location/:locationId/job -> { jobId } (202)
// GET  /sync-location/jobs/:jobId -> job status/result

router.post(
  "/sync-location/:locationId/job",
  requirePermission("system.people_counting.device_sync"),
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const { jobId } = personSyncJobService.startSyncLocationJob(
      parseInt(req.params.locationId, 10),
    );
    res.sendSuccess({ jobId }, 202);
  }),
);

router.get(
  "/sync-location/jobs/:jobId",
  asyncHandler(async (req, res) => {
    const includeIssues = String(req.query.includeIssues || "").trim() === "1";
    const includeTail = String(req.query.includeTail || "").trim() === "1";
    const issuesLimit =
      req.query.issuesLimit != null && String(req.query.issuesLimit).trim() !== ""
        ? parseInt(String(req.query.issuesLimit), 10)
        : undefined;
    const tailLimit =
      req.query.tailLimit != null && String(req.query.tailLimit).trim() !== ""
        ? parseInt(String(req.query.tailLimit), 10)
        : undefined;

    const job = await personSyncJobService.getSyncLocationJobView(req.params.jobId, {
      includeIssues,
      includeTail,
      issuesLimit,
      tailLimit,
    });
    if (!job) {
      throwApiError(C.PERSONNEL_SYNC_JOB_NOT_FOUND, "同步工作不存在", {
        statusCode: 404,
      });
    }
    res.sendSuccess(job);
  }),
);

/**
 * 同步 job 明細（分頁）
 * GET /api/personnel/sync-location/jobs/:jobId/items?type=issues|tail&limit=200&offset=0
 *
 * - type=issues：僅保留 failed（用於查錯）
 * - type=tail：最後 N 筆事件（用於前端即時 UI；小 payload）
 */
router.get(
  "/sync-location/jobs/:jobId/items",
  asyncHandler(async (req, res) => {
    const typeRaw = String(req.query.type || "").trim();
    const type = typeRaw === "tail" ? "tail" : "issues";
    const limit =
      req.query.limit != null && String(req.query.limit).trim() !== ""
        ? parseInt(String(req.query.limit), 10)
        : 200;
    const offset =
      req.query.offset != null && String(req.query.offset).trim() !== ""
        ? parseInt(String(req.query.offset), 10)
        : 0;

    const result = await personSyncJobService.getSyncLocationJobItems(req.params.jobId, type, {
      limit,
      offset,
    });
    if (!result) {
      throwApiError(C.PERSONNEL_SYNC_JOB_NOT_FOUND, "同步工作不存在", {
        statusCode: 404,
      });
    }
    res.sendSuccess(result);
  }),
);

router.post(
  "/sync-all-locations",
  requirePermission("system.people_counting.device_sync"),
  asyncHandler(async (req, res) => {
    const job = personSyncJobService.startSyncAllLocationsJob();
    res.sendSuccess({ jobId: job.jobId }, 202);
  }),
);

router.get(
  "/sync-all-locations/jobs/:jobId",
  asyncHandler(async (req, res) => {
    const job = await personSyncJobService.getSyncAllLocationsJob(req.params.jobId);
    if (!job) {
      throwApiError(C.PERSONNEL_SYNC_JOB_NOT_FOUND, "同步工作不存在", {
        statusCode: 404,
      });
    }
    res.sendSuccess(job);
  }),
);

// ========== 批次匯入（Excel + 圖片 zip；單一路由） ==========

// 下載批次匯入範例 Excel（template）
router.get(
  "/import-template",
  asyncHandler(async (_req, res) => {
    const filename = "personnel_import_template.xlsx";
    const buffer = await personImportService.getImportTemplateXlsxBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  }),
);

router.post(
  "/import",
  requirePermission("system.personnel.person.create"),
  importUpload.fields([
    { name: "excel", maxCount: 1 },
    { name: "imagesZip", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const excelFile = req.files?.excel?.[0];
    if (!excelFile) {
      throwApiError(C.PERSONNEL_IMPORT_EXCEL_FILE_MISSING, "請上傳 Excel 檔（欄位名稱：excel）");
    }
    const zipFile = req.files?.imagesZip?.[0] ?? null;
    const createdBy = req.user?.id ?? null;

    const result = await personImportService.executeBatchImport({
      excelBuffer: excelFile.buffer,
      zipBuffer: zipFile?.buffer,
      createdBy,
      personnelUploadsDir,
    });

    res.sendSuccess(
      {
        created: result.created,
        createdIds: result.createdIds,
        errors: result.errors,
      },
      201,
    );
  }),
);

// 佈防訂閱狀態（供確認後端是否已實施佈防）
const isapiSubscribeService = require("../services/accessControl/isapiSubscribeService");
router.get(
  "/isapi-subscribe-status",
  asyncHandler(async (_req, res) => {
    const status = isapiSubscribeService.getSubscribeStatus();
    res.sendSuccess({
      subscribe: {
        started: status.started,
        deviceIds: status.deviceIds,
        message: status.started
          ? `佈防已啟動，訂閱設備 ID：${status.deviceIds.join(", ") || "無"}`
          : "佈防未啟動或無需訂閱的門禁設備",
      },
    });
  }),
);

module.exports = router;
