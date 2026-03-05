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
const personSyncJobService = require("../services/personnel/personSyncJobService");
const {
  authenticate,
  requireAdminOrOperator,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const logger = require("../utils/logger");
const db = require("../database/db");

const router = express.Router();
const isapiEventLogger = logger.createLogger("ISAPI Event");

const uploadsBase = path.join(process.cwd(), "uploads");
["personnel", "isapi-events"].forEach((dir) => {
  const full = path.join(uploadsBase, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});
const personnelUploadsDir = path.join(uploadsBase, "personnel");

/** 將人員姓名、員工編號等組成安全的檔案名稱（僅保留安全字元，最長 120 字元） */
function buildPersonnelFilename(fullName, employeeNo, ext) {
  const safe = (s) =>
    String(s == null ? "" : s)
      .trim()
      .replace(/[/\\:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 60);
  const namePart = safe(fullName);
  const noPart = safe(employeeNo);
  const parts = [noPart, namePart].filter(Boolean);
  const base = parts.length
    ? parts.join("_")
    : `face_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  return `${base.slice(0, 120)}${ext}`;
}

const personnelUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, personnelUploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      const unique = `temp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
      cb(null, unique);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("僅允許上傳圖片（JPEG、PNG、GIF、WEBP）"), false);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ========== 人員群組 ==========

router.get(
  "/groups",
  authenticate,
  asyncHandler(async (req, res) => {
    const list = await personnelService.getPersonGroups(req.query || {});
    res.sendSuccess(list);
  }),
);

router.get(
  "/groups/:id",
  authenticate,
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
  authenticate,
  requireAdminOrOperator,
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
  authenticate,
  requireAdminOrOperator,
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
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePersonGroup(parseInt(req.params.id, 10));
    res.sendSuccess({ success: true });
  }),
);

// ========== 人員 ==========

router.get(
  "/persons",
  authenticate,
  asyncHandler(async (req, res) => {
    const filters = {};
    if (req.query.personGroupId != null)
      filters.personGroupId = parseInt(req.query.personGroupId, 10);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.employeeNo) filters.employeeNo = req.query.employeeNo;
    if (req.query.fullName) filters.fullName = req.query.fullName;
    const list = await personnelService.getPersons(filters);
    res.sendSuccess(list);
  }),
);

router.get(
  "/persons/by-employee-no/:employeeNo",
  authenticate,
  asyncHandler(async (req, res) => {
    const person = await personnelService.getPersonByEmployeeNo(
      req.params.employeeNo,
    );
    if (!person) {
      const err = new Error("人員不存在");
      err.statusCode = 404;
      throw err;
    }
    res.sendSuccess(person);
  }),
);

router.get(
  "/persons/:id",
  authenticate,
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
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const createdBy = req.user?.id ?? null;
    const item = await personnelService.createPerson(req.body || {}, createdBy);
    res.sendSuccess(item, 201);
  }),
);

router.put(
  "/persons/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    const item = await personnelService.updatePerson(
      parseInt(req.params.id, 10),
      req.body || {},
    );
    res.sendSuccess(item);
  }),
);

router.delete(
  "/persons/:id",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePerson(parseInt(req.params.id, 10));
    res.sendSuccess({ success: true });
  }),
);

// ========== 人員大頭照上傳 ==========
// POST /persons/:personId/upload-face：檔名由 DB 的姓名/員工編號組成，並自動更新該人員 face_url。
// 修改時會先刪除該人員原有的圖片檔，再儲存新圖（真正取代舊圖，不累積孤兒檔）。

router.post(
  "/persons/:personId/upload-face",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("personId"),
  personnelUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      const err = new Error("請選擇圖片檔案");
      err.statusCode = 400;
      throw err;
    }
    const personId = parseInt(req.params.personId, 10);
    const person = await personnelService.getPersonById(personId);
    const ext = path.extname(req.file.filename);
    const fullName = person.full_name ?? "";
    const employeeNo = person.employee_no ?? "";
    const desiredName = buildPersonnelFilename(fullName, employeeNo, ext);

    // 若該人員已有大頭照，先刪除舊檔（修改時取代原有圖片，不保留舊檔）
    const existingFaceUrl = person.face_url;
    if (existingFaceUrl && typeof existingFaceUrl === "string") {
      const base = path.basename(existingFaceUrl.trim().replace(/^\//, ""));
      if (base && !base.includes("..")) {
        const oldFilePath = path.join(personnelUploadsDir, base);
        if (fs.existsSync(oldFilePath)) {
          try {
            fs.unlinkSync(oldFilePath);
          } catch (err) {
            isapiEventLogger.warn("刪除舊大頭照失敗", {
              path: oldFilePath,
              error: err?.message,
            });
          }
        }
      }
    }

    const oldPath = path.join(personnelUploadsDir, req.file.filename);
    let finalFilename = desiredName;
    let newPath = path.join(personnelUploadsDir, finalFilename);
    let n = 0;
    while (fs.existsSync(newPath) && newPath !== oldPath) {
      n += 1;
      const base = path.basename(desiredName, ext);
      finalFilename = `${base}_${n}${ext}`;
      newPath = path.join(personnelUploadsDir, finalFilename);
    }
    if (oldPath !== newPath) fs.renameSync(oldPath, newPath);
    const faceUrl = `/uploads/personnel/${finalFilename}`;
    const updated = await personnelService.updatePerson(personId, { faceUrl });
    res.sendSuccess({ faceUrl, person: updated }, 201);
  }),
);

// ========== 門禁權限（人員 ↔ 地點） ==========

router.get(
  "/persons/:personId/access-locations",
  authenticate,
  validateIntegers("personId"),
  asyncHandler(async (req, res) => {
    const result = await personnelService.getAccessLocationsByPersonId(
      parseInt(req.params.personId, 10),
    );
    res.sendSuccess(result);
  }),
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
      Array.isArray(locationIds) ? locationIds : [],
    );
    res.sendSuccess(result);
  }),
);

// ========== 可同步地點列表 ==========

router.get(
  "/syncable-locations",
  authenticate,
  asyncHandler(async (req, res) => {
    const list = await personSyncJobService.getSyncableLocations();
    res.sendSuccess(list);
  }),
);

// ========== 設備同步（同步執行） ==========

router.post(
  "/sync-location/:locationId",
  authenticate,
  requireAdminOrOperator,
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const { warnings } = await personSyncJobService.syncLocation(
      parseInt(req.params.locationId, 10),
    );
    res.sendSuccess({ success: true, warnings });
  }),
);

router.post(
  "/sync-all-locations",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const { synced, results } = await personSyncJobService.syncAllLocations();
    res.sendSuccess({ synced, results });
  }),
);

// ========== 批次匯入（JSON） ==========

router.post(
  "/import",
  authenticate,
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const list = Array.isArray(body.persons)
      ? body.persons
      : Array.isArray(body)
        ? body
        : [];
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
          {
            employeeNo: String(employeeNo).trim(),
            fullName: fullName ? String(fullName).trim() : null,
            personGroupId,
          },
          createdBy,
        );
        created.push({ id: person.id, employeeNo: person.employee_no });
        const locIds = Array.isArray(locationIds)
          ? locationIds
              .map((x) => parseInt(x, 10))
              .filter((x) => !Number.isNaN(x))
          : [];
        if (locIds.length > 0) {
          await personnelService.setAccessLocationsForPerson(person.id, locIds);
          locIds.forEach((id) => allLocationIds.add(id));
        }
      } catch (err) {
        errors.push({
          row: i + 1,
          employeeNo: String(employeeNo),
          message: err.message || String(err),
        });
      }
    }

    res.sendSuccess(
      {
        created: created.length,
        createdIds: created,
        errors: errors.length > 0 ? errors : undefined,
      },
      201,
    );
  }),
);

// ISAPI 門禁事件已改為佈防模式，POST /isapi-events 廢止（410）
router.post(
  "/isapi-events",
  asyncHandler(async (_req, res) => {
    res.status(410).json({
      success: false,
      error: "Gone",
      message: "門禁事件已改為佈防模式，後端主動向設備訂閱；請勿在設備上設定 HTTP 監聽主機。",
      docs: "docs/ACCESS_CONTROL_DEVICE_FLOW.md",
    });
  }),
);

// 佈防訂閱狀態（供確認後端是否已實施佈防）
const isapiSubscribeService = require("../services/accessControl/isapiSubscribeService");
router.get(
  "/isapi-subscribe-status",
  authenticate,
  asyncHandler(async (_req, res) => {
    const status = isapiSubscribeService.getSubscribeStatus();
    res.json({
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
