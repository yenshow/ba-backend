/**
 * 人員設備同步寫入（門禁 UserInfo／憑證、攝影機 FDLib）
 * Job 編排見 personSyncJobService.js
 */
const fsPromises = require("fs").promises;
const db = require("../../database/db");
const accessControlService = require("../accessControl/accessControlService");
const {
  buildIsapiValidPayloadFromPlatformValidity,
  listIsapiValidPayloadFallbacks,
  isIsapiValidContentError,
} = require("../accessControl/accessControlHelpers");
const isapiCameraFdLibService = require("../peopleCounting/isapiCameraFdLibService");
const logger = require("../../utils/logger").createLogger("PersonSyncDeviceOps");
const personDeviceSyncStateService = require("./personDeviceSyncStateService");
const { normalizePersistedStatus } = require("./syncStatusCodes");
const { getDeviceNameByIds } = require("../../utils/deviceHelpers");
const {
  resolveAccessCredentialCapabilities,
  getAccessCredentialCapabilitiesByDeviceIds,
} = require("../../utils/accessCredentialCapabilities");
const { pushPersonSyncWarning } = require("../../utils/personDisplayUtils");
const { resolveCardNos } = require("../../utils/accessControlCardsUtils");
const { assertSafeOutboundUrl } = require("../../utils/safeUrl");
const { resolveUploadFilePath } = require("../../utils/baDataPaths");
const {
  normalizeIsapiErrorMessage,
  isPermanentFaceModelingError,
  isPermanentCardEmployeeNoError,
  isDeviceBusyError,
  isTransientIsapiNetworkError,
  readStepErrorMessage,
} = require("./personnelIsapiErrorUtils");
const {
  STEP_DELAY_MS: SYNC_DELAY_MS,
  PERSON_BATCH_EVERY: SYNC_PERSON_BATCH_EVERY,
  PERSON_BATCH_PAUSE_MS: SYNC_PERSON_BATCH_PAUSE_MS,
  DELETE_USER_INFO_CHUNK_SIZE,
  DELETE_CHUNK_PAUSE_MS,
  TRANSIENT_RETRY_ATTEMPTS,
  TRANSIENT_RETRY_BASE_MS,
  TRANSIENT_BUSY_BASE_MS,
} = require("../../config/deviceSyncTiming");

function toMessage(err) {
  return err?.message ?? String(err);
}

function normalizePositiveIntIds(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n)),
    ),
  ];
}

/**
 * 取得設備上所有人員的 employeeNo 列表（分頁取完）
 */
async function fetchAllEmployeeNosFromDevice(deviceId) {
  const result = [];
  let position = 0;
  const maxResults = 50;
  for (;;) {
    const res = await withTransientRetry(
      () =>
        accessControlService.searchUserInfo(deviceId, {
          searchResultPosition: position,
          maxResults,
        }),
      { deviceId, stage: "searchUserInfo" },
    );
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
 * 對暫態網路／設備斷線錯誤做指數退避重試；業務永久錯直接拋出。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ deviceId?: number, employeeNo?: string, stage?: string }} [meta]
 * @returns {Promise<T>}
 */
async function withTransientRetry(fn, meta = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (
        !isTransientIsapiNetworkError(err) ||
        attempt >= TRANSIENT_RETRY_ATTEMPTS
      ) {
        throw err;
      }
      const busy = isDeviceBusyError(err);
      const baseMs = busy ? TRANSIENT_BUSY_BASE_MS : TRANSIENT_RETRY_BASE_MS;
      const waitMs = baseMs * 2 ** (attempt - 1);
      logger.warn("ISAPI 暫態錯誤，準備重試", {
        attempt,
        maxAttempts: TRANSIENT_RETRY_ATTEMPTS,
        waitMs,
        busy,
        deviceId: meta.deviceId ?? null,
        employeeNo: meta.employeeNo ?? null,
        stage: meta.stage ?? null,
        error: toMessage(err),
      });
      await delay(waitMs);
    }
  }
  throw lastErr;
}

/**
 * 設備 ISAPI 寫入／讀寫：暫態重試後再套用步間延遲。
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ deviceId?: number, employeeNo?: string, stage?: string }} [meta]
 * @returns {Promise<T>}
 */
async function deviceOp(fn, meta = {}) {
  const result = await withTransientRetry(fn, meta);
  await delay(SYNC_DELAY_MS);
  return result;
}

/**
 * UserInfo.Valid 依機種／韌體差異嘗試相容格式。
 * 同一 job 內記住該設備成功的變體，避免每人重試全部格式。
 */
async function updateUserInfoWithValidFallbacks({
  deviceId,
  employeeNo,
  name,
  password,
  canonicalValid,
  variantCache,
}) {
  const cache = variantCache instanceof Map ? variantCache : null;
  const cacheKey = Number(deviceId);
  const userInfoBase = {
    employeeNo,
    name,
    ...(password ? { password } : {}),
  };
  const tryValid = (valid) =>
    deviceOp(
      () =>
        accessControlService.updateUserInfo(deviceId, {
          ...userInfoBase,
          Valid: valid,
        }),
      { deviceId, employeeNo, stage: "userInfo" },
    );

  const cached = cache?.get(cacheKey) || null;
  if (cached) {
    try {
      return await tryValid(cached);
    } catch (err) {
      if (!isIsapiValidContentError(err)) throw err;
      cache.delete(cacheKey);
      logger.warn("門禁 Valid 格式對此設備失效，改試其他變體", {
        deviceId,
        employeeNo,
        error: toMessage(err),
      });
    }
  }

  const variants = listIsapiValidPayloadFallbacks(canonicalValid);
  let lastErr = null;
  for (let i = 0; i < variants.length; i++) {
    const valid = variants[i];
    try {
      const result = await tryValid(valid);
      if (cache) cache.set(cacheKey, valid);
      if (i > 0) {
        logger.info("門禁 UserInfo 改用相容 Valid 格式", {
          deviceId,
          employeeNo,
          variant: i,
          enable: valid.enable,
          hasTimeType: Boolean(valid.timeType),
          endTime: valid.endTime || null,
        });
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (!isIsapiValidContentError(err)) throw err;
    }
  }
  throw lastErr;
}

async function maybePauseAfterPersonOps(count) {
  if (
    SYNC_PERSON_BATCH_EVERY <= 0 ||
    count <= 0 ||
    count % SYNC_PERSON_BATCH_EVERY !== 0
  ) {
    return;
  }
  logger.info("人員同步批次歇息", {
    personOps: count,
    pauseMs: SYNC_PERSON_BATCH_PAUSE_MS,
  });
  await delay(SYNC_PERSON_BATCH_PAUSE_MS);
}

function chunkList(list, size) {
  const items = Array.isArray(list) ? list : [];
  const chunkSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function clearAccessSyncStatesForEmployees(deviceId, employeeNos) {
  const nos = (employeeNos || []).map((x) => String(x)).filter(Boolean);
  if (!nos.length) return;
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
      [Number(deviceId), nos],
    );
  } catch (_e) {
    // ignore cleanup failure; do not affect sync result
  }
}

// validity → ISAPI Valid payload：accessControlHelpers 做 SSOT

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
      return await fsPromises.readFile(fullPath);
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
  const credentials = resolveAccessCredentialCapabilities(
    options?.credentials ?? null,
  );
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

        await updateUserInfoWithValidFallbacks({
          deviceId,
          employeeNo: person.employeeNo,
          name: person.name,
          password,
          canonicalValid: validPayload,
          variantCache: options?.validVariantByDevice,
        });
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

  if (credentials.face) {
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
      const lastStatus = normalizePersistedStatus(stateRow?.face_status);
      const faceError = readStepErrorMessage(
        stateRow?.last_error_message,
        "face",
      );
      const faceUnchanged =
        lastHash && faceHash && lastHash === faceHash;
      if (lastStatus === "success" && faceUnchanged) {
        reporter?.skipOp?.({
          employeeNo: person.employeeNo,
          deviceId,
          action: "sync",
          stage: "face",
          message: "未變更",
        });
      } else if (
        lastStatus === "failed" &&
        faceUnchanged &&
        isPermanentFaceModelingError(faceError)
      ) {
        logger.debug("ISAPI 人臉未變更，略過已知建模失敗", {
          deviceId,
          employeeNo: person.employeeNo,
        });
        reporter?.skipOp?.({
          employeeNo: person.employeeNo,
          deviceId,
          action: "sync",
          stage: "face",
          message: faceError,
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
          await deviceOp(
            () =>
              accessControlService.updateFace(
                deviceId,
                person.employeeNo,
                imageBuffer,
              ),
            { deviceId, employeeNo: person.employeeNo, stage: "face" },
          );
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
  } else {
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "face",
      message: "設備不支援人臉",
    });
  }

  // 卡片同步：employeeNo -> cardNos（最多 5 張）
  if (credentials.card) {
  const cardNos = resolveCardNos(ac);
  const cardsHash = personDeviceSyncStateService.hashCards({ cardNos });
  const lastHash = stateRow?.card_hash ? String(stateRow.card_hash) : null;
  const lastStatus = stateRow?.card_status
    ? String(stateRow.card_status)
    : null;
  const cardError = readStepErrorMessage(stateRow?.last_error_message, "card");
  const cardUnchanged = Boolean(lastHash && cardsHash && lastHash === cardsHash);

  if (!cardNos.length) {
    try {
      const deviceCards = await withTransientRetry(
        () =>
          accessControlService.searchCardInfoByEmployee(
            deviceId,
            person.employeeNo,
          ),
        { deviceId, employeeNo: person.employeeNo, stage: "cardSearch" },
      );
      for (const staleCardNo of deviceCards) {
        try {
          await deviceOp(
            () => accessControlService.deleteCardInfo(deviceId, staleCardNo),
            {
              deviceId,
              employeeNo: person.employeeNo,
              stage: "cardDelete",
            },
          );
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
  } else if (lastStatus === "success" && cardUnchanged) {
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "card",
      message: "未變更",
    });
  } else if (
    lastStatus === "failed" &&
    cardUnchanged &&
    isPermanentCardEmployeeNoError(cardError)
  ) {
    logger.debug("ISAPI 卡片未變更，略過已知工號格式錯誤", {
      deviceId,
      employeeNo: person.employeeNo,
    });
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "card",
      message: cardError,
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
        await deviceOp(
          () =>
            accessControlService.setCardInfo(deviceId, {
              employeeNo: person.employeeNo,
              cardNo,
              cardType: "normalCard",
            }),
          { deviceId, employeeNo: person.employeeNo, stage: "cardSet" },
        );
      }
      try {
        const deviceCards = await withTransientRetry(
          () =>
            accessControlService.searchCardInfoByEmployee(
              deviceId,
              person.employeeNo,
            ),
          { deviceId, employeeNo: person.employeeNo, stage: "cardSearch" },
        );
        const desiredSet = new Set(cardNos);
        for (const staleCardNo of deviceCards) {
          if (desiredSet.has(staleCardNo)) continue;
          try {
            await deviceOp(
              () => accessControlService.deleteCardInfo(deviceId, staleCardNo),
              {
                deviceId,
                employeeNo: person.employeeNo,
                stage: "cardDeleteExtra",
              },
            );
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
  } else {
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "card",
      message: "設備不支援卡片",
    });
  }

  // 指紋同步：FingerPrint/SetUp
  if (!credentials.fingerprint) {
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "fingerprint",
      message: "設備不支援指紋",
    });
    return;
  }
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
      await deviceOp(
        () =>
          accessControlService.setFingerPrint(deviceId, {
            employeeNo: person.employeeNo,
            fingerPrintID,
            fingerType: fp?.fingerType || "normalFP",
            fingerData,
            enableCardReader: Array.isArray(fp?.enableCardReader)
              ? fp.enableCardReader
              : [1],
          }),
        {
          deviceId,
          employeeNo: person.employeeNo,
          stage: `fingerprint:${fingerPrintID}`,
        },
      );
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
  const credentialsByDeviceId =
    await getAccessCredentialCapabilitiesByDeviceIds(normalizedDeviceIds);
  const validVariantByDevice = new Map();
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
    let personWriteCount = 0;

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
          credentials: credentialsByDeviceId.get(Number(deviceId)),
          validVariantByDevice,
        });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "add",
          stage: "person",
          startedAt,
          ok: true,
        });
        personWriteCount += 1;
        await maybePauseAfterPersonOps(personWriteCount);
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
        await syncPersonToDevice(deviceId, p, warnings, reporter, {
          deviceNameById,
          credentials: credentialsByDeviceId.get(Number(deviceId)),
          validVariantByDevice,
        });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "update",
          stage: "person",
          startedAt,
          ok: true,
        });
        personWriteCount += 1;
        await maybePauseAfterPersonOps(personWriteCount);
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
      const deleteChunks = chunkList(toDelete, DELETE_USER_INFO_CHUNK_SIZE);
      const deletedOk = [];
      const deletedFailed = [];
      let lastDeleteError = null;

      for (let ci = 0; ci < deleteChunks.length; ci++) {
        const chunk = deleteChunks[ci];
        try {
          await deviceOp(
            () =>
              accessControlService.deleteUserInfo(deviceId, {
                employeeNoList: chunk,
              }),
            {
              deviceId,
              stage: `deleteUserInfo:${ci + 1}/${deleteChunks.length}`,
            },
          );
          deletedOk.push(...chunk);
          await clearAccessSyncStatesForEmployees(deviceId, chunk);
          for (const no of chunk) {
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
        } catch (err) {
          const message = normalizeIsapiErrorMessage(toMessage(err));
          lastDeleteError = message;
          deletedFailed.push(...chunk);
          logger.warn("ISAPI 刪除人員失敗（分批）", {
            deviceId,
            chunkIndex: ci + 1,
            chunkTotal: deleteChunks.length,
            count: chunk.length,
            error: message,
          });
          for (const no of chunk) {
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
        if (ci + 1 < deleteChunks.length && DELETE_CHUNK_PAUSE_MS > 0) {
          await delay(DELETE_CHUNK_PAUSE_MS);
        }
      }

      if (deletedFailed.length === 0) {
        reporter?.finishOp?.({
          employeeNo: null,
          deviceId,
          action: "delete",
          stage: `batch:${toDelete.length}`,
          startedAt,
          ok: true,
        });
      } else {
        const message =
          lastDeleteError ||
          `刪除部分失敗（成功 ${deletedOk.length}／失敗 ${deletedFailed.length}）`;
        logger.warn("ISAPI 刪除人員失敗", {
          deviceId,
          count: toDelete.length,
          succeeded: deletedOk.length,
          failed: deletedFailed.length,
          error: message,
        });
        warnings.push({
          type: "delete",
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          message: `刪除失敗：${message}（成功 ${deletedOk.length}／失敗 ${deletedFailed.length}）`,
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
      }
    }

    if (reporter && typeof reporter === "object") {
      reporter.__stateByEmployeeNo = null;
    }
  }
}

/**
 * 將單一人員人臉同步至攝影機 FDLib（pictureUpload）；無圖則略過寫入（不改門禁無臉 UX）
 */
async function syncPersonFaceToCamera(
  deviceId,
  person,
  warnings,
  reporter = null,
  options = {},
) {
  const stateByEmployeeNo = reporter?.__stateByEmployeeNo || null;
  const stateRow =
    stateByEmployeeNo && person?.employeeNo != null
      ? stateByEmployeeNo.get(String(person.employeeNo)) || null
      : null;
  const faceUrlRaw =
    person?.face_url != null ? String(person.face_url).trim() : "";
  const libMeta = options.libMeta || null;

  const imageBuffer = await resolveFaceUrlToBuffer(person.face_url);
  if (!faceUrlRaw || !imageBuffer || imageBuffer.length === 0) {
    if (faceUrlRaw) {
      const message = "平台大頭照無法讀取（檔案可能遺失或 URL 無效）";
      logger.warn("攝影機人臉：解析 face_url 失敗（略過）", {
        deviceId,
        employeeNo: person.employeeNo,
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
    return;
  }

  const isLocalUpload = faceUrlRaw.startsWith("/uploads/");
  const faceHash = personDeviceSyncStateService.hashFace({
    faceBuffer: isLocalUpload ? imageBuffer : null,
    faceUrl: isLocalUpload ? null : faceUrlRaw,
  });
  const lastHash = stateRow?.face_hash ? String(stateRow.face_hash) : null;
  const lastStatus = normalizePersistedStatus(stateRow?.face_status);
  if (
    lastStatus === "success" &&
    lastHash &&
    faceHash &&
    lastHash === faceHash
  ) {
    // 成功＋hash 未變直接略過（不 FDSearch）；設備被清空時需改圖或清 face 狀態才重傳
    reporter?.skipOp?.({
      employeeNo: person.employeeNo,
      deviceId,
      action: "sync",
      stage: "face",
      message: "未變更",
    });
    return;
  }

  const startedAt = reporter?.startOp
    ? reporter.startOp({
        employeeNo: person.employeeNo,
        deviceId,
        action: "sync",
        stage: "face",
      })
    : null;
  try {
    // 曾同步過才先刪再傳（刪除含 FDSearch；全新上傳略過）
    if (stateRow?.face_status || stateRow?.face_hash) {
      try {
        await withTransientRetry(
          () =>
            isapiCameraFdLibService.deleteByCustomHumanId(
              deviceId,
              person.employeeNo,
              libMeta,
            ),
          {
            deviceId,
            employeeNo: person.employeeNo,
            stage: "fdLibDeleteBeforeUpload",
          },
        );
      } catch (_e) {
        // 忽略：庫空或搜尋失敗時仍嘗試上傳
      }
    }
    await deviceOp(
      () =>
        isapiCameraFdLibService.pictureUpload(deviceId, {
          employeeNo: person.employeeNo,
          name: person.name,
          imageBuffer,
          FDID: libMeta?.FDID,
          faceLibType: libMeta?.faceLibType,
        }),
      { deviceId, employeeNo: person.employeeNo, stage: "fdLibUpload" },
    );
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
    logger.warn("攝影機 FDLib 上傳人臉失敗", {
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

/**
 * 將目標人員名單同步至多台人流攝影機（僅臉庫；刪除僅限平台曾同步且已不在目標名單者）
 */
async function syncCameraDevicesWithPersons(
  deviceIds,
  targetList,
  warnings,
  reporter = null,
  options = {},
) {
  const locationId =
    options.locationId != null ? Number(options.locationId) : null;
  const channelId =
    options.cameraChannelId != null ? Number(options.cameraChannelId) : 1;
  const targetEmployeeNos = new Set(
    (targetList || []).map((p) => String(p.employeeNo)),
  );
  const normalizedDeviceIds = normalizePositiveIntIds(deviceIds);
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

  let estimatedTotalOps = 0;
  for (const deviceId of normalizedDeviceIds) {
    const synced = platformSyncedByDevice.get(Number(deviceId)) || new Set();
    const toDelete = [...synced].filter(
      (no) => !targetEmployeeNos.has(String(no)),
    );
    estimatedTotalOps += (targetList || []).length + toDelete.length;
  }
  reporter?.setTotals?.({ totalOps: estimatedTotalOps });

  for (let i = 0; i < normalizedDeviceIds.length; i++) {
    const deviceId = normalizedDeviceIds[i];
    reporter?.markDevice?.({
      deviceId,
      deviceIndex: i + 1,
      deviceTotal: normalizedDeviceIds.length,
    });

    let libMeta = null;
    try {
      libMeta = await withTransientRetry(
        () => isapiCameraFdLibService.ensureFaceLib(deviceId),
        { deviceId, stage: "ensureFaceLib" },
      );
    } catch (err) {
      const message = normalizeIsapiErrorMessage(toMessage(err));
      logger.warn("攝影機人臉庫準備失敗（跳過該設備）", {
        deviceId,
        error: message,
      });
      warnings.push({
        type: "sync",
        ...(locationId != null ? { locationId } : {}),
        deviceId,
        deviceName: deviceNameById.get(Number(deviceId)) || null,
        message: `攝影機人臉庫準備失敗：${message}`,
      });
      continue;
    }

    // faceContrast 為比對規則；失敗不應阻擋 pictureUpload（設備可能已用網頁設定，或 XML schema 不同）
    try {
      await withTransientRetry(
        () =>
          isapiCameraFdLibService.ensureFaceContrast(deviceId, {
            channelId,
            FDID: libMeta.FDID,
            faceLibType: libMeta.faceLibType,
          }),
        { deviceId, stage: "ensureFaceContrast" },
      );
    } catch (err) {
      const message = normalizeIsapiErrorMessage(toMessage(err));
      logger.warn("攝影機 faceContrast 設定失敗（仍繼續上傳人臉）", {
        deviceId,
        error: message,
      });
      warnings.push({
        type: "sync",
        ...(locationId != null ? { locationId } : {}),
        deviceId,
        deviceName: deviceNameById.get(Number(deviceId)) || null,
        message: `faceContrast 設定失敗（人臉仍會上傳）：${message}`,
      });
    }

    const stateMap = await personDeviceSyncStateService.getStatesForDevice(
      deviceId,
      targetList.map((p) => p.employeeNo),
    );
    if (reporter && typeof reporter === "object") {
      reporter.__stateByEmployeeNo = stateMap;
    }

    let personWriteCount = 0;
    for (const p of targetList || []) {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: p.employeeNo,
            deviceId,
            action: "update",
            stage: "person",
          })
        : null;
      try {
        await syncPersonFaceToCamera(deviceId, p, warnings, reporter, {
          libMeta,
          deviceNameById,
        });
        reporter?.finishOp?.({
          employeeNo: p.employeeNo,
          deviceId,
          action: "update",
          stage: "person",
          startedAt,
          ok: true,
        });
        personWriteCount += 1;
        await maybePauseAfterPersonOps(personWriteCount);
      } catch (err) {
        const message = normalizeIsapiErrorMessage(toMessage(err));
        pushPersonSyncWarning(warnings, p, {
          type: "update",
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          message: `攝影機同步失敗：${message}`,
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

    const synced = platformSyncedByDevice.get(Number(deviceId)) || new Set();
    const toDelete = [...synced].filter(
      (no) => !targetEmployeeNos.has(String(no)),
    );

    for (const no of toDelete) {
      const startedAt = reporter?.startOp
        ? reporter.startOp({
            employeeNo: String(no),
            deviceId,
            action: "delete",
            stage: "person",
          })
        : null;
      try {
        await deviceOp(
          () =>
            isapiCameraFdLibService.deleteByCustomHumanId(deviceId, no, libMeta),
          { deviceId, employeeNo: String(no), stage: "fdLibDelete" },
        );
        await personDeviceSyncStateService.deleteSyncStates(deviceId, [no]);
        reporter?.finishOp?.({
          employeeNo: String(no),
          deviceId,
          action: "delete",
          stage: "person",
          startedAt,
          ok: true,
        });
      } catch (err) {
        const message = normalizeIsapiErrorMessage(toMessage(err));
        warnings.push({
          type: "delete",
          ...(locationId != null ? { locationId } : {}),
          deviceId,
          deviceName: deviceNameById.get(Number(deviceId)) || null,
          employeeNo: String(no),
          message: `攝影機刪除失敗：${message}`,
        });
        reporter?.finishOp?.({
          employeeNo: String(no),
          deviceId,
          action: "delete",
          stage: "person",
          startedAt,
          ok: false,
          message,
        });
      }
    }

    if (reporter && typeof reporter === "object") {
      reporter.__stateByEmployeeNo = null;
    }
  }
}

module.exports = {
  normalizePositiveIntIds,
  resolveFaceUrlToBuffer,
  syncAccessDevicesWithPersons,
  syncCameraDevicesWithPersons,
};
