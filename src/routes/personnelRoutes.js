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
const websocketService = require("../services/websocket/websocketService");

const router = express.Router();
const isapiEventLogger = logger.createLogger("ISAPI Event");

const uploadsBase = path.join(process.cwd(), "uploads");
["personnel", "isapi-events"].forEach((dir) => {
  const full = path.join(uploadsBase, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});
const personnelUploadsDir = path.join(uploadsBase, "personnel");
const isapiEventsUploadsDir = path.join(uploadsBase, "isapi-events");

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

// ========== ISAPI 設備事件監聽（寫入端） ==========
// POST /api/personnel/isapi-events：僅處理附圖五種事件，寫入 isapi_access_events 並推送 WebSocket；門禁事件查詢請用「人流統計 → 進出紀錄」

const ISAPI_PROCESS_SUB_TYPES = new Set([75, 76, 2077, 2078, 2079]); // 人臉辨識成功/失敗、酒精檢測正常/飲酒/醉酒

const isapiEventUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).any();

const isProcessableIsapiEvent = (ac) => {
  if (!ac || ac.majorEventType !== 5) return false;
  return ISAPI_PROCESS_SUB_TYPES.has(Number(ac.subEventType));
};

/**
 * POST /api/personnel/isapi-events
 * 僅處理附圖五種事件類型，寫入 DB 並寫 log；其餘（含 heartBeat、其他 major/sub）僅回 200。
 */
router.post(
  "/isapi-events",
  isapiEventUpload,
  asyncHandler(async (req, res) => {
    const rawBody = req.body || {};
    const files = req.files || [];
    let parsedEvent = null;
    if (rawBody.AccessControllerEvent) {
      try {
        parsedEvent =
          typeof rawBody.AccessControllerEvent === "string"
            ? JSON.parse(rawBody.AccessControllerEvent)
            : rawBody.AccessControllerEvent;
      } catch (_e) {
        parsedEvent = rawBody.AccessControllerEvent;
      }
    }
    const ac = parsedEvent?.AccessControllerEvent || {};
    if (
      parsedEvent?.eventType === "heartBeat" ||
      !isProcessableIsapiEvent(ac)
    ) {
      return res.status(200).json({
        success: true,
        message: "received",
        receivedAt: new Date().toISOString(),
        fileCount: files.length,
      });
    }
    let picturePath = null;
    if (files.length > 0 && files[0].buffer) {
      const ext = path.extname(files[0].originalname) || ".jpg";
      const ip =
        (parsedEvent?.ipAddress ?? "").replace(/[^0-9a-fA-F.:]/g, "_") ||
        "unknown";
      const rawTime = parsedEvent?.dateTime ?? new Date().toISOString();
      const timePart = rawTime
        .replace(/:/g, "-")
        .replace(/\+.*$/, "")
        .replace(/Z$/, "")
        .slice(0, 16);
      const basename = `${ip}_${timePart}${ext}`;
      fs.writeFileSync(
        path.join(isapiEventsUploadsDir, basename),
        files[0].buffer,
      );
      picturePath = `/uploads/isapi-events/${basename}`;
    }
    await db.query(
      `INSERT INTO isapi_access_events (device_ip, event_time, event_type, payload, file_count, picture_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        parsedEvent?.ipAddress ?? "",
        parsedEvent?.dateTime ?? new Date().toISOString(),
        parsedEvent?.eventType ?? "AccessControllerEvent",
        JSON.stringify(ac),
        files.length,
        picturePath,
      ],
    );
    const filesMeta = files.map((f) => ({
      fieldname: f.fieldname,
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
    }));
    isapiEventLogger.info("[ISAPI] 完整接收內容", {
      ipAddress: parsedEvent?.ipAddress,
      dateTime: parsedEvent?.dateTime,
      AccessControllerEvent: ac,
      files: filesMeta,
    });
    websocketService.emitIsapiAccessEvent();
    res.status(200).json({
      success: true,
      message: "received",
      receivedAt: new Date().toISOString(),
      fileCount: files.length,
    });
  }),
);

module.exports = router;
