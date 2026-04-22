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
    const personId = parseInt(req.params.personId, 10);
    const person = await personnelService.getPersonById(personId);
    const ext = path.extname(req.file.filename);
    const fullName = person.full_name ?? "";
    const employeeNo = person.employee_no ?? "";
    const desiredName = buildPersonnelFilename(fullName, employeeNo, ext);

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

    const existingFaceUrl = person.face_url;
    const oldBase =
      existingFaceUrl && typeof existingFaceUrl === "string"
        ? path.basename(existingFaceUrl.trim().replace(/^\//, ""))
        : "";
    const oldFilePath =
      oldBase && !oldBase.includes("..") ? path.join(personnelUploadsDir, oldBase) : null;

    try {
      const updated = await personnelService.updatePerson(personId, { faceUrl });

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

// ========== 門禁權限（人員 ↔ 地點） ==========

router.get(
  "/persons/:personId/access-locations",
  authenticate,
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
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
  requirePermission("system.personnel"),
  asyncHandler(async (req, res) => {
    const list = await personSyncJobService.getSyncableLocations();
    res.sendSuccess(list);
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
    const groups = await personnelService.getPersonGroups();
    const locations = await personSyncJobService.getSyncableLocations();

    const rows = [
      {
        employeeNo: "A0001",
        fullName: "王小明",
        personGroupName: groups?.[0]?.name || "行政",
        locationNames: locations?.slice(0, 3).map((l) => `${l.zone_name}/${l.name}`).join(",") || "A區/大門,B區/側門",
        imageFileName: "A0001.jpg",
      },
      {
        employeeNo: "A0002",
        fullName: "林小華",
        personGroupName: "",
        locationNames: "",
        imageFileName: "",
      },
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        "employeeNo",
        "fullName",
        "personGroupName",
        "locationNames",
        "imageFileName",
      ],
    });
    XLSX.utils.book_append_sheet(wb, ws, "template");

    const groupSheet = XLSX.utils.json_to_sheet(
      (groups || []).map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description || "",
      })),
      { header: ["id", "name", "description"] },
    );
    XLSX.utils.book_append_sheet(wb, groupSheet, "groups");

    const locationSheet = XLSX.utils.json_to_sheet(
      (locations || []).map((l) => ({
        id: l.id,
        zoneName: l.zone_name,
        locationName: l.name,
        key: `${l.zone_name}/${l.name}`,
      })),
      { header: ["id", "zoneName", "locationName", "key"] },
    );
    XLSX.utils.book_append_sheet(wb, locationSheet, "locations");

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

    const workbook = XLSX.read(excelFile.buffer, { type: "buffer", cellDates: true });
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

    const getImageFilenameFromRow = (row) =>
      pick(row, [
        "image",
        "imageFile",
        "imageFileName",
        "face",
        "faceFile",
        "faceFileName",
        "photo",
        "照片",
        "圖片",
        "大頭照",
      ]);

    const getEmployeeNoFromRow = (row) =>
      pick(row, ["employeeNo", "employee_no", "員工編號", "工號"]);
    const getFullNameFromRow = (row) =>
      pick(row, ["fullName", "full_name", "姓名", "名字"]);
    const getPersonGroupIdFromRow = (row) =>
      pick(row, ["personGroupId", "person_group_id", "groupId", "group_id", "群組id", "群組ID"]);
    const getPersonGroupNameFromRow = (row) =>
      pick(row, ["personGroupName", "person_group_name", "群組名稱", "群組名"]);
    const getLocationNamesFromRow = (row) =>
      pick(row, ["locationNames", "location_names", "地點名稱", "地點名"]);

    const normalizeName = (v) => String(v || "").trim().replace(/\s+/g, " ");

    const parseNameList = (v) => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.map((x) => normalizeName(x)).filter(Boolean);
      const s = String(v).trim();
      if (!s) return [];
      return s
        .split(/[,\|;\n\r]+/g)
        .map((x) => normalizeName(x))
        .filter(Boolean);
    };

    const parseZoneLocationKey = (raw) => {
      const s = normalizeName(raw);
      if (!s) return null;
      if (!s.includes("/")) return null;
      const [zoneName, ...rest] = s.split("/");
      const locationName = normalizeName(rest.join("/"));
      const zn = normalizeName(zoneName);
      if (!zn || !locationName) return null;
      return { zoneName: zn, locationName };
    };

    // 群組名稱 → id（同名視為歧義）
    const groupRows = await personnelService.getPersonGroups();
    const groupNameToId = new Map();
    for (const g of groupRows || []) {
      const key = normalizeKey(g.name);
      if (!key) continue;
      if (groupNameToId.has(key)) groupNameToId.set(key, null);
      else groupNameToId.set(key, g.id);
    }

    // 僅接受 zone/location（區域/地點）→ id
    const syncableLocations = await personSyncJobService.getSyncableLocations();
    const locationKeyToId = new Map();
    for (const l of syncableLocations || []) {
      const key = normalizeKey(`${l.zone_name}/${l.name}`);
      if (key) locationKeyToId.set(key, l.id);
    }

    const createdBy = req.user?.id ?? null;
    const created = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const employeeNoRaw = getEmployeeNoFromRow(row);
      const employeeNo = employeeNoRaw != null ? String(employeeNoRaw).trim() : "";
      const fullNameRaw = getFullNameFromRow(row);
      const fullName =
        fullNameRaw != null && String(fullNameRaw).trim() !== ""
          ? String(fullNameRaw).trim()
          : null;
      const personGroupIdRaw = getPersonGroupIdFromRow(row);
      const personGroupId =
        personGroupIdRaw != null && String(personGroupIdRaw).trim() !== ""
          ? parseInt(String(personGroupIdRaw), 10)
          : null;
      const personGroupNameRaw = getPersonGroupNameFromRow(row);
      const personGroupName =
        personGroupNameRaw != null ? String(personGroupNameRaw).trim() : "";

      const locNameList = parseNameList(getLocationNamesFromRow(row));

      if (!employeeNo) {
        errors.push({ row: i + 2, message: "員工編號不能為空" }); // +2：含 header
        continue;
      }

      try {
        let finalGroupId = personGroupId;
        if (finalGroupId == null && personGroupName) {
          const gid = groupNameToId.get(normalizeKey(personGroupName));
          if (gid === undefined) {
            const err = new Error(`群組不存在：${personGroupName}`);
            err.statusCode = 400;
            throw err;
          }
          if (gid === null) {
            const err = new Error(`群組名稱重複，請改填 personGroupId：${personGroupName}`);
            err.statusCode = 400;
            throw err;
          }
          finalGroupId = gid;
        }

        let finalLocIds = [];
        if (locNameList.length > 0) {
          const resolved = [];
          for (const rawName of locNameList) {
            const parsed = parseZoneLocationKey(rawName);
            if (!parsed) {
              const err = new Error(
                `地點名稱格式錯誤，僅接受「區域/地點」（例如 A區/大門）：${String(rawName)}`,
              );
              err.statusCode = 400;
              throw err;
            }
            const { zoneName, locationName } = parsed;
            const id = locationKeyToId.get(normalizeKey(`${zoneName}/${locationName}`));
            if (!id) {
              const err = new Error(`地點不存在或不可同步：${zoneName}/${locationName}`);
              err.statusCode = 400;
              throw err;
            }
            resolved.push(id);
          }
          finalLocIds = resolved;
        }

        const person = await personnelService.createPerson(
          {
            employeeNo,
            fullName,
            personGroupId: finalGroupId,
          },
          createdBy,
        );
        created.push({ id: person.id, employeeNo: person.employee_no });

        if (finalLocIds.length > 0) {
          await personnelService.setAccessLocationsForPerson(person.id, finalLocIds);
        }

        // 圖片：優先使用 Excel 指定檔名；否則以 employeeNo.* 嘗試
        if (zipIndex.size > 0) {
          const imgNameRaw = getImageFilenameFromRow(row);
          const candidateNames = [];
          if (imgNameRaw != null && String(imgNameRaw).trim() !== "") {
            candidateNames.push(path.basename(String(imgNameRaw).trim()));
          } else {
            ["jpg", "jpeg", "png", "webp"].forEach((ext) =>
              candidateNames.push(`${employeeNo}.${ext}`),
            );
          }
          const entry =
            candidateNames
              .map((n) => zipIndex.get(String(n).toLowerCase()))
              .find(Boolean) || null;

          if (entry) {
            const buffer = entry.getData();
            if (buffer && buffer.length > 0) {
              const extFromZip = path.extname(entry.entryName) || ".jpg";
              const desiredName = buildPersonnelFilename(fullName ?? "", employeeNo, extFromZip);
              const finalPath = path.join(personnelUploadsDir, desiredName);
              await fs.promises.writeFile(finalPath, buffer);
              const faceUrl = `/uploads/personnel/${desiredName}`;
              await personnelService.updatePerson(person.id, { faceUrl });
            }
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
