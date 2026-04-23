/**
 * 人員主檔與門禁權限 API（門禁設備本系統）
 * 人員群組、人員、門禁權限（可進出地點）、可同步地點、設備同步、批次匯入。與 YSCP 資料庫流程分離。
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const personnelService = require("../services/personnel/personnelService");
const personSyncJobService = require("../services/personnel/personSyncJobService");
const {
  authenticate,
  requireAdminOrOperator,
  requirePermission,
} = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const { validateIntegers } = require("../middleware/validation");
const logger = require("../utils/logger");

const router = express.Router();
const isapiEventLogger = logger.createLogger("ISAPI Event");

const uploadsBase = path.join(process.cwd(), "uploads");
["personnel", "isapi-events"].forEach((dir) => {
  const full = path.join(uploadsBase, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});
const personnelUploadsDir = path.join(uploadsBase, "personnel");

const PERSONNEL_FACE_MAX_BYTES = 200 * 1024; // 與前端一致（設備限制）
const PERSONNEL_FACE_ALLOWED_MIME = new Set(["image/jpeg", "image/jpg"]);

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

function readFileHeaderBytes(filePath, maxBytes = 32) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, Math.max(0, bytesRead));
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_e) {}
  }
}

function isJpegByMagicBytes(header) {
  if (!Buffer.isBuffer(header) || header.length < 3) return false;
  // JPEG: FF D8 FF
  return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_e) {}
}

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
    if (PERSONNEL_FACE_ALLOWED_MIME.has(String(file.mimetype).toLowerCase())) {
      cb(null, true);
      return;
    }
    cb(new Error("圖片格式不正確：僅允許 JPEG（JPG）"), false);
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
  authenticate,
  requirePermission("system.personnel"),
  asyncHandler(async (req, res) => {
    const list = await personnelService.getPersonGroups(req.query || {});
    res.sendSuccess(list);
  }),
);

router.get(
  "/groups/:id",
  authenticate,
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
  requireAdminOrOperator,
  validateIntegers("id"),
  asyncHandler(async (req, res) => {
    await personnelService.deletePersonGroup(parseInt(req.params.id, 10));
    res.sendSuccess({ success: true });
  }),
);

// ========== 人員群組成員（SSOT：persons.person_group_id） ==========

router.get(
  "/groups/:id/members",
  authenticate,
  requirePermission("system.personnel"),
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
    const result = await personnelService.getPersonsByGroupId(id, {
      limit,
      offset,
      status,
    });
    res.sendSuccess(result);
  }),
);

/**
 * 取代該群組的成員清單（批次移入/移出；以 persons.person_group_id 為 SSOT）
 * PUT /api/personnel/groups/:id/members
 * Body: { memberPersonIds: number[] }
 */
router.put(
  "/groups/:id/members",
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
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
  authenticate,
  requirePermission("system.personnel"),
  asyncHandler(async (req, res) => {
    const filters = {};
    if (req.query.personGroupId != null)
      filters.personGroupId = parseInt(req.query.personGroupId, 10);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.employeeNo) filters.employeeNo = req.query.employeeNo;
    if (req.query.fullName) filters.fullName = req.query.fullName;
    if (req.query.q) filters.q = String(req.query.q);
    const sortBy =
      req.query.sortBy != null ? String(req.query.sortBy) : undefined;
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
      sortBy,
      sortOrder,
    });
    res.sendSuccess(result);
  }),
);

router.get(
  "/persons/by-employee-no/:employeeNo",
  authenticate,
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
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

/**
 * 一次更新人員門禁設定（整合卡片/指紋/密碼/validity；僅存平台）
 * PUT /api/personnel/persons/:personId/access-control-config
 * Body（節錄）:
 * - validity: { longTerm, beginTime, endTime }
 * - cardNo?: string | null
 * - fingerData?: string | null
 * - password?: string | null
 */
router.put(
  "/persons/:personId/access-control-config",
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
  validateIntegers("personId"),
  asyncHandler(async (req, res) => {
    const personId = parseInt(req.params.personId, 10);
    const person = await personnelService.setPersonAccessControlConfig(
      personId,
      req.body || {},
    );
    res.sendSuccess({ success: true, person });
  }),
);

router.delete(
  "/persons/:id",
  authenticate,
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
  requireAdminOrOperator,
  validateIntegers("personId"),
  personnelUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      const err = new Error("請選擇圖片檔案");
      err.statusCode = 400;
      throw err;
    }

    const tempPath = path.join(personnelUploadsDir, req.file.filename);

    // 後端防呆：設備限制（避免僅靠前端驗證）
    if (
      req.file.size != null &&
      Number(req.file.size) > PERSONNEL_FACE_MAX_BYTES
    ) {
      safeUnlink(tempPath);
      const err = new Error("大頭照需小於等於 200KB（設備限制）");
      err.statusCode = 400;
      throw err;
    }

    // 後端防呆：magic bytes 驗證（避免偽造 mimetype/錯誤內容寫成 jpg）
    const header = readFileHeaderBytes(tempPath, 32);
    if (!isJpegByMagicBytes(header)) {
      safeUnlink(tempPath);
      const err = new Error("圖片格式不正確：僅允許 JPEG（JPG）");
      err.statusCode = 400;
      throw err;
    }

    const personId = parseInt(req.params.personId, 10);
    const person = await personnelService.getPersonById(personId);
    // 門禁設備人臉同步以 JPEG 最穩定，後端統一以 .jpg 存檔
    const ext = ".jpg";
    const fullName = person.full_name ?? "";
    const employeeNo = person.employee_no ?? "";
    const desiredName = buildPersonnelFilename(fullName, employeeNo, ext);

    const oldPath = tempPath;
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

    const existingFaceUrl = person.face_url;
    const oldBase =
      existingFaceUrl && typeof existingFaceUrl === "string"
        ? path.basename(existingFaceUrl.trim().replace(/^\//, ""))
        : "";
    const oldFilePath =
      oldBase && !oldBase.includes("..")
        ? path.join(personnelUploadsDir, oldBase)
        : null;

    try {
      const updated = await personnelService.updatePerson(personId, {
        faceUrl,
      });

      // DB 更新成功後再刪除舊檔，降低失敗時不一致風險
      if (
        oldFilePath &&
        oldBase &&
        oldBase !== finalFilename &&
        fs.existsSync(oldFilePath)
      ) {
        try {
          fs.unlinkSync(oldFilePath);
        } catch (err) {
          isapiEventLogger.warn("刪除舊大頭照失敗", {
            path: oldFilePath,
            error: err?.message,
          });
        }
      }

      res.sendSuccess({ faceUrl, person: updated }, 201);
    } catch (err) {
      // 若 DB 更新失敗，移除新檔避免孤兒檔
      try {
        if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
      } catch (cleanupErr) {
        isapiEventLogger.warn("清理新上傳大頭照失敗", {
          path: newPath,
          error: cleanupErr?.message,
        });
      }
      throw err;
    }
  }),
);

// ========== 可同步地點列表 ==========

router.get(
  "/syncable-locations",
  authenticate,
  requirePermission("system.personnel"),
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
  authenticate,
  requirePermission("system.personnel"),
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
  authenticate,
  requirePermission("system.personnel"),
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

    const result = await personnelService.getPersonsByLocationIdPaged(locationId, {
      limit,
      offset,
      status,
      q,
    });
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
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
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
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
  validateIntegers("locationId"),
  asyncHandler(async (req, res) => {
    const { warnings } = await personSyncJobService.syncLocation(
      parseInt(req.params.locationId, 10),
    );
    res.sendSuccess({ success: true, warnings });
  }),
);

// ========== 設備同步（單一地點；背景 job） ==========
// POST /sync-location/:locationId/job -> { jobId } (202)
// GET  /sync-location/jobs/:jobId -> job status/result

router.post(
  "/sync-location/:locationId/job",
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
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
  authenticate,
  requirePermission("system.personnel"),
  asyncHandler(async (req, res) => {
    const job = personSyncJobService.getSyncLocationJob(req.params.jobId);
    if (!job) {
      const err = new Error("同步工作不存在");
      err.statusCode = 404;
      throw err;
    }
    res.sendSuccess(job);
  }),
);

router.post(
  "/sync-all-locations",
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
  asyncHandler(async (req, res) => {
    const job = personSyncJobService.startSyncAllLocationsJob();
    res.sendSuccess({ jobId: job.jobId }, 202);
  }),
);

router.get(
  "/sync-all-locations/jobs/:jobId",
  authenticate,
  requirePermission("system.personnel"),
  asyncHandler(async (req, res) => {
    const job = personSyncJobService.getSyncAllLocationsJob(req.params.jobId);
    if (!job) {
      const err = new Error("同步工作不存在");
      err.statusCode = 404;
      throw err;
    }
    res.sendSuccess(job);
  }),
);

// ========== 批次匯入（Excel + 圖片 zip；單一路由） ==========

// 下載批次匯入範例 Excel（template）
router.get(
  "/import-template",
  authenticate,
  requirePermission("system.personnel"),
  asyncHandler(async (_req, res) => {
    const filename = "personnel_import_template.xlsx";

    const rows = [
      {
        工號: "A0001",
        姓名: "王小明",
        有效起始日: "2026-01-01",
        有效結束日: "2030-12-31",
        門禁密碼: "1234",
        卡號: "0000123456",
      },
      {
        工號: "A0002",
        姓名: "林小華",
        有效起始日: "",
        有效結束日: "",
        門禁密碼: "",
        卡號: "",
      },
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        "工號",
        "姓名",
        "有效起始日",
        "有效結束日",
        "門禁密碼",
        "卡號",
      ],
    });
    XLSX.utils.book_append_sheet(wb, ws, "template");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

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
  authenticate,
  requirePermission("system.personnel"),
  requireAdminOrOperator,
  importUpload.fields([
    { name: "excel", maxCount: 1 },
    { name: "imagesZip", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const excelFile = req.files?.excel?.[0];
    if (!excelFile) {
      const err = new Error("請上傳 Excel 檔（欄位名稱：excel）");
      err.statusCode = 400;
      throw err;
    }
    const zipFile = req.files?.imagesZip?.[0] ?? null;

    const workbook = XLSX.read(excelFile.buffer, {
      type: "buffer",
      cellDates: true,
    });
    const firstSheetName = workbook.SheetNames?.[0];
    if (!firstSheetName) {
      const err = new Error("Excel 無工作表");
      err.statusCode = 400;
      throw err;
    }
    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const zipIndex = new Map();
    if (zipFile) {
      try {
        const zip = new AdmZip(zipFile.buffer);
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue;
          const base = path.basename(entry.entryName);
          if (!base) continue;
          zipIndex.set(base.toLowerCase(), entry);
        }
      } catch {
        const err = new Error("圖片 zip 解析失敗");
        err.statusCode = 400;
        throw err;
      }
    }

    const normalizeKey = (k) =>
      String(k || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj[k] !== undefined) return obj[k];
      }
      const entries = Object.entries(obj || {});
      for (const k of keys) {
        const nk = normalizeKey(k);
        const hit = entries.find(([kk]) => normalizeKey(kk) === nk);
        if (hit) return hit[1];
      }
      return undefined;
    };

    const getEmployeeNoFromRow = (row) =>
      pick(row, ["工號", "員工編號", "employeeNo"]);
    const getFullNameFromRow = (row) =>
      pick(row, ["姓名", "fullName", "名字"]);

    const getValidBeginFromRow = (row) =>
      pick(row, [
        "有效起始日",
        "有效起",
        "有效起始",
        "beginTime",
      ]);
    const getValidEndFromRow = (row) =>
      pick(row, [
        "有效結束日",
        "有效迄",
        "有效結束",
        "endTime",
      ]);
    const getPasswordFromRow = (row) =>
      pick(row, ["門禁密碼", "password", "密碼"]);
    const getCardNoFromRow = (row) => pick(row, ["卡號", "cardNo", "card_no"]);

    // 已改為「地點中心」管理門禁名單：批次匯入不再處理地點權限

    const createdBy = req.user?.id ?? null;
    const created = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const employeeNoRaw = getEmployeeNoFromRow(row);
      const employeeNo =
        employeeNoRaw != null ? String(employeeNoRaw).trim() : "";
      const fullNameRaw = getFullNameFromRow(row);
      const fullName =
        fullNameRaw != null && String(fullNameRaw).trim() !== ""
          ? String(fullNameRaw).trim()
          : null;

      const validBeginRaw = getValidBeginFromRow(row);
      const validEndRaw = getValidEndFromRow(row);
      const passwordRaw = getPasswordFromRow(row);
      const cardNoRaw = getCardNoFromRow(row);

      if (!employeeNo) {
        errors.push({ row: i + 2, message: "員工編號不能為空" }); // +2：含 header
        continue;
      }
      if (!fullName) {
        errors.push({ row: i + 2, employeeNo, message: "姓名為必填" });
        continue;
      }

      try {
        const existing =
          await personnelService.getPersonByEmployeeNo(employeeNo);
        const isUpdate = Boolean(existing && existing.id);

        const person = isUpdate
          ? await personnelService.updatePerson(existing.id, {
              fullName,
            })
          : await personnelService.createPerson(
              {
                employeeNo,
                fullName,
              },
              createdBy,
            );

        created.push({ id: person.id, employeeNo: person.employee_no });

        // 門禁設定（整合寫入：validity/card/fingerprint/password）
        // 規則：
        // - 兩者皆有值：寫入指定有效期限（longTerm=false）
        // - 兩者皆空：若為「新建立」人員，預設寫入長期授權（longTerm=true，由後端補齊 begin/end），避免同步 ISAPI 時缺少有效期限
        //             若為「更新」人員，維持既有 validity（不觸碰既有值）
        {
          const beginStr =
            validBeginRaw != null ? String(validBeginRaw).trim() : "";
          const endStr = validEndRaw != null ? String(validEndRaw).trim() : "";
          const hasBegin = Boolean(beginStr);
          const hasEnd = Boolean(endStr);
          if ((hasBegin && !hasEnd) || (!hasBegin && hasEnd)) {
            const err = new Error(
              "有效期限需同時提供「有效起始日」與「有效結束日」",
            );
            err.statusCode = 400;
            throw err;
          }

          const password =
            passwordRaw != null && String(passwordRaw).trim() !== ""
              ? String(passwordRaw).trim()
              : null;
          const cardNo =
            cardNoRaw != null && String(cardNoRaw).trim() !== ""
              ? String(cardNoRaw).trim()
              : null;

          const shouldDefaultLongTerm = !isUpdate && !hasBegin && !hasEnd;

          const shouldWriteAnything =
            password || cardNo || (hasBegin && hasEnd) || shouldDefaultLongTerm;
          if (shouldWriteAnything) {
            const payload = {
              validity:
                hasBegin && hasEnd
                  ? { longTerm: false, beginTime: beginStr, endTime: endStr }
                  : shouldDefaultLongTerm
                    ? { longTerm: true }
                    : undefined,
              password,
              cardNo,
            };
            await personnelService.setPersonAccessControlConfig(
              person.id,
              payload,
            );
          }
        }

        // 圖片：以工號檔名（employeeNo.jpg/jpeg）嘗試（≤200KB，且需為 JPEG）
        if (zipIndex.size > 0) {
          const candidateNames = [];
          ["jpg", "jpeg"].forEach((ext) =>
            candidateNames.push(`${employeeNo}.${ext}`),
          );
          const entry =
            candidateNames
              .map((n) => zipIndex.get(String(n).toLowerCase()))
              .find(Boolean) || null;

          if (entry) {
            const buffer = entry.getData();
            if (!buffer || buffer.length <= 0) {
              // 單一人的圖片異常不應中斷整批匯入
              continue;
            }
            if (buffer.length > PERSONNEL_FACE_MAX_BYTES) {
              const err = new Error("圖片檔案過大（需 ≤ 200KB）");
              err.statusCode = 400;
              throw err;
            }
            if (!isJpegByMagicBytes(buffer.slice(0, 32))) {
              const err = new Error("圖片格式不正確：僅允許 JPEG（JPG）");
              err.statusCode = 400;
              throw err;
            }

            const desiredName = buildPersonnelFilename(
              fullName ?? "",
              employeeNo,
              ".jpg",
            );
            const finalPath = path.join(personnelUploadsDir, desiredName);
            await fs.promises.writeFile(finalPath, buffer);
            const faceUrl = `/uploads/personnel/${desiredName}`;
            await personnelService.updatePerson(person.id, { faceUrl });
          }
        }
      } catch (err) {
        errors.push({
          row: i + 2,
          employeeNo,
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

// 佈防訂閱狀態（供確認後端是否已實施佈防）
const isapiSubscribeService = require("../services/accessControl/isapiSubscribeService");
router.get(
  "/isapi-subscribe-status",
  authenticate,
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
