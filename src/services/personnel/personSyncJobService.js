/**
 * 人員門禁同步服務（同步執行，無佇列）
 * 依 person_location_access 取得有權限人員，對地點綁定之入口/出口設備同步：新增、更新（姓名與人臉）、刪除（僅平台曾同步過且已不在目標名單者）。資料有更新即同步到設備。
 */
const path = require("path");
const fs = require("fs").promises;
const db = require("../../database/db");
const accessControlService = require("../accessControl/accessControlService");
const {
  buildIsapiValidPayloadFromPlatformValidity,
} = require("../accessControl/accessControlValidityUtils");
const personnelService = require("./personnelService");
const logger = require("../../utils/logger").createLogger("PersonSyncService");
const personDeviceSyncStateService = require("./personDeviceSyncStateService");
const personSyncJobStore = require("./personSyncJobStore");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const { getDeviceNameByIds } = require("../../utils/deviceHelpers");
const { pushPersonSyncWarning } = require("../../utils/personDisplayUtils");
const { resolveCardNos } = require("../../utils/accessControlCardsUtils");
const { assertSafeOutboundUrl } = require("../../utils/safeUrl");
const { resolveUploadFilePath } = require("../../utils/baDataPaths");

const SYNC_DELAY_MS = 300;

function normalizeIsapiErrorMessage(raw) {
  const msg = raw != null ? String(raw) : "";
  if (!msg) return msg;
  // ISAPI 常見回應：Unauthorized: <userCheck ...><statusValue>401</statusValue>...
  if (
    /Unauthorized/i.test(msg) &&
    (/<statusValue>\s*401\s*<\/statusValue>/i.test(msg) ||
      /\b401\b/.test(msg))
  ) {
    return "設備驗證失敗（401 Unauthorized），請確認帳密/權限";
  }
  return msg;
}

// ========== sync 背景工作（DB 持久化） ==========
// 需求：避免長時間同步造成 HTTP timeout；前端以 jobId 輪詢進度/結果。
// - job/items/warnings 落 DB：重啟仍可查詢；也支援未來多實例
const MAX_JOB_ISSUES_ITEMS = personSyncJobStore.MAX_JOB_ISSUES_ITEMS;
const MAX_JOB_TAIL_ITEMS = personSyncJobStore.MAX_JOB_TAIL_ITEMS;

function randomJobId() {
  return `syncall_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toMessage(err) {
  return err?.message ?? String(err);
}

function pushJobTailItem(job, item) {
  if (!job?.jobId) return;
  // fire-and-forget：job 執行中不阻塞主流程（落盤失敗時仍可完成同步）
  void personSyncJobStore.appendItem(job.jobId, "tail", item, {
    maxTail: MAX_JOB_TAIL_ITEMS,
  });
}

function pushJobIssueItem(job, item) {
  // 僅保留 failed（success/running/unchanged 不進入 issues）
  if (!job?.jobId) return;
  const st = item?.status ? String(item.status) : "";
  if (st !== "failed") return;
  void personSyncJobStore.appendItem(job.jobId, "issues", item, {
    maxIssues: MAX_JOB_ISSUES_ITEMS,
  });
}

function withLocationId(job, item, locationId) {
  if (locationId == null) return item;
  return { ...item, locationId: Number(locationId) };
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

  let runningSeq = 0;
  const runningSampleRate = 0;

  const startOp = ({ employeeNo, deviceId, action, stage }) => {
    const startedAt = Date.now();
    bump("attempted", 1);
    set("currentDeviceId", deviceId ?? null);
    set("currentEmployeeNo", employeeNo ?? null);
    set("currentAction", action ?? null);
    set("currentStage", stage ?? null);
    // running 事件：預設不寫入 DB（避免寫入放大）
    if (runningSampleRate > 0) {
      runningSeq += 1;
      if (runningSeq % runningSampleRate === 0) {
        pushJobTailItem(
          job,
          withLocationId(
            job,
            {
              employeeNo,
              deviceId,
              action,
              stage,
              status: "running",
              startedAt,
              finishedAt: null,
              message: null,
            },
            locId,
          ),
        );
      }
    }
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
    bump("completed", 1);
    if (ok === "unchanged") bump("skipped", 1);
    else if (ok) bump("succeeded", 1);
    else bump("failed", 1);
    const completedItem = withLocationId(
      job,
      {
        employeeNo,
        deviceId,
        action,
        stage,
        status: ok === "unchanged" ? "unchanged" : ok ? "success" : "failed",
        startedAt: startedAt ?? Date.now(),
        finishedAt: Date.now(),
        message: message ?? null,
      },
      locId,
    );
    // completed 事件一律進 tail；issues 只保留 failed
    pushJobTailItem(job, completedItem);
    pushJobIssueItem(job, completedItem);
  };

  const skipOp = ({ employeeNo, deviceId, action, stage, message }) => {
    bump("attempted", 1);
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
  };

  const setTotals = ({ totalOps, targetPersonsTotal, deviceTotal }) => {
    if (totalOps != null) set("total", totalOps);
    if (targetPersonsTotal != null)
      set("targetPersonsTotal", targetPersonsTotal);
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
    pushJobTailItem(rootJob, item);
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
    pushJobTailItem(rootJob, item);
    pushJobIssueItem(rootJob, item);
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
  const entryDeviceIds = Array.isArray(raw.entry_device_ids)
    ? raw.entry_device_ids
    : [];
  const exitDeviceIds = Array.isArray(raw.exit_device_ids)
    ? raw.exit_device_ids
    : [];
  if (entryDeviceIds.length === 0) return null;
  return {
    entryDeviceIds: entryDeviceIds
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0),
    exitDeviceIds: exitDeviceIds
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0),
  };
}

async function getLocationName(locationId) {
  const rows = await db.query(
    "SELECT name FROM locations WHERE id = ? LIMIT 1",
    [locationId],
  );
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

// validity → ISAPI Valid payload：抽到 accessControlValidityUtils 做 SSOT

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
      const fullPath = resolveUploadFilePath(trimmed);
      if (!fullPath) return null;
      return await fs.readFile(fullPath);
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      await assertSafeOutboundUrl(trimmed);
      const res = await fetch(trimmed, { method: "GET" });
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
  } catch (err) {
    logger.warn("解析 face_url 失敗", {
      faceUrl: trimmed.substring(0, 50),
      error: err.message,
    });
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
async function syncPersonToDevice(
  deviceId,
  person,
  warnings,
  reporter = null,
  options = {},
) {
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
  const faceUrlRaw =
    person?.face_url != null ? String(person.face_url).trim() : "";

  const validPayload = buildIsapiValidPayloadFromPlatformValidity(ac?.validity);

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
    const lastHash = stateRow?.user_info_hash
      ? String(stateRow.user_info_hash)
      : null;
    const lastStatus = stateRow?.user_info_status
      ? String(stateRow.user_info_status)
      : null;
    if (
      !forceUserInfo &&
      lastStatus === "success" &&
      lastHash &&
      lastHash === userInfoHash
    ) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "userInfo",
        message: "未變更",
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
        const message = normalizeIsapiErrorMessage(toMessage(err));
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
    pushPersonSyncWarning(warnings, person, {
      type: "face",
      deviceId,
      message,
    });
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
      hash: personDeviceSyncStateService.hashFace({
        faceBuffer: null,
        faceUrl: faceUrlRaw,
      }),
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
    // 人臉同步 hash：
    // - 本機 /uploads/...：用內容 hash（避免 URL 不變但內容被覆寫造成誤判）
    // - 其他：維持以 face_url（或其 meta）判斷即可
    const faceUrlForHash =
      person?.face_url != null ? String(person.face_url).trim() : "";
    const isLocalUpload = faceUrlForHash.startsWith("/uploads/");
    const faceHash = personDeviceSyncStateService.hashFace({
      faceBuffer: isLocalUpload ? imageBuffer : null,
      faceUrl: isLocalUpload ? null : faceUrlForHash,
    });
    const lastHash = stateRow?.face_hash ? String(stateRow.face_hash) : null;
    const lastStatus = stateRow?.face_status
      ? String(stateRow.face_status)
      : null;
    if (
      lastStatus === "success" &&
      lastHash &&
      faceHash &&
      lastHash === faceHash
    ) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "face",
        message: "未變更",
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
        await accessControlService.updateFace(
          deviceId,
          person.employeeNo,
          imageBuffer,
        );
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
        const message = normalizeIsapiErrorMessage(toMessage(faceErr));
        logger.warn("ISAPI 更新人臉失敗", {
          deviceId,
          employeeNo: person.employeeNo,
          error: message,
        });
        pushPersonSyncWarning(warnings, person, {
          type: "face",
          deviceId,
          deviceName: options?.deviceNameById?.get?.(Number(deviceId)) || null,
          message,
        });
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

  // 卡片同步：employeeNo -> cardNos（最多 5 張）
  const cardNos = resolveCardNos(ac);
  const cardsHash = personDeviceSyncStateService.hashCards({ cardNos });
  const lastHash = stateRow?.card_hash ? String(stateRow.card_hash) : null;
  const lastStatus = stateRow?.card_status ? String(stateRow.card_status) : null;

  if (!cardNos.length) {
    try {
      const deviceCards = await accessControlService.searchCardInfoByEmployee(
        deviceId,
        person.employeeNo,
      );
      for (const staleCardNo of deviceCards) {
        try {
          await accessControlService.deleteCardInfo(deviceId, staleCardNo);
          await delay(SYNC_DELAY_MS);
        } catch (deleteErr) {
          logger.warn("ISAPI 清除卡片失敗", {
            deviceId,
            employeeNo: person.employeeNo,
            cardNo: staleCardNo,
            error: toMessage(deleteErr),
          });
        }
      }
      if (deviceCards.length) {
        await personDeviceSyncStateService.upsertStepState({
          deviceId,
          employeeNo: person.employeeNo,
          step: "card",
          status: "success",
          hash: null,
          syncedAt: new Date(),
          lastErrorMessage: null,
        });
      }
    } catch (searchErr) {
      logger.warn("ISAPI 查詢卡片失敗", {
        deviceId,
        employeeNo: person.employeeNo,
        error: toMessage(searchErr),
      });
    }
  } else if (
    lastStatus === "success" &&
    lastHash &&
    cardsHash &&
    lastHash === cardsHash
  ) {
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "card",
      message: "未變更",
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
    let cardSyncOk = true;
    let cardSyncMessage = null;
    try {
      for (const cardNo of cardNos) {
        await accessControlService.setCardInfo(deviceId, {
          employeeNo: person.employeeNo,
          cardNo,
          cardType: "normalCard",
        });
        await delay(SYNC_DELAY_MS);
      }
      try {
        const deviceCards = await accessControlService.searchCardInfoByEmployee(
          deviceId,
          person.employeeNo,
        );
        const desiredSet = new Set(cardNos);
        for (const staleCardNo of deviceCards) {
          if (desiredSet.has(staleCardNo)) continue;
          try {
            await accessControlService.deleteCardInfo(deviceId, staleCardNo);
            await delay(SYNC_DELAY_MS);
          } catch (deleteErr) {
            cardSyncOk = false;
            cardSyncMessage = toMessage(deleteErr);
            logger.warn("ISAPI 刪除多餘卡片失敗", {
              deviceId,
              employeeNo: person.employeeNo,
              cardNo: staleCardNo,
              error: cardSyncMessage,
            });
          }
        }
      } catch (searchErr) {
        logger.warn("ISAPI 查詢卡片失敗（略過刪除多餘卡）", {
          deviceId,
          employeeNo: person.employeeNo,
          error: toMessage(searchErr),
        });
      }
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "card",
        status: cardSyncOk ? "success" : "failed",
        hash: cardsHash,
        syncedAt: new Date(),
        lastErrorMessage: cardSyncOk ? null : cardSyncMessage,
      });
      reporter?.finishOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "card",
        startedAt,
        ok: cardSyncOk,
        message: cardSyncMessage,
      });
      if (!cardSyncOk) {
        pushPersonSyncWarning(warnings, person, {
          type: "card",
          deviceId,
          deviceName: options?.deviceNameById?.get?.(Number(deviceId)) || null,
          message: `卡片設定失敗：${cardSyncMessage}`,
        });
      }
    } catch (cardErr) {
      const message = normalizeIsapiErrorMessage(toMessage(cardErr));
      logger.warn("ISAPI 綁定卡片失敗", {
        deviceId,
        employeeNo: person.employeeNo,
        error: message,
      });
      pushPersonSyncWarning(warnings, person, {
        type: "card",
        deviceId,
        deviceName: options?.deviceNameById?.get?.(Number(deviceId)) || null,
        message: `卡片設定失敗：${message}`,
      });
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employeeNo,
        step: "card",
        status: "failed",
        hash: cardsHash,
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

  // 指紋同步：FingerPrint/SetUp
  const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
  const fingerprintHash = personDeviceSyncStateService.hashFingerprint({
    fingerprints: fps,
  });
  const lastFpHash = stateRow?.fingerprint_hash
    ? String(stateRow.fingerprint_hash)
    : null;
  const lastFpStatus = stateRow?.fingerprint_status
    ? String(stateRow.fingerprint_status)
    : null;
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

  const hasAnyFpTemplate = fps.some(
    (fp) => String(fp?.fingerData || "").trim() !== "",
  );
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
      message: "未變更",
    });
    return;
  }

  for (const fp of fps) {
    const fingerData =
      fp?.fingerData != null ? String(fp.fingerData).trim() : "";
    const fingerPrintID = Number(fp?.fingerPrintID) || 1;
    if (!fingerData) continue;

    const tplHash = personDeviceSyncStateService.hashFingerprintTemplate({
      fingerPrintID,
      fingerType: fp?.fingerType,
      fingerData,
    });
    const prev =
      fpDetail && typeof fpDetail === "object"
        ? fpDetail[String(fingerPrintID)]
        : null;
    const prevHash = prev?.hash != null ? String(prev.hash) : null;
    const prevStatus = prev?.status != null ? String(prev.status) : null;
    if (
      prevStatus === "success" &&
      prevHash &&
      tplHash &&
      prevHash === tplHash
    ) {
      reporter?.skipOp?.({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: `fingerprint:${fingerPrintID}`,
        message: "未變更",
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
        enableCardReader: Array.isArray(fp?.enableCardReader)
          ? fp.enableCardReader
          : [1],
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
      const message = normalizeIsapiErrorMessage(toMessage(fpErr));
      logger.warn("ISAPI 綁定指紋失敗", {
        deviceId,
        employeeNo: person.employeeNo,
        fingerPrintID,
        error: message,
      });
      pushPersonSyncWarning(warnings, person, {
        type: "fingerprint",
        deviceId,
        deviceName: options?.deviceNameById?.get?.(Number(deviceId)) || null,
        message: `指紋設定失敗：${message}`,
      });
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

function buildDevicePersonSyncTargets(
  currentEmployeeNos,
  targetList,
  targetEmployeeNos,
  platformSyncedEmployeeNos,
) {
  return {
    currentEmployeeNos,
    toSync: targetList.filter((p) => currentEmployeeNos.has(p.employeeNo)),
    toAdd: targetList.filter((p) => !currentEmployeeNos.has(p.employeeNo)),
    toDelete: personDeviceSyncStateService.filterDeletableEmployeeNos(
      currentEmployeeNos,
      targetEmployeeNos,
      platformSyncedEmployeeNos,
    ),
  };
}

/**
 * 將目標人員名單同步至多台門禁設備（新增／更新／刪除平台曾推送且已不在目標名單者）
 */
async function syncAccessDevicesWithPersons(
  deviceIds,
  targetList,
  warnings,
  reporter = null,
  options = {},
) {
  const locationId =
    options.locationId != null ? Number(options.locationId) : null;
  const targetEmployeeNos = new Set(
    (targetList || []).map((p) => String(p.employeeNo)),
  );
  const normalizedDeviceIds = [
    ...new Set(
      (deviceIds || [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
  if (!normalizedDeviceIds.length) return;

  const platformSyncedByDevice =
    await personDeviceSyncStateService.getSyncedEmployeeNosByDeviceIds(
      normalizedDeviceIds,
    );
  const deviceNameById = await getDeviceNameByIds(normalizedDeviceIds);
  reporter?.setTotals?.({
    targetPersonsTotal: (targetList || []).length,
    deviceTotal: normalizedDeviceIds.length,
  });

  // 讀設備全量 employeeNo 清單成本高：同一個 job 內加 TTL cache，避免重試/二次流程又打一次
  const employeeNosCacheTtlMs = 60_000;
  const employeeNosCache = new Map(); // deviceId -> { at:number, list:string[] }
  const fetchAllEmployeeNosFromDeviceCached = async (deviceId) => {
    const now = Date.now();
    const key = Number(deviceId);
    const cached = employeeNosCache.get(key) || null;
    if (
      cached &&
      employeeNosCacheTtlMs > 0 &&
      now - cached.at <= employeeNosCacheTtlMs &&
      Array.isArray(cached.list)
    ) {
      return cached.list;
    }
    const list = await fetchAllEmployeeNosFromDevice(deviceId);
    employeeNosCache.set(key, { at: now, list });
    return list;
  };

  // total ops：每台設備的 add + sync + delete（delete 以 employeeNo 筆數計）
  let estimatedTotalOps = 0;
  const deviceTargets = new Map();
  for (const deviceId of normalizedDeviceIds) {
    try {
      const targets = buildDevicePersonSyncTargets(
        new Set(await fetchAllEmployeeNosFromDeviceCached(deviceId)),
        targetList,
        targetEmployeeNos,
        platformSyncedByDevice.get(Number(deviceId)),
      );
      deviceTargets.set(deviceId, targets);
      estimatedTotalOps +=
        targets.toAdd.length + targets.toSync.length + targets.toDelete.length;
    } catch (err) {
      // 讀取清單失敗的設備會跳過，totalOps 先不加
      deviceTargets.set(deviceId, {
        currentEmployeeNos: null,
        toSync: [],
        toAdd: [],
        toDelete: [],
      });
    }
  }
  reporter?.setTotals?.({ totalOps: estimatedTotalOps });

  for (let i = 0; i < normalizedDeviceIds.length; i++) {
    const deviceId = normalizedDeviceIds[i];
    reporter?.markDevice?.({
      deviceId,
      deviceIndex: i + 1,
      deviceTotal: normalizedDeviceIds.length,
    });

    // 同步狀態（用於差異同步）：一次性抓取該設備下此地點所有目標人員的狀態
    const stateMap = await personDeviceSyncStateService.getStatesForDevice(
      deviceId,
      targetList.map((p) => p.employeeNo),
    );
    if (reporter && typeof reporter === "object") {
      reporter.__stateByEmployeeNo = stateMap;
    }

    let cached = deviceTargets.get(deviceId);
    if (!cached?.currentEmployeeNos) {
      try {
        cached = buildDevicePersonSyncTargets(
          new Set(await fetchAllEmployeeNosFromDeviceCached(deviceId)),
          targetList,
          targetEmployeeNos,
          platformSyncedByDevice.get(Number(deviceId)),
        );
        deviceTargets.set(deviceId, cached);
      } catch (err) {
        const message = normalizeIsapiErrorMessage(toMessage(err));
        logger.warn("ISAPI 讀取設備人員清單失敗（跳過該設備）", {
          deviceId,
          error: message,
        });
        warnings.push({
          type: "sync",
          ...(locationId != null ? { locationId } : {}),
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          message: `讀取設備人員清單失敗：${message}`,
        });
        continue;
      }
    }

    const { toSync, toAdd, toDelete } = cached;

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
        await syncPersonToDevice(deviceId, p, warnings, reporter, {
          forceUserInfo: true,
          deviceNameById,
        });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "add",
          stage: "person",
          startedAt,
          ok: true,
        });
      } catch (err) {
        const message = normalizeIsapiErrorMessage(toMessage(err));
        logger.warn("ISAPI 新增人員失敗", {
          deviceId,
          employeeNo: p.employeeNo,
          error: message,
        });
        pushPersonSyncWarning(warnings, p, {
          type: "add",
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          message: `新增失敗：${message}`,
        });
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
        await syncPersonToDevice(deviceId, p, warnings, reporter, { deviceNameById });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "update",
          stage: "person",
          startedAt,
          ok: true,
        });
      } catch (err) {
        const message = normalizeIsapiErrorMessage(toMessage(err));
        logger.warn("ISAPI 更新人員失敗", {
          deviceId,
          employeeNo: p.employeeNo,
          error: message,
        });
        pushPersonSyncWarning(warnings, p, {
          type: "update",
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          message: `更新失敗：${message}`,
        });
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
        await accessControlService.deleteUserInfo(deviceId, {
          employeeNoList: toDelete,
        });
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
        const message = normalizeIsapiErrorMessage(toMessage(err));
        logger.warn("ISAPI 刪除人員失敗", {
          deviceId,
          count: toDelete.length,
          error: message,
        });
        warnings.push({
          type: "delete",
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          message: `刪除失敗：${message}`,
        });
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
}

/**
 * 對單一地點執行同步：目標名單為來源，設備與之對齊（新增/更新姓名與人臉；刪除僅限平台曾同步且已不在名單者）
 * @returns {{ warnings: Array<{ type: string, employeeNo?: string, deviceId?: number, message: string }> }}
 */
async function syncLocation(locationId, reporter = null) {
  const warnings = [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  if (!devs) {
    throwApiError(C.PERSONNEL_SYNC_JOB_VALIDATION_FAILED, "該地點未設定門禁入口設備");
  }

  const persons =
    await personnelService.getPersonsWithAccessByLocationId(locationId);
  const targetList = persons.map((p) => ({
    employeeNo: String(p.employee_no),
    name: p.full_name || p.employee_no,
    face_url: p.face_url || null,
    config: p.config || null,
  }));

  const deviceIds = [
    ...new Set([...(devs.entryDeviceIds || []), ...(devs.exitDeviceIds || [])]),
  ];
  await syncAccessDevicesWithPersons(deviceIds, targetList, warnings, reporter, {
    locationId,
  });

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
  await syncAccessDevicesWithPersons(
    deviceIds,
    targetList,
    warnings,
    reporter,
  );
  return { warnings };
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

  // 建立 job（queued）
  void personSyncJobStore.createJob({
    jobId,
    jobType: "sync_location",
    locationId: Number.isFinite(locId) ? locId : null,
    status: "queued",
    progress,
    itemsMeta: { issuesTotal: 0, tailTotal: 0, issuesStored: 0, tailStored: 0 },
  });

  // 背景執行
  void (async () => {
    const startedAt = Date.now();
    const job = {
      jobId,
      locationId: locId,
      locationName: null,
      status: "running",
      createdAt: Date.now(),
      startedAt,
      finishedAt: null,
      progress,
      result: null,
      error: null,
    };

    try {
      await personSyncJobStore.updateJob(jobId, { status: "running", startedAt, progress });
      job.locationName = await getLocationName(job.locationId);

      const reporter = createLocationJobReporter(job, job.locationId);
      const result = await syncLocation(job.locationId, reporter);

      job.result = result;
      const finishedAt = Date.now();
      job.status = "completed";
      job.finishedAt = finishedAt;
      job.progress.currentDeviceId = null;
      job.progress.currentEmployeeNo = null;
      job.progress.currentAction = null;
      job.progress.currentStage = null;

      await personSyncJobStore.replaceWarnings(jobId, result?.warnings ?? [], job.locationId);
      await personSyncJobStore.updateJob(jobId, {
        status: "completed",
        finishedAt,
        progress: job.progress,
        result,
        error: null,
      });
    } catch (err) {
      const finishedAt = Date.now();
      job.status = "completed";
      job.finishedAt = finishedAt;
      job.error = { message: toMessage(err) };
      job.progress.currentDeviceId = null;
      job.progress.currentEmployeeNo = null;
      job.progress.currentAction = null;
      job.progress.currentStage = null;

      await personSyncJobStore.updateJob(jobId, {
        status: "completed",
        finishedAt,
        progress: job.progress,
        result: null,
        error: job.error,
      });
    }
  })();

  return { jobId };
}

async function getSyncLocationJobView(jobId, options = {}) {
  const job = await personSyncJobStore.getJob(jobId);
  if (!job) return null;

  const includeIssues = Boolean(options.includeIssues);
  const includeTail = Boolean(options.includeTail);
  const issuesLimit =
    options.issuesLimit != null ? Math.max(0, Math.trunc(Number(options.issuesLimit))) : null;
  const tailLimit =
    options.tailLimit != null ? Math.max(0, Math.trunc(Number(options.tailLimit))) : null;

  const locationName =
    job.locationId != null ? await getLocationName(Number(job.locationId)) : null;

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
    base.itemsMeta.issuesStored = Array.isArray(base.items) ? base.items.length : 0;
  }
  if (includeTail) {
    const page = await personSyncJobStore.listItems(jobId, "tail", {
      limit: tailLimit != null ? tailLimit : 200,
      offset: 0,
    });
    base.tailItems = page?.items ?? [];
    base.itemsMeta.tailStored = Array.isArray(base.tailItems) ? base.tailItems.length : 0;
  }

  // 若沒 includeIssues/includeTail，仍回傳 stored=0（避免額外查詢）
  return base;
}

async function getSyncLocationJobItems(jobId, type = "issues", { limit = 200, offset = 0 } = {}) {
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

  const employeeNos = list.map((p) => String(p.employee_no));
  const stateMaps = [];
  for (const did of ids) {
    stateMaps.push({
      deviceId: did,
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
        hash = personDeviceSyncStateService.hashFace({
          faceBuffer: buf && buf.length > 0 ? buf : null,
          faceUrl: null,
        });
      } else {
        hash = personDeviceSyncStateService.hashFace({ faceBuffer: null, faceUrl: u });
      }
    } catch (_e) {
      hash = personDeviceSyncStateService.hashFace({ faceBuffer: null, faceUrl: u });
    }
    faceHashCache.set(u, hash);
    return hash;
  };

  const aggStep = (eno, step, desired) => {
    const rows = stateMaps
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
    const hashKey =
      step === "userInfo"
        ? "user_info_hash"
        : step === "face"
          ? "face_hash"
          : step === "card"
            ? "card_hash"
            : "fingerprint_hash";
    let lastAt = null;
    let hasFailed = false;
    let hasSuccess = false;
    let successCount = 0;
    let matchCount = 0;
    for (const r of rows) {
      const st = r.row?.[statusKey] != null ? String(r.row[statusKey]) : "";
      if (st === "failed") hasFailed = true;
      if (st === "success") {
        hasSuccess = true;
        successCount += 1;
        const hv = r.row?.[hashKey] != null ? String(r.row[hashKey]) : "";
        if (desired != null && hv && hv === String(desired)) matchCount += 1;
      }
      const t = r.row?.[atKey] ? new Date(r.row[atKey]).getTime() : null;
      if (t != null && (lastAt == null || t > lastAt)) lastAt = t;
    }
    if (desired == null) return { status: "no_data", at: null };
    if (rows.length === 0) return { status: "success", at: null };
    if (hasFailed) return { status: "failed", at: lastAt };
    if (hasSuccess && successCount === rows.length && matchCount === rows.length)
      return { status: "unchanged", at: lastAt };
    if (hasSuccess) return { status: "success", at: lastAt };
    return { status: "success", at: lastAt };
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
    const desiredFaceHash = faceUrl ? await computeDesiredFaceHash(faceUrl) : null;

    const cardNos = resolveCardNos(ac);
    const desiredCardHash = cardNos.length
      ? personDeviceSyncStateService.hashCards({ cardNos })
      : null;

    const fps = Array.isArray(ac?.fingerprints) ? ac.fingerprints : [];
    const desiredFpHash = personDeviceSyncStateService.hashFingerprint({
      fingerprints: fps,
    });

    const steps = new Set();
    for (const { map } of stateMaps) {
      const row = map.get(employeeNo) || null;
      // 若該設備完全沒有紀錄，一律視為需同步（避免「後來加資料但仍顯示成功」）
      if (!row) {
        steps.add("user_info");
        if (faceUrl) steps.add("face");
        if (cardNos.length) steps.add("card");
        if (desiredFpHash) steps.add("fingerprint");
        continue;
      }

      const userOk =
        String(row.user_info_status || "") === "success" &&
        String(row.user_info_hash || "") === desiredUserInfoHash;
      if (!userOk) steps.add("user_info");

      if (faceUrl) {
        const faceOk =
          String(row.face_status || "") === "success" &&
          String(row.face_hash || "") === String(desiredFaceHash || "");
        if (!faceOk) steps.add("face");
      }

      if (cardNos.length) {
        const cardOk =
          String(row.card_status || "") === "success" &&
          String(row.card_hash || "") === String(desiredCardHash || "");
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
    const fingerprintCount = fps.filter(
      (fp) => fp && String(fp.fingerData || "").trim() !== "",
    ).length;
    const faceUrl = p?.face_url != null ? String(p.face_url).trim() : "";
    const employeeNo = String(p.employee_no);
    const n = needs[idx] || {
      needsSync: true,
      needsSyncSteps: ["user_info"],
      desired: { userInfoHash: null, faceHash: null, cardHash: null, fingerprintHash: null },
    };
    const { needsSync, needsSyncSteps, desired } = n;
    return {
      employee_no: employeeNo,
      full_name: p.full_name || "",
      has_face: faceUrl.length > 0,
      has_password: password.length > 0,
      has_card: cardNos.length > 0,
      fingerprint_count: fingerprintCount,
      needs_sync: needsSync,
      needs_sync_steps: needsSyncSteps,
      last_sync: {
        user_info: aggStep(employeeNo, "userInfo", desired?.userInfoHash ?? null),
        face: aggStep(employeeNo, "face", desired?.faceHash ?? null),
        card: aggStep(employeeNo, "card", desired?.cardHash ?? null),
        fingerprint: aggStep(employeeNo, "fingerprint", desired?.fingerprintHash ?? null),
      },
    };
  });
}

async function getSyncCandidatesForLocation(locationId) {
  const rows =
    await personnelService.getPersonsWithAccessByLocationId(locationId);
  const list = Array.isArray(rows) ? rows : [];
  const devs = await getPeopleCountingDevicesForLocation(locationId);
  const deviceIds = devs
    ? [
        ...new Set([
          ...(devs.entryDeviceIds || []),
          ...(devs.exitDeviceIds || []),
        ]),
      ]
    : [];
  return buildAccessSyncFieldsForPersons(list, deviceIds);
}

function startSyncAllLocationsJob() {
  const jobId = randomJobId();

  const progress = {
    total: 0,
    completed: 0,
    currentLocationId: null,
    currentLocationName: null,
  };

  void personSyncJobStore.createJob({
    jobId,
    jobType: "sync_all_locations",
    locationId: null,
    status: "queued",
    progress,
    itemsMeta: { issuesTotal: 0, tailTotal: 0, issuesStored: 0, tailStored: 0 },
  });

  void (async () => {
    const startedAt = Date.now();
    const job = {
      jobId,
      status: "running",
      createdAt: Date.now(),
      startedAt,
      finishedAt: null,
      progress,
      result: null,
      error: null,
    };

    try {
      await personSyncJobStore.updateJob(jobId, { status: "running", startedAt, progress });

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
          results.push({ locationId: loc.id, locationName: loc.name, warnings });
          for (const w of warnings || []) flatWarnings.push({ ...w, locationId: loc.id, locationName: loc.name });
        } catch (err) {
          const message = toMessage(err);
          logger.warn("同步地點失敗，跳過", { locationId: loc.id, error: message });
          const warnings = [{ type: "sync", message, locationId: loc.id, locationName: loc.name }];
          results.push({ locationId: loc.id, locationName: loc.name, warnings });
          flatWarnings.push(...warnings);
        } finally {
          job.progress.completed += 1;
          await personSyncJobStore.updateJob(jobId, { progress: job.progress });
        }
      }

      job.result = { synced: results.length, results };
      const finishedAt = Date.now();
      job.status = "completed";
      job.finishedAt = finishedAt;
      job.progress.currentLocationId = null;
      job.progress.currentLocationName = null;

      await personSyncJobStore.replaceWarnings(jobId, flatWarnings, null);
      await personSyncJobStore.updateJob(jobId, {
        status: "completed",
        finishedAt,
        progress: job.progress,
        result: job.result,
        error: null,
      });
    } catch (err) {
      const finishedAt = Date.now();
      job.status = "completed";
      job.finishedAt = finishedAt;
      job.error = { message: toMessage(err) };
      await personSyncJobStore.updateJob(jobId, {
        status: "completed",
        finishedAt,
        progress: job.progress,
        result: null,
        error: job.error,
      });
    }
  })();

  return { jobId };
}

async function getSyncAllLocationsJob(jobId) {
  const job = await personSyncJobStore.getJob(jobId);
  if (!job) return null;

  const itemsPage = await personSyncJobStore.listItems(jobId, "issues", { limit: 2000, offset: 0 });

  return {
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    // 保持既有欄位名（前端目前用 job.items）
    items: itemsPage?.items ?? [],
    progress: job.progress || { total: 0, completed: 0, currentLocationId: null, currentLocationName: null },
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
