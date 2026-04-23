/**
 * 人員門禁同步服務（同步執行，無佇列）
 * 依 person_location_access 取得有權限人員，對地點綁定之入口/出口設備同步：新增、更新（姓名與人臉）、刪除。資料有更新即同步到設備。
 */
const path = require("path");
const fs = require("fs").promises;
const db = require("../../database/db");
const accessControlService = require("../accessControl/accessControlService");
const personnelService = require("./personnelService");
const logger = require("../../utils/logger").createLogger("PersonSyncService");
const personDeviceSyncStateService = require("./personDeviceSyncStateService");

const SYNC_DELAY_MS = 300;

// ========== sync-all 背景工作（In-memory，重啟即失效） ==========
// 需求：避免長時間同步造成 HTTP timeout；前端以 jobId 輪詢進度/結果。
const syncAllJobs = new Map();
const JOB_TTL_MS = 1000 * 60 * 30; // 30 分鐘

// ========== sync-location 背景工作（In-memory，重啟即失效） ==========
// 需求：單一地點同步也可能因設備延遲造成 HTTP timeout，改為以 jobId 輪詢。
const syncLocationJobs = new Map();

const MAX_JOB_ITEMS = 5000;

function randomJobId() {
  return `syncall_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of syncAllJobs.entries()) {
    if (!job?.createdAt || now - job.createdAt > JOB_TTL_MS) {
      syncAllJobs.delete(id);
    }
  }

  for (const [id, job] of syncLocationJobs.entries()) {
    if (!job?.createdAt || now - job.createdAt > JOB_TTL_MS) {
      syncLocationJobs.delete(id);
    }
  }
}

function createValidationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function toMessage(err) {
  return err?.message ?? String(err);
}

function pushJobItem(job, item) {
  if (!job) return;
  if (!Array.isArray(job.items)) job.items = [];
  if (job.items.length >= MAX_JOB_ITEMS) return;
  job.items.push(item);
}

function withLocationId(job, item, locationId) {
  if (locationId == null) return item;
  return { ...item, locationId: Number(locationId) };
}

function createLocationJobReporter(job, locationId = null) {
  const locId = locationId != null ? Number(locationId) : job?.locationId != null ? Number(job.locationId) : null;
  const bump = (key, n = 1) => {
    if (!job?.progress) return;
    job.progress[key] = (Number(job.progress[key]) || 0) + n;
  };
  const set = (key, v) => {
    if (!job?.progress) return;
    job.progress[key] = v;
  };

  const startOp = ({ employeeNo, deviceId, action, stage }) => {
    const startedAt = Date.now();
    bump("attempted", 1);
    set("currentDeviceId", deviceId ?? null);
    set("currentEmployeeNo", employeeNo ?? null);
    set("currentAction", action ?? null);
    set("currentStage", stage ?? null);
    pushJobItem(
      job,
      withLocationId(job, {
        employeeNo,
        deviceId,
        action,
        stage,
        status: "running",
        startedAt,
        finishedAt: null,
        message: null,
      }, locId),
    );
    return startedAt;
  };

  const finishOp = ({ employeeNo, deviceId, action, stage, startedAt, ok, message }) => {
    bump("completed", 1);
    if (ok === "skipped") bump("skipped", 1);
    else if (ok) bump("succeeded", 1);
    else bump("failed", 1);
    // 直接 append completed item（避免搜尋/更新成本）
    pushJobItem(
      job,
      withLocationId(job, {
        employeeNo,
        deviceId,
        action,
        stage,
        status: ok === "skipped" ? "skipped" : ok ? "success" : "failed",
        startedAt: startedAt ?? Date.now(),
        finishedAt: Date.now(),
        message: message ?? null,
      }, locId),
    );
  };

  const skipOp = ({ employeeNo, deviceId, action, stage, message }) => {
    bump("attempted", 1);
    finishOp({
      employeeNo,
      deviceId,
      action,
      stage,
      startedAt: Date.now(),
      ok: "skipped",
      message: message ?? "已同步且未變更，略過",
    });
  };

  const markDevice = ({ deviceId, deviceIndex, deviceTotal }) => {
    set("currentDeviceId", deviceId ?? null);
    if (deviceIndex != null) set("currentDeviceIndex", deviceIndex);
    if (deviceTotal != null) set("deviceTotal", deviceTotal);
  };

  const setTotals = ({ totalOps, targetPersonsTotal, deviceTotal }) => {
    if (totalOps != null) set("total", totalOps);
    if (targetPersonsTotal != null) set("targetPersonsTotal", targetPersonsTotal);
    if (deviceTotal != null) set("deviceTotal", deviceTotal);
  };

  return { startOp, finishOp, skipOp, markDevice, setTotals };
}

/** 僅寫入 items（不更新整體 job.progress），用於「同步全部」彙總多個地點的逐人步驟 */
function createAllLocationsItemReporter(rootJob, locationId) {
  if (!Array.isArray(rootJob.items)) rootJob.items = [];
  const locId = Number(locationId);
  const startOp = ({ employeeNo, deviceId, action, stage }) => {
    const startedAt = Date.now();
    pushJobItem(
      rootJob,
      {
        locationId: locId,
        employeeNo,
        deviceId,
        action,
        stage,
        status: "running",
        startedAt,
        finishedAt: null,
        message: null,
      },
    );
    return startedAt;
  };
  const finishOp = ({ employeeNo, deviceId, action, stage, startedAt, ok, message }) => {
    pushJobItem(
      rootJob,
      {
        locationId: locId,
        employeeNo,
        deviceId,
        action,
        stage,
        status: ok === "skipped" ? "skipped" : ok ? "success" : "failed",
        startedAt: startedAt ?? Date.now(),
        finishedAt: Date.now(),
        message: message ?? null,
      },
    );
  };
  const skipOp = ({ employeeNo, deviceId, action, stage, message }) => {
    finishOp({
      employeeNo,
      deviceId,
      action,
      stage,
      startedAt: Date.now(),
      ok: "skipped",
      message: message ?? "已同步且未變更，略過",
    });
  };
  const noOp = () => {};
  return { startOp, finishOp, skipOp, setTotals: noOp, markDevice: noOp };
}

/**
 * 取得地點的 people_counting 設定（entry/exit 門禁設備 ID）
 */
async function getPeopleCountingDevicesForLocation(locationId) {
  const rows = await db.query(
    "SELECT system_config FROM location_systems WHERE location_id = ? AND system_type = 'people_counting' LIMIT 1",
    [locationId],
  );
  if (!rows || rows.length === 0) return null;
  const config = rows[0].system_config;
  const raw = typeof config === "string" ? JSON.parse(config) : config || {};
  const entryDeviceIds = Array.isArray(raw.entry_device_ids) ? raw.entry_device_ids : [];
  const exitDeviceIds = Array.isArray(raw.exit_device_ids) ? raw.exit_device_ids : [];
  if (entryDeviceIds.length === 0) return null;
  return {
    entryDeviceIds: entryDeviceIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0),
    exitDeviceIds: exitDeviceIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0),
  };
}

async function getLocationName(locationId) {
  const rows = await db.query("SELECT name FROM locations WHERE id = ? LIMIT 1", [locationId]);
  return rows?.[0]?.name ?? null;
}

/**
 * 取得所有可同步的地點（people_counting 且具 entry_device_ids）
 */
async function getSyncableLocations() {
  const rows = await db.query(
    `SELECT l.id, l.name, z.name AS zone_name
     FROM locations l
     INNER JOIN zones z ON l.zone_id = z.id
     INNER JOIN location_systems ls ON l.id = ls.location_id AND ls.system_type = 'people_counting'
     WHERE COALESCE(jsonb_array_length(ls.system_config->'entry_device_ids'), 0) > 0
     ORDER BY z.name, l.name`,
    [],
  );
  return rows || [];
}

/**
 * 取得設備上所有人員的 employeeNo 列表（分頁取完）
 */
async function fetchAllEmployeeNosFromDevice(deviceId) {
  const result = [];
  let position = 0;
  const maxResults = 50;
  for (;;) {
    const res = await accessControlService.searchUserInfo(deviceId, {
      searchResultPosition: position,
      maxResults,
    });
    const list = res.list || [];
    for (const u of list) {
      if (u.employeeNo != null) result.push(String(u.employeeNo));
    }
    const total = res.totalMatches ?? 0;
    position += list.length;
    if (list.length === 0 || position >= total) break;
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 平台 validity（config.access_control.validity）→ 設備 Valid payload
 * 規則（SSOT）：
 * - longTerm=true  => enable=false
 * - longTerm=false => enable=true
 * - begin/end 若缺漏：補 todayT00:00:00 ~ 2035-12-31T23:59:59（避免同步失敗）
 */
function buildDeviceValidPayloadFromPlatformValidity(validity) {
  const v = validity && typeof validity === "object" ? validity : null;
  const longTerm = v?.longTerm != null ? Boolean(v.longTerm) : true;
  const enable = longTerm ? false : true;
  const beginTime = v?.beginTime != null ? String(v.beginTime).trim() : "";
  const endTime = v?.endTime != null ? String(v.endTime).trim() : "";
  if (beginTime && endTime) return { enable, beginTime, endTime };
  const today = new Date().toISOString().slice(0, 10);
  return { enable, beginTime: `${today}T00:00:00`, endTime: "2035-12-31T23:59:59" };
}

/**
 * 將 face_url 解析為圖片 Buffer
 * 支援：data:image/...;base64,xxx、/uploads/xxx、http(s) URL
 */
async function resolveFaceUrlToBuffer(faceUrl) {
  if (!faceUrl || typeof faceUrl !== "string") return null;
  const trimmed = faceUrl.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("data:image") && trimmed.includes("base64,")) {
      const base64 = trimmed.split("base64,")[1];
      if (base64) return Buffer.from(base64, "base64");
    }
    if (trimmed.startsWith("/uploads/")) {
      const fullPath = path.join(process.cwd(), trimmed.replace(/^\//, ""));
      return await fs.readFile(fullPath);
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const res = await fetch(trimmed, { method: "GET" });
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
  } catch (err) {
    logger.warn("解析 face_url 失敗", { faceUrl: trimmed.substring(0, 50), error: err.message });
  }
  return null;
}

/**
 * 將單一人員的資料與人臉同步至設備（UserInfo + 人臉）；失敗時寫 log 並推入 warnings
 * @param {number} deviceId
 * @param {{ employeeNo: string, name: string, face_url: string|null, config?: any }} person
 * @param {Array<{ type: string, employeeNo?: string, deviceId?: number, message: string }>} warnings
 * @param {{ startOp: Function, finishOp: Function } | null} reporter
 */
async function syncPersonToDevice(deviceId, person, warnings, reporter = null, options = {}) {
  const forceUserInfo = Boolean(options?.forceUserInfo);
  const stateByEmployeeNo = reporter?.__stateByEmployeeNo || null;
  const stateRow =
    stateByEmployeeNo && person?.employeeNo != null
      ? stateByEmployeeNo.get(String(person.employeeNo)) || null
      : null;

  const cfg =
    person?.config && typeof person.config === "string"
      ? JSON.parse(person.config)
      : person?.config;
  const ac = cfg?.access_control || {};
  const faceUrlRaw = person?.face_url != null ? String(person.face_url).trim() : "";

  const validPayload = buildDeviceValidPayloadFromPlatformValidity(ac?.validity);

  const passwordForHash =
    ac?.password != null && String(ac.password).trim() !== ""
      ? String(ac.password).trim()
      : null;

  const userInfoHash = personDeviceSyncStateService.hashUserInfo({
    employeeNo: person.employeeNo,
    name: person.name,
    valid: validPayload,
    password: passwordForHash,
  });

  {
    const lastHash = stateRow?.user_info_hash ? String(stateRow.user_info_hash) : null;
    const lastStatus = stateRow?.user_info_status ? String(stateRow.user_info_status) : null;
    if (!forceUserInfo && lastStatus === "success" && lastHash && lastHash === userInfoHash) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "userInfo",
        message: "人員資料未變更，略過",
      });
    } else {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: person.employeeNo,
            deviceId,
            action: "sync",
            stage: "userInfo",
          })
        : null;
    try {
      const password = passwordForHash;

      await accessControlService.updateUserInfo(deviceId, {
        employeeNo: person.employeeNo,
        name: person.name,
        Valid: validPayload,
        ...(password ? { password } : {}),
      });
      await delay(SYNC_DELAY_MS);
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "userInfo",
        status: "success",
        hash: userInfoHash,
        syncedAt: new Date(),
        lastErrorMessage: null,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "userInfo",
        startedAt,
        ok: true,
      });
    } catch (err) {
      const message = toMessage(err);
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "userInfo",
        status: "failed",
        hash: userInfoHash,
        syncedAt: new Date(),
        lastErrorMessage: message,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "userInfo",
        startedAt,
        ok: false,
        message,
      });
      throw err;
    }
    }
  }

  const imageBuffer = await resolveFaceUrlToBuffer(person.face_url);
  if (faceUrlRaw && (!imageBuffer || imageBuffer.length === 0)) {
    const message = "平台大頭照無法讀取（檔案可能遺失或 URL 無效）";
    logger.warn("解析 face_url 失敗（略過人臉寫入）", {
      deviceId,
      employeeNo: person.employeeNo,
      face_url: faceUrlRaw.substring(0, 80),
    });
    warnings.push({ type: "face", employeeNo: person.employeeNo, deviceId, message });
    const startedAt = reporter?.startOp
      ? reporter.startOp({
          employeeNo: person.employeeNo,
          deviceId,
          action: "sync",
          stage: "face",
        })
      : null;
    await personDeviceSyncStateService.upsertStepState({
      deviceId,
      employeeNo: person.employeeNo,
      step: "face",
      status: "failed",
      hash: personDeviceSyncStateService.hashFace({ faceBuffer: null, faceUrl: faceUrlRaw }),
      syncedAt: new Date(),
      lastErrorMessage: message,
    });
    reporter?.finishOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "face",
      startedAt,
      ok: false,
      message,
    });
  }
  if (imageBuffer && imageBuffer.length > 0) {
    // 以 face_url 作為 SSOT 來判斷是否需同步（避免 needsSync 與同步寫入的 hash 算法不一致）
    // 注意：平台上傳/匯入圖片通常會產生新檔名（face_url 變更），可觸發重新同步。
    const faceHash = personDeviceSyncStateService.hashFace({
      faceBuffer: null,
      faceUrl: person.face_url,
    });
    const lastHash = stateRow?.face_hash ? String(stateRow.face_hash) : null;
    const lastStatus = stateRow?.face_status ? String(stateRow.face_status) : null;
    if (lastStatus === "success" && lastHash && faceHash && lastHash === faceHash) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "face",
        message: "人臉未變更，略過",
      });
    } else {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: person.employeeNo,
            deviceId,
            action: "sync",
            stage: "face",
          })
        : null;
    try {
      await accessControlService.updateFace(deviceId, person.employeeNo, imageBuffer);
      await delay(SYNC_DELAY_MS);
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "face",
        status: "success",
        hash: faceHash,
        syncedAt: new Date(),
        lastErrorMessage: null,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "face",
        startedAt,
        ok: true,
      });
    } catch (faceErr) {
      const message = toMessage(faceErr);
      logger.warn("ISAPI 更新人臉失敗", { deviceId, employeeNo: person.employeeNo, error: message });
      warnings.push({ type: "face", employeeNo: person.employeeNo, deviceId, message });
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "face",
        status: "failed",
        hash: faceHash,
        syncedAt: new Date(),
        lastErrorMessage: message,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "face",
        startedAt,
        ok: false,
        message,
      });
    }
    }
  }

  // 卡片同步：employeeNo -> cardNo
  const cardNo = ac?.cardNo != null ? String(ac.cardNo).trim() : "";
  if (cardNo) {
    const cardHash = personDeviceSyncStateService.hashCard({ cardNo });
    const lastHash = stateRow?.card_hash ? String(stateRow.card_hash) : null;
    const lastStatus = stateRow?.card_status ? String(stateRow.card_status) : null;
    if (lastStatus === "success" && lastHash && cardHash && lastHash === cardHash) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "card",
        message: "卡片未變更，略過",
      });
    } else {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: person.employeeNo,
            deviceId,
            action: "sync",
            stage: "card",
          })
        : null;
    try {
      await accessControlService.setCardInfo(deviceId, {
        employeeNo: person.employeeNo,
        cardNo,
        cardType: "normalCard",
      });
      await delay(SYNC_DELAY_MS);
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "card",
        status: "success",
        hash: cardHash,
        syncedAt: new Date(),
        lastErrorMessage: null,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "card",
        startedAt,
        ok: true,
      });
    } catch (cardErr) {
      const message = toMessage(cardErr);
      logger.warn("ISAPI 綁定卡片失敗", { deviceId, employeeNo: person.employeeNo, error: message });
      warnings.push({ type: "card", employeeNo: person.employeeNo, deviceId, message: `卡片設定失敗：${message}` });
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "card",
        status: "failed",
        hash: cardHash,
        syncedAt: new Date(),
        lastErrorMessage: message,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "card",
        startedAt,
        ok: false,
        message,
      });
    }
    }
  }

  // 指紋同步：FingerPrint/SetUp
  const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
  const fingerprintHash = personDeviceSyncStateService.hashFingerprint({ fingerprints: fps });
  const lastFpHash = stateRow?.fingerprint_hash ? String(stateRow.fingerprint_hash) : null;
  const lastFpStatus = stateRow?.fingerprint_status ? String(stateRow.fingerprint_status) : null;
  const fpDetailRaw = stateRow?.fingerprint_detail;
  const fpDetail =
    fpDetailRaw && typeof fpDetailRaw === "string"
      ? (() => {
          try {
            return JSON.parse(fpDetailRaw);
          } catch {
            return null;
          }
        })()
      : fpDetailRaw && typeof fpDetailRaw === "object"
        ? fpDetailRaw
        : null;

  const hasAnyFpTemplate = fps.some((fp) => String(fp?.fingerData || "").trim() !== "");
  const canSkipWholeFingerprint =
    hasAnyFpTemplate &&
    lastFpStatus === "success" &&
    fingerprintHash &&
    lastFpHash === fingerprintHash &&
    !fpDetail; // 若已有 detail，改用逐 ID 方式

  let anyFpFailed = false;
  let anyFpTouched = false;
  if (canSkipWholeFingerprint) {
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "fingerprint",
      message: "指紋未變更，略過",
    });
    return;
  }

  for (const fp of fps) {
    const fingerData = fp?.fingerData != null ? String(fp.fingerData).trim() : "";
    const fingerPrintID = Number(fp?.fingerPrintID) || 1;
    if (!fingerData) continue;

    const tplHash = personDeviceSyncStateService.hashFingerprintTemplate({
      fingerPrintID,
      fingerType: fp?.fingerType,
      fingerData,
    });
    const prev =
      fpDetail && typeof fpDetail === "object" ? fpDetail[String(fingerPrintID)] : null;
    const prevHash = prev?.hash != null ? String(prev.hash) : null;
    const prevStatus = prev?.status != null ? String(prev.status) : null;
    if (prevStatus === "success" && prevHash && tplHash && prevHash === tplHash) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: `fingerprint:${fingerPrintID}`,
        message: "指紋未變更，略過",
      });
      continue;
    }

    const startedAt = reporter?.startOp
      ? reporter.startOp({
          employeeNo: person.employeeNo,
          deviceId,
          action: "sync",
          stage: `fingerprint:${fingerPrintID}`,
        })
      : null;
    try {
      await accessControlService.setFingerPrint(deviceId, {
        employeeNo: person.employeeNo,
        fingerPrintID,
        fingerType: fp?.fingerType || "normalFP",
        fingerData,
        enableCardReader: Array.isArray(fp?.enableCardReader) ? fp.enableCardReader : [1],
      });
      await delay(SYNC_DELAY_MS);
      anyFpTouched = true;
      await personDeviceSyncStateService.upsertFingerprintDetailState({
        deviceId,
        employeeNo: person.employeeNo,
        fingerPrintID,
        status: "success",
        hash: tplHash,
        syncedAt: new Date(),
        lastErrorMessage: null,
      });
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "fingerprint",
        status: "success",
        hash: fingerprintHash,
        syncedAt: new Date(),
        lastErrorMessage: null,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: `fingerprint:${fingerPrintID}`,
        startedAt,
        ok: true,
      });
    } catch (fpErr) {
      const message = toMessage(fpErr);
      logger.warn("ISAPI 綁定指紋失敗", { deviceId, employeeNo: person.employeeNo, fingerPrintID, error: message });
      warnings.push({ type: "fingerprint", employeeNo: person.employeeNo, deviceId, message: `指紋設定失敗：${message}` });
      anyFpFailed = true;
      anyFpTouched = true;
      await personDeviceSyncStateService.upsertFingerprintDetailState({
        deviceId,
        employeeNo: person.employeeNo,
        fingerPrintID,
        status: "failed",
        hash: tplHash,
        syncedAt: new Date(),
        lastErrorMessage: message,
      });
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "fingerprint",
        status: "failed",
        hash: fingerprintHash,
        syncedAt: new Date(),
        lastErrorMessage: message,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: `fingerprint:${fingerPrintID}`,
        startedAt,
        ok: false,
        message,
      });
    }
  }
}

/**
 * 對單一地點執行同步：目標名單為來源，設備與之對齊（新增/更新姓名與人臉、刪除多餘）
 * @returns {{ warnings: Array<{ type: string, employeeNo?: string, deviceId?: number, message: string }> }}
 */
async function syncLocation(locationId, reporter = null) {
  const warnings = [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  if (!devs) throw createValidationError("該地點未設定人流門禁入口設備");

  const persons = await personnelService.getPersonsWithAccessByLocationId(locationId);
  const targetEmployeeNos = new Set(persons.map((p) => String(p.employee_no)));
  const targetList = persons.map((p) => ({
    employeeNo: String(p.employee_no),
    name: p.full_name || p.employee_no,
    face_url: p.face_url || null,
    config: p.config || null,
  }));

  const deviceIds = [...new Set([...(devs.entryDeviceIds || []), ...(devs.exitDeviceIds || [])])];
  reporter?.setTotals?.({
    targetPersonsTotal: targetList.length,
    deviceTotal: deviceIds.length,
  });

  // total ops：每台設備的 add + sync + delete（delete 以 employeeNo 筆數計）
  let estimatedTotalOps = 0;
  const deviceTargets = new Map();
  for (const deviceId of deviceIds) {
    try {
      const currentEmployeeNos = new Set(await fetchAllEmployeeNosFromDevice(deviceId));
      const toSync = targetList.filter((p) => currentEmployeeNos.has(p.employeeNo));
      const toAdd = targetList.filter((p) => !currentEmployeeNos.has(p.employeeNo));
      const toDelete = [...currentEmployeeNos].filter((no) => !targetEmployeeNos.has(no));
      deviceTargets.set(deviceId, { currentEmployeeNos, toSync, toAdd, toDelete });
      estimatedTotalOps += toAdd.length + toSync.length + toDelete.length;
    } catch (err) {
      // 讀取清單失敗的設備會跳過，totalOps 先不加
      deviceTargets.set(deviceId, { currentEmployeeNos: null, toSync: [], toAdd: [], toDelete: [] });
    }
  }
  reporter?.setTotals?.({ totalOps: estimatedTotalOps });

  for (let i = 0; i < deviceIds.length; i++) {
    const deviceId = deviceIds[i];
    reporter?.markDevice?.({ deviceId, deviceIndex: i + 1, deviceTotal: deviceIds.length });

    // 同步狀態（用於差異同步）：一次性抓取該設備下此地點所有目標人員的狀態
    const stateMap = await personDeviceSyncStateService.getStatesForDevice(
      deviceId,
      targetList.map((p) => p.employeeNo),
    );
    if (reporter && typeof reporter === "object") {
      reporter.__stateByEmployeeNo = stateMap;
    }

    let currentEmployeeNos;
    try {
      const cached = deviceTargets.get(deviceId);
      currentEmployeeNos = cached?.currentEmployeeNos ? cached.currentEmployeeNos : new Set(await fetchAllEmployeeNosFromDevice(deviceId));
    } catch (err) {
      const message = toMessage(err);
      logger.warn("ISAPI 讀取設備人員清單失敗（跳過該設備）", { deviceId, error: message });
      warnings.push({ type: "sync", deviceId, message: `讀取設備人員清單失敗：${message}` });
      continue;
    }

    const cached = deviceTargets.get(deviceId);
    const toSync = cached?.toSync?.length != null ? cached.toSync : targetList.filter((p) => currentEmployeeNos.has(p.employeeNo));
    const toAdd = cached?.toAdd?.length != null ? cached.toAdd : targetList.filter((p) => !currentEmployeeNos.has(p.employeeNo));
    const toDelete = cached?.toDelete?.length != null ? cached.toDelete : [...currentEmployeeNos].filter((no) => !targetEmployeeNos.has(no));

    for (const p of toAdd) {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: p.employeeNo,
            deviceId,
            action: "add",
            stage: "person",
          })
        : null;
      try {
        // toAdd：代表設備端不存在該人員，即使 hash 沒變也不能略過（否則會「顯示成功但設備沒收到」）
        await syncPersonToDevice(deviceId, p, warnings, reporter, { forceUserInfo: true });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "add",
          stage: "person",
          startedAt,
          ok: true,
        });
      } catch (err) {
        const message = toMessage(err);
        logger.warn("ISAPI 新增人員失敗", { deviceId, employeeNo: p.employeeNo, error: message });
        warnings.push({ type: "add", employeeNo: p.employeeNo, deviceId, message: `新增失敗：${message}` });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "add",
          stage: "person",
          startedAt,
          ok: false,
          message,
        });
      }
    }

    for (const p of toSync) {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: p.employeeNo,
            deviceId,
            action: "update",
            stage: "person",
          })
        : null;
      try {
        await syncPersonToDevice(deviceId, p, warnings, reporter);
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "update",
          stage: "person",
          startedAt,
          ok: true,
        });
      } catch (err) {
        const message = toMessage(err);
        logger.warn("ISAPI 更新人員失敗", { deviceId, employeeNo: p.employeeNo, error: message });
        warnings.push({ type: "update", employeeNo: p.employeeNo, deviceId, message: `更新失敗：${message}` });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "update",
          stage: "person",
          startedAt,
          ok: false,
          message,
        });
      }
    }

    if (toDelete.length > 0) {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: null,
            deviceId,
            action: "delete",
            stage: `batch:${toDelete.length}`,
          })
        : null;
      try {
        await accessControlService.deleteUserInfo(deviceId, { employeeNoList: toDelete });
        await delay(SYNC_DELAY_MS);
        reporter?.finishOp?.({
          employeeNo: null,
          deviceId,
          action: "delete",
          stage: `batch:${toDelete.length}`,
          startedAt,
          ok: true,
        });

        // UI 需要逐筆結果（但刪除是 batch），成功時以同一批次訊息標記每個 employeeNo
        for (const no of toDelete) {
          const st = reporter?.startOp
            ? reporter.startOp({
                employeeNo: String(no),
                deviceId,
                action: "delete",
                stage: "person",
              })
            : null;
          reporter?.finishOp?.({
            employeeNo: String(no),
            deviceId,
            action: "delete",
            stage: "person",
            startedAt: st,
            ok: true,
          });
        }

        // 同步狀態清理：人員已從設備刪除，避免未來誤用舊的 success/hash 判定「略過」
        try {
          await db.query(
            `UPDATE person_device_sync_states
             SET user_info_status = NULL,
                 user_info_hash = NULL,
                 user_info_synced_at = NULL,
                 face_status = NULL,
                 face_hash = NULL,
                 face_synced_at = NULL,
                 card_status = NULL,
                 card_hash = NULL,
                 card_synced_at = NULL,
                 fingerprint_status = NULL,
                 fingerprint_hash = NULL,
                 fingerprint_synced_at = NULL,
                 fingerprint_detail = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE device_id = ? AND employee_no = ANY(?::text[])`,
            [Number(deviceId), toDelete.map((x) => String(x))],
          );
        } catch (_e) {
          // ignore cleanup failure; do not affect sync result
        }
      } catch (err) {
        const message = toMessage(err);
        logger.warn("ISAPI 刪除人員失敗", { deviceId, count: toDelete.length, error: message });
        warnings.push({ type: "delete", deviceId, message: `刪除失敗：${message}` });
        reporter?.finishOp?.({
          employeeNo: null,
          deviceId,
          action: "delete",
          stage: `batch:${toDelete.length}`,
          startedAt,
          ok: false,
          message,
        });

        for (const no of toDelete) {
          const st = reporter?.startOp
            ? reporter.startOp({
                employeeNo: String(no),
                deviceId,
                action: "delete",
                stage: "person",
              })
            : null;
          reporter?.finishOp?.({
            employeeNo: String(no),
            deviceId,
            action: "delete",
            stage: "person",
            startedAt: st,
            ok: false,
            message,
          });
        }
      }
    }

    if (reporter && typeof reporter === "object") {
      reporter.__stateByEmployeeNo = null;
    }
  }

  logger.info("同步完成", { locationId, warningsCount: warnings.length });
  return { warnings };
}

function startSyncLocationJob(locationId) {
  cleanupOldJobs();
  const jobId = `syncloc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const job = {
    jobId,
    locationId: Number(locationId),
    locationName: null,
    status: "queued", // queued | running | completed
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: {
      total: 0,
      attempted: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      deviceTotal: 0,
      currentDeviceIndex: 0,
      currentDeviceId: null,
      targetPersonsTotal: 0,
      currentEmployeeNo: null,
      currentAction: null,
      currentStage: null,
    },
    items: [],
    result: null,
    error: null,
  };
  syncLocationJobs.set(jobId, job);

  (async () => {
    job.status = "running";
    job.startedAt = Date.now();
    try {
      job.locationName = await getLocationName(job.locationId);
      const reporter = createLocationJobReporter(job, job.locationId);
      const result = await syncLocation(job.locationId, reporter);
      job.result = result;
      job.status = "completed";
      job.finishedAt = Date.now();
      job.progress.currentDeviceId = null;
      job.progress.currentEmployeeNo = null;
      job.progress.currentAction = null;
      job.progress.currentStage = null;
    } catch (err) {
      job.status = "completed";
      job.finishedAt = Date.now();
      job.error = { message: toMessage(err) };
      job.progress.currentDeviceId = null;
      job.progress.currentEmployeeNo = null;
      job.progress.currentAction = null;
      job.progress.currentStage = null;
    }
  })();

  return { jobId };
}

function getSyncLocationJob(jobId) {
  cleanupOldJobs();
  const job = syncLocationJobs.get(String(jobId));
  if (!job) return null;
  return job;
}

/**
 * 對所有可同步地點依序執行同步
 * @returns {Promise<{ synced: number, results: Array<{ locationId: number, locationName?: string, warnings: Array }> }>}
 */
async function syncAllLocations() {
  const locations = await getSyncableLocations();
  const results = [];
  for (const loc of locations) {
    try {
      const { warnings } = await syncLocation(loc.id, null);
      results.push({ locationId: loc.id, locationName: loc.name, warnings });
    } catch (err) {
      const message = toMessage(err);
      logger.warn("同步地點失敗，跳過", { locationId: loc.id, error: message });
      results.push({
        locationId: loc.id,
        locationName: loc.name,
        warnings: [{ type: "sync", message }],
      });
    }
  }
  return { synced: results.length, results };
}

async function getSyncCandidatesForLocation(locationId) {
  const rows = await personnelService.getPersonsWithAccessByLocationId(locationId);
  const list = Array.isArray(rows) ? rows : [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  const deviceIds = devs
    ? [...new Set([...(devs.entryDeviceIds || []), ...(devs.exitDeviceIds || [])])]
    : [];

  const employeeNos = list.map((p) => String(p.employee_no));
  const stateMaps = [];
  for (const did of deviceIds) {
    stateMaps.push({
      deviceId: did,
      map: await personDeviceSyncStateService.getStatesForDevice(did, employeeNos),
    });
  }

  const aggStep = (eno, step) => {
    const rows = stateMaps
      .map(({ deviceId, map }) => ({ deviceId, row: map.get(String(eno)) || null }))
      .filter((x) => x.row);
    if (rows.length === 0) return { status: "never", at: null };
    const statusKey =
      step === "userInfo"
        ? "user_info_status"
        : step === "face"
          ? "face_status"
          : step === "card"
            ? "card_status"
            : "fingerprint_status";
    const atKey =
      step === "userInfo"
        ? "user_info_synced_at"
        : step === "face"
          ? "face_synced_at"
          : step === "card"
            ? "card_synced_at"
            : "fingerprint_synced_at";
    let lastAt = null;
    let hasFailed = false;
    let hasSuccess = false;
    let successCount = 0;
    for (const r of rows) {
      const st = r.row?.[statusKey] != null ? String(r.row[statusKey]) : "";
      if (st === "failed") hasFailed = true;
      if (st === "success") {
        hasSuccess = true;
        successCount += 1;
      }
      const t = r.row?.[atKey] ? new Date(r.row[atKey]).getTime() : null;
      if (t != null && (lastAt == null || t > lastAt)) lastAt = t;
    }
    if (hasFailed) return { status: "failed", at: lastAt };
    // 跨多設備：全部設備都 success 才算 success；否則視為 partial（代表有些設備未同步過）
    if (hasSuccess && successCount === rows.length) return { status: "success", at: lastAt };
    if (hasSuccess && successCount < rows.length) return { status: "partial", at: lastAt };
    return { status: "never", at: lastAt };
  };

  const buildNeedsSync = (person) => {
    let cfg = person?.config;
    if (typeof cfg === "string") {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = null;
      }
    }
    const ac = (cfg && typeof cfg === "object" ? cfg : {}).access_control || {};
    const employeeNo = String(person.employee_no);
    const fullName = person.full_name || person.employee_no;

    const valid = buildDeviceValidPayloadFromPlatformValidity(ac?.validity);
    const password = ac?.password != null && String(ac.password).trim() !== "" ? String(ac.password).trim() : null;
    const desiredUserInfoHash = personDeviceSyncStateService.hashUserInfo({
      employeeNo,
      name: fullName,
      valid,
      password,
    });

    const faceUrl = person?.face_url != null ? String(person.face_url).trim() : "";
    const desiredFaceHash = faceUrl
      ? personDeviceSyncStateService.hashFace({ faceBuffer: null, faceUrl })
      : null;

    const cardNo = ac?.cardNo != null ? String(ac.cardNo).trim() : "";
    const desiredCardHash = cardNo ? personDeviceSyncStateService.hashCard({ cardNo }) : null;

    const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
    const desiredFpHash = personDeviceSyncStateService.hashFingerprint({ fingerprints: fps });

    const steps = new Set();
    for (const { map } of stateMaps) {
      const row = map.get(employeeNo) || null;
      // 若該設備完全沒有紀錄，一律視為需同步（避免「後來加資料但仍顯示成功」）
      if (!row) {
        steps.add("userInfo");
        if (faceUrl) steps.add("face");
        if (cardNo) steps.add("card");
        if (desiredFpHash) steps.add("fingerprint");
        continue;
      }

      const userOk = String(row.user_info_status || "") === "success" && String(row.user_info_hash || "") === desiredUserInfoHash;
      if (!userOk) steps.add("userInfo");

      if (faceUrl) {
        const faceOk = String(row.face_status || "") === "success" && String(row.face_hash || "") === String(desiredFaceHash || "");
        if (!faceOk) steps.add("face");
      }

      if (cardNo) {
        const cardOk = String(row.card_status || "") === "success" && String(row.card_hash || "") === String(desiredCardHash || "");
        if (!cardOk) steps.add("card");
      }

      if (desiredFpHash) {
        const fpOk =
          String(row.fingerprint_status || "") === "success" &&
          String(row.fingerprint_hash || "") === String(desiredFpHash || "");
        if (!fpOk) steps.add("fingerprint");
      }
    }

    const needsSyncSteps = Array.from(steps);
    return { needsSync: needsSyncSteps.length > 0, needsSyncSteps };
  };

  return list.map((p) => {
    let cfg = p?.config;
    if (typeof cfg === "string") {
      try {
        cfg = JSON.parse(cfg);
      } catch {
        cfg = null;
      }
    }
    const ac = (cfg && typeof cfg === "object" ? cfg : {}).access_control || {};
    const password =
      ac?.password != null && String(ac.password).trim() !== ""
        ? String(ac.password).trim()
        : "";
    const cardNo = ac?.cardNo != null ? String(ac.cardNo).trim() : "";
    const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
    const fingerprintCount = fps.filter(
      (fp) => fp && String(fp.fingerData || "").trim() !== "",
    ).length;
    const faceUrl = p?.face_url != null ? String(p.face_url).trim() : "";
    const employeeNo = String(p.employee_no);
    const { needsSync, needsSyncSteps } = buildNeedsSync(p);
    return {
      employeeNo,
      fullName: p.full_name || "",
      hasFace: faceUrl.length > 0,
      hasPassword: password.length > 0,
      hasCard: cardNo.length > 0,
      fingerprintCount,
      needsSync,
      needsSyncSteps,
      lastSync: {
        userInfo: aggStep(employeeNo, "userInfo"),
        face: aggStep(employeeNo, "face"),
        card: aggStep(employeeNo, "card"),
        fingerprint: aggStep(employeeNo, "fingerprint"),
      },
    };
  });
}

function startSyncAllLocationsJob() {
  cleanupOldJobs();
  const jobId = randomJobId();
  const job = {
    jobId,
    status: "queued", // queued | running | completed
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    items: [],
    progress: {
      total: 0,
      completed: 0,
      currentLocationId: null,
      currentLocationName: null,
    },
    result: null,
    error: null,
  };
  syncAllJobs.set(jobId, job);

  // async run
  (async () => {
    job.status = "running";
    job.startedAt = Date.now();
    try {
      const locations = await getSyncableLocations();
      job.progress.total = locations.length;
      const results = [];
      for (const loc of locations) {
        job.progress.currentLocationId = loc.id;
        job.progress.currentLocationName = loc.name;
        try {
          const subReporter = createAllLocationsItemReporter(job, loc.id);
          const { warnings } = await syncLocation(loc.id, subReporter);
          results.push({ locationId: loc.id, locationName: loc.name, warnings });
        } catch (err) {
          const message = toMessage(err);
          logger.warn("同步地點失敗，跳過", { locationId: loc.id, error: message });
          results.push({
            locationId: loc.id,
            locationName: loc.name,
            warnings: [{ type: "sync", message }],
          });
        } finally {
          job.progress.completed += 1;
        }
      }
      job.result = { synced: results.length, results };
      job.status = "completed";
      job.finishedAt = Date.now();
      job.progress.currentLocationId = null;
      job.progress.currentLocationName = null;
    } catch (err) {
      job.status = "completed";
      job.finishedAt = Date.now();
      job.error = { message: toMessage(err) };
    }
  })();

  return { jobId };
}

function getSyncAllLocationsJob(jobId) {
  cleanupOldJobs();
  const job = syncAllJobs.get(String(jobId));
  if (!job) return null;
  return job;
}

module.exports = {
  getPeopleCountingDevicesForLocation,
  getSyncableLocations,
  getSyncCandidatesForLocation,
  syncLocation,
  syncAllLocations,
  startSyncLocationJob,
  getSyncLocationJob,
  startSyncAllLocationsJob,
  getSyncAllLocationsJob,
};
