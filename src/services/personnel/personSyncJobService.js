/**
 * 人員門禁同步服務（同步執行，無佇列）
 * 依 person_location_access 取得有權限人員，對地點綁定之入口/出口設備同步：新增、更新（姓名與人臉）、刪除（僅平台曾同步過且已不在目標名單者）。資料有更新即同步到設備。
 * 設備寫入見 personSyncDeviceOps.js；寫入節奏與暫態重試亦由該模組處理。
 */
const db = require("../../database/db");
const {
  buildIsapiValidPayloadFromPlatformValidity,
} = require("../accessControl/accessControlHelpers");
const personnelService = require("./personnelService");
const logger = require("../../utils/logger").createLogger("PersonSyncService");
const personDeviceSyncStateService = require("./personDeviceSyncStateService");
const { normalizePersistedStatus, API: SYNC_STATUS } = require("./syncStatusCodes");
const personSyncJobStore = require("./personSyncJobStore");
const {
  normalizePositiveIntIds,
  resolveFaceUrlToBuffer,
  syncAccessDevicesWithPersons,
  syncCameraDevicesWithPersons,
} = require("./personSyncDeviceOps");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const {
  unionAccessCredentialCapabilities,
  getAccessCredentialCapabilitiesByDeviceIds,
} = require("../../utils/accessCredentialCapabilities");
const { resolveCardNos } = require("../../utils/accessControlCardsUtils");
const { PROGRESS_FLUSH_MS } = require("../../config/deviceSyncTiming");

// ========== sync 背景工作（DB 持久化） ==========
// 需求：避免長時間同步造成 HTTP timeout；前端以 jobId 輪詢進度/結果。
// - job/items/warnings 落 DB：重啟仍可查詢；也支援未來多實例
function randomJobId() {
  return `syncall_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toMessage(err) {
  return err?.message ?? String(err);
}

function trackJobWrite(job, write) {
  const pending = write.catch((error) => {
    logger.warn("同步 Job 進度或明細寫入失敗", {
      jobId: job.jobId,
      error: toMessage(error),
    });
  }).finally(() => job.pendingWrites.delete(pending));
  job.pendingWrites.add(pending);
}

function appendJobItem(job, item) {
  trackJobWrite(job, personSyncJobStore.appendItem(job.jobId, "tail", item));
  if (item.status === "failed") {
    trackJobWrite(job, personSyncJobStore.appendItem(job.jobId, "issues", item));
  }
}

function createLocationJobReporter(job, locationId = null) {
  const locId =
    locationId != null
      ? Number(locationId)
      : job?.locationId != null
        ? Number(job.locationId)
        : null;
  const bump = (key, n = 1) => {
    if (!job?.progress) return;
    job.progress[key] = (Number(job.progress[key]) || 0) + n;
  };
  const set = (key, v) => {
    if (!job?.progress) return;
    job.progress[key] = v;
  };
  const requestProgressFlush = (force = false) => {
    if (typeof job?._flushProgress === "function") {
      void job._flushProgress(force);
    }
  };

  /**
   * progress.total 以「人員層」ops 估算（add/update/delete 各 1）。
   * 子步驟（userInfo／face／card／fingerprint）仍寫 tail，但不計入 completed，
   * 避免 UI 出現 896／510 這類分子大於分母。
   */
  const countsTowardProgress = (stage) =>
    String(stage || "").trim() === "person";

  const startOp = ({ employeeNo, deviceId, action, stage }) => {
    const startedAt = Date.now();
    if (countsTowardProgress(stage)) bump("attempted", 1);
    set("currentDeviceId", deviceId ?? null);
    set("currentEmployeeNo", employeeNo ?? null);
    set("currentAction", action ?? null);
    set("currentStage", stage ?? null);
    requestProgressFlush(false);
    return startedAt;
  };

  const finishOp = ({
    employeeNo,
    deviceId,
    action,
    stage,
    startedAt,
    ok,
    message,
  }) => {
    if (countsTowardProgress(stage)) {
      bump("completed", 1);
      if (ok === "unchanged") bump("skipped", 1);
      else if (ok) bump("succeeded", 1);
      else bump("failed", 1);
    }
    appendJobItem(job, {
      ...(locId != null ? { locationId: locId } : {}),
      employeeNo,
      deviceId,
      action,
      stage,
      status: ok === "unchanged" ? "unchanged" : ok ? "success" : "failed",
      startedAt: startedAt ?? Date.now(),
      finishedAt: Date.now(),
      message: message ?? null,
    });
    requestProgressFlush(false);
  };

  const skipOp = ({ employeeNo, deviceId, action, stage, message }) => {
    if (countsTowardProgress(stage)) bump("attempted", 1);
    finishOp({
      employeeNo,
      deviceId,
      action,
      stage,
      startedAt: Date.now(),
      ok: "unchanged",
      message: message ?? "未變更",
    });
  };

  const markDevice = ({ deviceId, deviceIndex, deviceTotal }) => {
    set("currentDeviceId", deviceId ?? null);
    if (deviceIndex != null) set("currentDeviceIndex", deviceIndex);
    if (deviceTotal != null) set("deviceTotal", deviceTotal);
    requestProgressFlush(false);
  };

  const setTotals = ({ totalOps, targetPersonsTotal, deviceTotal }) => {
    if (totalOps != null) set("total", totalOps);
    if (targetPersonsTotal != null)
      set("targetPersonsTotal", targetPersonsTotal);
    if (deviceTotal != null) set("deviceTotal", deviceTotal);
    requestProgressFlush(true);
  };

  return { startOp, finishOp, skipOp, markDevice, setTotals };
}

/** 僅寫入 items（不更新整體 job.progress），用於「同步全部」彙總多個地點的逐人步驟 */
function createAllLocationsItemReporter(rootJob, locationId) {
  const locId = Number(locationId);
  const startOp = ({ employeeNo, deviceId, action, stage }) => {
    const startedAt = Date.now();
    // sync-all 的 items 本來就是「逐步事件流」；這裡也改為只保留 tail + issues
    const item = {
      locationId: locId,
      employeeNo,
      deviceId,
      action,
      stage,
      status: "running",
      startedAt,
      finishedAt: null,
      message: null,
    };
    appendJobItem(rootJob, item);
    return startedAt;
  };
  const finishOp = ({
    employeeNo,
    deviceId,
    action,
    stage,
    startedAt,
    ok,
    message,
  }) => {
    const item = {
      locationId: locId,
      employeeNo,
      deviceId,
      action,
      stage,
      status: ok === "unchanged" ? "unchanged" : ok ? "success" : "failed",
      startedAt: startedAt ?? Date.now(),
      finishedAt: Date.now(),
      message: message ?? null,
    };
    appendJobItem(rootJob, item);
  };
  const skipOp = ({ employeeNo, deviceId, action, stage, message }) => {
    finishOp({
      employeeNo,
      deviceId,
      action,
      stage,
      startedAt: Date.now(),
      ok: "unchanged",
      message: message ?? "未變更",
    });
  };
  const noOp = () => {};
  return { startOp, finishOp, skipOp, setTotals: noOp, markDevice: noOp };
}


/**
 * 取得地點可同步設備（people_counting 門禁／攝影機，或 roll_call 簽到門禁機）
 */
async function getPeopleCountingDevicesForLocation(locationId) {
  const pcRows = await db.query(
    "SELECT system_config FROM active_location_systems WHERE location_id = ? AND system_type = 'people_counting' LIMIT 1",
    [locationId],
  );
  if (pcRows && pcRows.length > 0) {
    const config = pcRows[0].system_config;
    const raw = typeof config === "string" ? JSON.parse(config) : config || {};
    const entryDeviceIds = normalizePositiveIntIds(raw.entry_device_ids);
    const exitDeviceIds = normalizePositiveIntIds(raw.exit_device_ids);
    const {
      resolvePeopleCountingCameraDevices,
      isFaceRecognitionCameraMode,
    } = require("../peopleCounting/peopleCountingConfig");
    const cameras = resolvePeopleCountingCameraDevices(raw);
    const cameraDeviceIds =
      String(raw.data_source || "").trim() === "isapi_camera" &&
      isFaceRecognitionCameraMode(raw.camera_mode)
        ? cameras.cameraDeviceIds
        : [];
    const cameraChannelId = (() => {
      const n = Number(raw.camera_channel_id);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
    })();
    if (
      entryDeviceIds.length > 0 ||
      exitDeviceIds.length > 0 ||
      cameraDeviceIds.length > 0
    ) {
      return {
        entryDeviceIds,
        exitDeviceIds,
        cameraDeviceIds,
        cameraChannelId,
      };
    }
  }

  const rcRows = await db.query(
    "SELECT system_config FROM active_location_systems WHERE location_id = ? AND system_type = 'roll_call' LIMIT 1",
    [locationId],
  );
  if (!rcRows || rcRows.length === 0) return null;
  const rcConfig = rcRows[0].system_config;
  const rcRaw =
    typeof rcConfig === "string" ? JSON.parse(rcConfig) : rcConfig || {};
  const deviceIds = normalizePositiveIntIds(rcRaw.device_ids);
  if (deviceIds.length === 0) return null;
  return {
    entryDeviceIds: deviceIds,
    exitDeviceIds: [],
    cameraDeviceIds: [],
    cameraChannelId: 1,
  };
}

async function getLocationName(locationId) {
  const rows = await db.query(
    "SELECT name FROM active_locations WHERE id = ? LIMIT 1",
    [locationId],
  );
  return rows?.[0]?.name ?? null;
}

/**
 * 取得所有可同步的地點（people_counting 門禁／攝影機，或 roll_call 簽到門禁機）
 */
async function getSyncableLocations() {
  const rows = await db.query(
    `SELECT l.id, l.name, z.name AS zone_name
     FROM active_locations l
     INNER JOIN active_zones z ON l.zone_id = z.id
     INNER JOIN active_location_systems ls ON l.id = ls.location_id
     WHERE (
       ls.system_type = 'people_counting'
       AND (
         COALESCE(jsonb_array_length(ls.system_config->'entry_device_ids'), 0) > 0
         OR (
           COALESCE(ls.system_config->>'data_source', '') = 'isapi_camera'
           AND COALESCE(ls.system_config->>'camera_mode', 'people_counting') = 'face_recognition'
           AND (
             COALESCE(jsonb_array_length(ls.system_config->'camera_device_ids'), 0) > 0
             OR COALESCE(jsonb_array_length(ls.system_config->'entry_camera_device_ids'), 0) > 0
             OR COALESCE(jsonb_array_length(ls.system_config->'exit_camera_device_ids'), 0) > 0
           )
         )
       )
     )
     OR (
       ls.system_type = 'roll_call'
       AND COALESCE(jsonb_array_length(ls.system_config->'device_ids'), 0) > 0
     )
     ORDER BY z.name, l.name`,
    [],
  );
  return rows || [];
}


/**
 * 對單一地點執行同步：目標名單為來源；門禁走 UserInfo 四步、攝影機走 FDLib 臉庫
 * @returns {{ warnings: Array<{ type: string, employeeNo?: string, deviceId?: number, message: string }> }}
 */
async function syncLocation(locationId, reporter = null) {
  const warnings = [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  if (!devs) {
    throwApiError(
      C.PERSONNEL_SYNC_JOB_VALIDATION_FAILED,
      "該地點未設定門禁設備或人流攝影機",
    );
  }

  const persons =
    await personnelService.getPersonsWithAccessByLocationId(locationId);
  const targetList = persons.map((p) => ({
    employeeNo: String(p.employee_no),
    name: p.full_name || p.employee_no,
    face_url: p.face_url || null,
    config: p.config || null,
  }));

  const accessDeviceIds = [
    ...new Set([...(devs.entryDeviceIds || []), ...(devs.exitDeviceIds || [])]),
  ];
  if (accessDeviceIds.length > 0) {
    await syncAccessDevicesWithPersons(
      accessDeviceIds,
      targetList,
      warnings,
      reporter,
      { locationId },
    );
  }

  const cameraDeviceIds = devs.cameraDeviceIds || [];
  if (cameraDeviceIds.length > 0) {
    await syncCameraDevicesWithPersons(
      cameraDeviceIds,
      targetList,
      warnings,
      reporter,
      {
        locationId,
        cameraChannelId: devs.cameraChannelId,
      },
    );
  }

  logger.info("同步完成", { locationId, warningsCount: warnings.length });
  return { warnings };
}

async function syncPersonsToAccessDevices({
  deviceIds,
  persons,
  warnings = [],
  reporter = null,
}) {
  const targetList = (persons || []).map((p) => ({
    employeeNo: String(p.employee_no),
    name: p.full_name || p.employee_no,
    face_url: p.face_url || null,
    config: p.config || null,
  }));
  await syncAccessDevicesWithPersons(deviceIds, targetList, warnings, reporter);
  return { warnings };
}

async function startPersistedSyncJob(params, run) {
  const { jobId, locationId, progress } = params;
  await personSyncJobStore.createJob({
    ...params,
    status: "queued",
    itemsMeta: { issuesTotal: 0, tailTotal: 0, issuesStored: 0, tailStored: 0 },
  });
  const execute = async () => {
    const job = { jobId, locationId, progress, pendingWrites: new Set() };
    let result = null;
    let error = null;
    try {
      await personSyncJobStore.updateJob(jobId, {
        status: "running",
        startedAt: Date.now(),
        progress,
      });
      const outcome = await run(job);
      await personSyncJobStore.replaceWarnings(jobId, outcome.warnings, locationId);
      result = outcome.result;
    } catch (err) {
      error = { message: toMessage(err) };
    }
    await Promise.all(job.pendingWrites);
    await personSyncJobStore.updateJob(jobId, {
      status: "completed",
      finishedAt: Date.now(),
      progress,
      result,
      error,
    });
  };
  void execute().catch((error) => {
    logger.error("同步 Job 背景執行失敗", { jobId, error: toMessage(error) });
  });
  return { jobId };
}

function startSyncLocationJob(locationId) {
  const jobId = `syncloc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const locId = Number(locationId);

  const progress = {
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
  };

  return startPersistedSyncJob({
    jobId,
    jobType: "sync_location",
    locationId: Number.isFinite(locId) ? locId : null,
    progress,
  }, async (job) => {
    let lastProgressFlushAt = 0;
    job._flushProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressFlushAt < PROGRESS_FLUSH_MS) return;
      lastProgressFlushAt = now;
      trackJobWrite(job, personSyncJobStore.updateJob(jobId, {
        progress: { ...job.progress },
      }));
    };

    try {
      const reporter = createLocationJobReporter(job, job.locationId);
      const result = await syncLocation(job.locationId, reporter);

      return { result, warnings: result.warnings };
    } finally {
      job.progress.currentDeviceId = null;
      job.progress.currentEmployeeNo = null;
      job.progress.currentAction = null;
      job.progress.currentStage = null;
    }
  });
}

async function getSyncLocationJobView(jobId, options = {}) {
  const job = await personSyncJobStore.getJob(jobId);
  if (!job) return null;

  const includeIssues = Boolean(options.includeIssues);
  const includeTail = Boolean(options.includeTail);
  const issuesLimit =
    options.issuesLimit != null
      ? Math.max(0, Math.trunc(Number(options.issuesLimit)))
      : null;
  const tailLimit =
    options.tailLimit != null
      ? Math.max(0, Math.trunc(Number(options.tailLimit)))
      : null;

  const locationName =
    job.locationId != null
      ? await getLocationName(Number(job.locationId))
      : null;

  const base = {
    jobId: job.jobId,
    locationId: job.locationId,
    locationName,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress || null,
    itemsMeta: {
      issuesTotal: Number(job.itemsMeta?.issuesTotal) || 0,
      tailTotal: Number(job.itemsMeta?.tailTotal) || 0,
      issuesStored: 0,
      tailStored: 0,
    },
    result: job.result || null,
    error: job.error || null,
  };

  if (includeIssues) {
    const page = await personSyncJobStore.listItems(jobId, "issues", {
      limit: issuesLimit != null ? issuesLimit : 200,
      offset: 0,
    });
    base.items = page?.items ?? [];
    base.itemsMeta.issuesStored = Array.isArray(base.items)
      ? base.items.length
      : 0;
  }
  if (includeTail) {
    const page = await personSyncJobStore.listItems(jobId, "tail", {
      limit: tailLimit != null ? tailLimit : 200,
      offset: 0,
    });
    base.tailItems = page?.items ?? [];
    base.itemsMeta.tailStored = Array.isArray(base.tailItems)
      ? base.tailItems.length
      : 0;
  }

  // 若沒 includeIssues/includeTail，仍回傳 stored=0（避免額外查詢）
  return base;
}

async function getSyncLocationJobItems(
  jobId,
  type = "issues",
  { limit = 200, offset = 0 } = {},
) {
  const t = String(type || "").trim() === "tail" ? "tail" : "issues";
  const page = await personSyncJobStore.listItems(jobId, t, { limit, offset });
  if (!page) return null;
  return page;
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

async function buildAccessSyncFieldsForPersons(persons, deviceIds) {
  const list = Array.isArray(persons) ? persons : [];
  const ids = [
    ...new Set(
      (deviceIds || [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  const credentialsByDeviceId =
    await getAccessCredentialCapabilitiesByDeviceIds(ids);
  const locationCaps = unionAccessCredentialCapabilities(
    ids.map((id) => credentialsByDeviceId.get(id)),
  );

  const employeeNos = list.map((p) => String(p.employee_no));
  const stateMaps = [];
  for (const did of ids) {
    stateMaps.push({
      deviceId: did,
      caps: credentialsByDeviceId.get(did),
      map: await personDeviceSyncStateService.getStatesForDevice(
        did,
        employeeNos,
      ),
    });
  }

  // face hash：需與 syncPersonToDevice 的規則一致
  // - /uploads/*：以檔案內容 hash（避免 URL 不變但內容更新造成誤判）
  // - 其他：以 faceUrl hash
  const faceHashCache = new Map(); // faceUrl -> hash|null
  const computeDesiredFaceHash = async (faceUrl) => {
    const u = faceUrl != null ? String(faceUrl).trim() : "";
    if (!u) return null;
    if (faceHashCache.has(u)) return faceHashCache.get(u);
    let hash = null;
    try {
      if (u.startsWith("/uploads/")) {
        const buf = await resolveFaceUrlToBuffer(u);
        // 讀檔失敗時退回 URL meta hash，避免 desired=null → last_sync 被誤判 no_data
        hash = personDeviceSyncStateService.hashFace({
          faceBuffer: buf && buf.length > 0 ? buf : null,
          faceUrl: buf && buf.length > 0 ? null : u,
        });
      } else {
        hash = personDeviceSyncStateService.hashFace({
          faceBuffer: null,
          faceUrl: u,
        });
      }
    } catch (_e) {
      hash = personDeviceSyncStateService.hashFace({
        faceBuffer: null,
        faceUrl: u,
      });
    }
    faceHashCache.set(u, hash);
    return hash;
  };

  const stepSupportedOnDevice = (caps, step) => {
    if (step === "userInfo") return true;
    if (step === "face") return caps?.face !== false;
    if (step === "card") return caps?.card !== false;
    if (step === "fingerprint") return caps?.fingerprint !== false;
    return true;
  };

  const aggStep = (eno, step, desired) => {
    const rows = stateMaps
      .filter(({ caps }) => stepSupportedOnDevice(caps, step))
      .map(({ deviceId, map }) => ({
        deviceId,
        row: map.get(String(eno)) || null,
      }))
      .filter((x) => x.row);
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
    for (const r of rows) {
      const st = normalizePersistedStatus(r.row?.[statusKey]) || "";
      if (st === SYNC_STATUS.FAILED) hasFailed = true;
      if (st === SYNC_STATUS.SUCCESS) hasSuccess = true;
      const t = r.row?.[atKey] ? new Date(r.row[atKey]).getTime() : null;
      if (t != null && (lastAt == null || t > lastAt)) lastAt = t;
    }
    if (desired == null) return { status: SYNC_STATUS.NO_DATA, at: null };
    if (rows.length === 0) return { status: SYNC_STATUS.PENDING, at: null };
    const atIso = lastAt != null ? new Date(lastAt).toISOString() : null;
    if (hasFailed) return { status: SYNC_STATUS.FAILED, at: atIso };
    if (hasSuccess) return { status: SYNC_STATUS.SUCCESS, at: atIso };
    return { status: SYNC_STATUS.PENDING, at: atIso };
  };

  const buildNeedsSync = async (person) => {
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

    const valid = buildIsapiValidPayloadFromPlatformValidity(ac?.validity);
    const password =
      ac?.password != null && String(ac.password).trim() !== ""
        ? String(ac.password).trim()
        : null;
    const desiredUserInfoHash = personDeviceSyncStateService.hashUserInfo({
      employeeNo,
      name: fullName,
      valid,
      password,
    });

    const faceUrl =
      person?.face_url != null ? String(person.face_url).trim() : "";
    const desiredFaceHash =
      locationCaps.face && faceUrl
        ? await computeDesiredFaceHash(faceUrl)
        : null;

    const cardNos = resolveCardNos(ac);
    const desiredCardHash =
      locationCaps.card && cardNos.length
        ? personDeviceSyncStateService.hashCards({ cardNos })
        : null;

    const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
    const desiredFpHash = locationCaps.fingerprint
      ? personDeviceSyncStateService.hashFingerprint({
          fingerprints: fps,
        })
      : null;

    const steps = new Set();
    for (const { map, caps } of stateMaps) {
      const row = map.get(employeeNo) || null;
      const supportFace = caps?.face !== false;
      const supportCard = caps?.card !== false;
      const supportFp = caps?.fingerprint !== false;
      // 若該設備完全沒有紀錄，一律視為需同步（避免「後來加資料但仍顯示成功」）
      if (!row) {
        steps.add("user_info");
        if (supportFace && faceUrl) steps.add("face");
        if (supportCard && cardNos.length) steps.add("card");
        if (supportFp && desiredFpHash) steps.add("fingerprint");
        continue;
      }

      const userOk =
        normalizePersistedStatus(row.user_info_status) === "success" &&
        String(row.user_info_hash || "") === desiredUserInfoHash;
      if (!userOk) steps.add("user_info");

      if (supportFace && faceUrl) {
        const faceOk =
          normalizePersistedStatus(row.face_status) === "success" &&
          String(row.face_hash || "") === String(desiredFaceHash || "");
        if (!faceOk) steps.add("face");
      }

      if (supportCard && cardNos.length) {
        const cardOk =
          normalizePersistedStatus(row.card_status) === "success" &&
          String(row.card_hash || "") === String(desiredCardHash || "");
        if (!cardOk) steps.add("card");
      }

      if (supportFp && desiredFpHash) {
        const fpOk =
          normalizePersistedStatus(row.fingerprint_status) === "success" &&
          String(row.fingerprint_hash || "") === String(desiredFpHash || "");
        if (!fpOk) steps.add("fingerprint");
      }
    }

    const needsSyncSteps = Array.from(steps);
    return {
      needsSync: needsSyncSteps.length > 0,
      needsSyncSteps,
      desired: {
        userInfoHash: desiredUserInfoHash,
        faceHash: desiredFaceHash,
        cardHash: desiredCardHash,
        fingerprintHash: desiredFpHash,
      },
    };
  };

  const needs = await Promise.all(list.map((p) => buildNeedsSync(p)));

  return list.map((p, idx) => {
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
    const cardNos = resolveCardNos(ac);
    const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
    const fingerprintCount = locationCaps.fingerprint
      ? fps.filter(
          (fp) => fp && String(fp.fingerData || "").trim() !== "",
        ).length
      : 0;
    const faceUrl = p?.face_url != null ? String(p.face_url).trim() : "";
    const employeeNo = String(p.employee_no);
    const n = needs[idx] || {
      needsSync: true,
      needsSyncSteps: ["user_info"],
      desired: {
        userInfoHash: null,
        faceHash: null,
        cardHash: null,
        fingerprintHash: null,
      },
    };
    const { needsSync, needsSyncSteps, desired } = n;
    return {
      employee_no: employeeNo,
      full_name: p.full_name || "",
      has_face: locationCaps.face && faceUrl.length > 0,
      has_password: password.length > 0,
      has_card: locationCaps.card && cardNos.length > 0,
      fingerprint_count: fingerprintCount,
      needs_sync: needsSync,
      needs_sync_steps: needsSyncSteps,
      last_sync: {
        user_info: aggStep(
          employeeNo,
          "userInfo",
          desired?.userInfoHash ?? null,
        ),
        face: aggStep(employeeNo, "face", desired?.faceHash ?? null),
        card: aggStep(employeeNo, "card", desired?.cardHash ?? null),
        fingerprint: aggStep(
          employeeNo,
          "fingerprint",
          desired?.fingerprintHash ?? null,
        ),
      },
    };
  });
}

async function getSyncCandidatesForLocation(locationId) {
  const rows =
    await personnelService.getPersonsWithAccessByLocationId(locationId);
  const list = Array.isArray(rows) ? rows : [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  const accessDeviceIds = devs
    ? [
        ...new Set([
          ...(devs.entryDeviceIds || []),
          ...(devs.exitDeviceIds || []),
        ]),
      ]
    : [];
  const cameraDeviceIds = devs ? [...(devs.cameraDeviceIds || [])] : [];

  // 僅攝影機：沿用 face 彙總，其餘步驟固定 no_data（避免 UserInfo 誤判需同步）
  if (accessDeviceIds.length === 0 && cameraDeviceIds.length > 0) {
    const fields = await buildAccessSyncFieldsForPersons(list, cameraDeviceIds);
    return fields.map(toCameraOnlyCandidateRow);
  }

  const fields = await buildAccessSyncFieldsForPersons(list, accessDeviceIds);
  if (cameraDeviceIds.length === 0) return fields;

  const cameraFields = await buildAccessSyncFieldsForPersons(
    list,
    cameraDeviceIds,
  );
  const camByNo = new Map(
    cameraFields.map((r) => [
      String(r.employee_no),
      toCameraOnlyCandidateRow(r),
    ]),
  );
  return fields.map((row) => {
    const cam = camByNo.get(String(row.employee_no));
    if (!cam) return row;
    const accessFace = row.last_sync?.face || { status: "no_data", at: null };
    const cameraFace = cam.last_sync?.face || { status: "no_data", at: null };
    const mergedFace = mergeFaceStepStatus(accessFace, cameraFace);
    const needsSteps = new Set(row.needs_sync_steps || []);
    for (const s of cam.needs_sync_steps || []) needsSteps.add(s);
    return {
      ...row,
      has_face: Boolean(row.has_face || cam.has_face),
      needs_sync: needsSteps.size > 0,
      needs_sync_steps: Array.from(needsSteps),
      last_sync: {
        ...(row.last_sync || {}),
        face: mergedFace,
      },
    };
  });
}

function toCameraOnlyCandidateRow(row) {
  const faceSteps = (row.needs_sync_steps || []).filter((s) => s === "face");
  return {
    ...row,
    has_password: false,
    has_card: false,
    fingerprint_count: 0,
    needs_sync: faceSteps.length > 0,
    needs_sync_steps: faceSteps,
    last_sync: {
      user_info: { status: "no_data", at: null },
      face: row.last_sync?.face || { status: "no_data", at: null },
      card: { status: "no_data", at: null },
      fingerprint: { status: "no_data", at: null },
    },
  };
}

function mergeFaceStepStatus(a, b) {
  const rank = { failed: 4, pending: 3, success: 2, no_data: 0 };
  const sa = String(a?.status || "no_data");
  const sb = String(b?.status || "no_data");
  const pick = (rank[sa] || 0) >= (rank[sb] || 0) ? a : b;
  const atA = a?.at ? new Date(a.at).getTime() : null;
  const atB = b?.at ? new Date(b.at).getTime() : null;
  let at = pick?.at ?? null;
  if (atA != null && atB != null)
    at = new Date(Math.max(atA, atB)).toISOString();
  else if (atA != null) at = a.at;
  else if (atB != null) at = b.at;
  return { status: pick?.status || "no_data", at };
}

function startSyncAllLocationsJob() {
  const jobId = randomJobId();

  const progress = {
    total: 0,
    completed: 0,
    currentLocationId: null,
    currentLocationName: null,
  };

  return startPersistedSyncJob({
    jobId,
    jobType: "sync_all_locations",
    locationId: null,
    progress,
  }, async (job) => {
    try {
      const locations = await getSyncableLocations();
      job.progress.total = locations.length;
      await personSyncJobStore.updateJob(jobId, { progress: job.progress });

      const results = [];
      const flatWarnings = [];

      for (const loc of locations) {
        job.progress.currentLocationId = loc.id;
        job.progress.currentLocationName = loc.name;
        await personSyncJobStore.updateJob(jobId, { progress: job.progress });

        try {
          const subReporter = createAllLocationsItemReporter(job, loc.id);
          const { warnings } = await syncLocation(loc.id, subReporter);
          results.push({
            locationId: loc.id,
            locationName: loc.name,
            warnings,
          });
          for (const w of warnings || [])
            flatWarnings.push({
              ...w,
              locationId: loc.id,
              locationName: loc.name,
            });
        } catch (err) {
          const message = toMessage(err);
          logger.warn("同步地點失敗，跳過", {
            locationId: loc.id,
            error: message,
          });
          const warnings = [
            {
              type: "sync",
              message,
              locationId: loc.id,
              locationName: loc.name,
            },
          ];
          results.push({
            locationId: loc.id,
            locationName: loc.name,
            warnings,
          });
          flatWarnings.push(...warnings);
        } finally {
          job.progress.completed += 1;
          await personSyncJobStore.updateJob(jobId, { progress: job.progress });
        }
      }

      return {
        result: { synced: results.length, results },
        warnings: flatWarnings,
      };
    } finally {
      job.progress.currentLocationId = null;
      job.progress.currentLocationName = null;
    }
  });
}

async function getSyncAllLocationsJob(jobId) {
  const job = await personSyncJobStore.getJob(jobId);
  if (!job) return null;

  const itemsPage = await personSyncJobStore.listItems(jobId, "issues", {
    limit: 2000,
    offset: 0,
  });

  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    // 保持既有欄位名（前端目前用 job.items）
    items: itemsPage?.items ?? [],
    progress: job.progress || {
      total: 0,
      completed: 0,
      currentLocationId: null,
      currentLocationName: null,
    },
    result: job.result || null,
    error: job.error || null,
  };
}

module.exports = {
  getPeopleCountingDevicesForLocation,
  getSyncableLocations,
  getSyncCandidatesForLocation,
  buildAccessSyncFieldsForPersons,
  syncLocation,
  syncPersonsToAccessDevices,
  syncAllLocations,
  startSyncLocationJob,
  getSyncLocationJobView,
  getSyncLocationJobItems,
  startSyncAllLocationsJob,
  getSyncAllLocationsJob,
};
