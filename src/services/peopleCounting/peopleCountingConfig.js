/**
 * 人流統計地點設定（stats_reset_at、camera_mode、攝影機進／出）
 */
const { resolveStatsTimeRange } = require("../entryExit/resolveTimeOptions");
const { parseStatsResetAtField } = require("../entryExit/locationStatsReset");
const { ensureIntArray } = require("../location/locationShared");

/** isapi_camera：人流統計（分區）｜人臉辨識（人員群組＋進／出攝影機） */
const CAMERA_MODE = Object.freeze({
  PEOPLE_COUNTING: "people_counting",
  FACE_RECOGNITION: "face_recognition",
});

/**
 * @param {unknown} raw
 * @returns {"people_counting"|"face_recognition"}
 */
function normalizeCameraMode(raw) {
  const s = String(raw ?? "").trim();
  if (s === CAMERA_MODE.FACE_RECOGNITION) return CAMERA_MODE.FACE_RECOGNITION;
  return CAMERA_MODE.PEOPLE_COUNTING;
}

function isFaceRecognitionCameraMode(raw) {
  return normalizeCameraMode(raw) === CAMERA_MODE.FACE_RECOGNITION;
}

function uniquePositiveIds(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const id of ensureIntArray(list)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 解析 isapi_camera 攝影機清單。
 * face_recognition：進／出場攝影機；舊資料僅有 camera_device_ids 時視為全部進場。
 * people_counting：僅 camera_device_ids（分區人流）。
 *
 * @param {object} raw - snake 或 camel
 * @returns {{ cameraMode: string, entryCameraDeviceIds: number[], exitCameraDeviceIds: number[], cameraDeviceIds: number[] }}
 */
function resolvePeopleCountingCameraDevices(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const cameraMode = normalizeCameraMode(cfg.camera_mode ?? cfg.cameraMode);
  const legacyAll = ensureIntArray(
    cfg.camera_device_ids ?? cfg.cameraDeviceIds,
  );
  let entryCameraDeviceIds = ensureIntArray(
    cfg.entry_camera_device_ids ?? cfg.entryCameraDeviceIds,
  );
  let exitCameraDeviceIds = ensureIntArray(
    cfg.exit_camera_device_ids ?? cfg.exitCameraDeviceIds,
  );

  if (cameraMode === CAMERA_MODE.FACE_RECOGNITION) {
    if (
      entryCameraDeviceIds.length === 0 &&
      exitCameraDeviceIds.length === 0 &&
      legacyAll.length > 0
    ) {
      entryCameraDeviceIds = [...legacyAll];
    }
    return {
      cameraMode,
      entryCameraDeviceIds,
      exitCameraDeviceIds,
      cameraDeviceIds: uniquePositiveIds(
        entryCameraDeviceIds,
        exitCameraDeviceIds,
      ),
    };
  }

  return {
    cameraMode,
    entryCameraDeviceIds: [],
    exitCameraDeviceIds: [],
    cameraDeviceIds: legacyAll,
  };
}

/**
 * 依設備歸屬決定人臉進出方向（非交替推算）
 * @returns {'entry'|'exit'|null}
 */
function resolveFaceCameraDirection(deviceId, cameraDevices) {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const entry = new Set(cameraDevices?.entryCameraDeviceIds || []);
  const exit = new Set(cameraDevices?.exitCameraDeviceIds || []);
  if (entry.has(id)) return "entry";
  if (exit.has(id)) return "exit";
  return null;
}

/**
 * @param {object} raw - DB snake_case 或 API camelCase
 */
function parsePeopleCountingConfigFields(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const cameras = resolvePeopleCountingCameraDevices(cfg);
  return {
    statsResetAt: parseStatsResetAtField(raw),
    cameraMode: cameras.cameraMode,
    entryCameraDeviceIds: cameras.entryCameraDeviceIds,
    exitCameraDeviceIds: cameras.exitCameraDeviceIds,
    cameraDeviceIds: cameras.cameraDeviceIds,
  };
}

/**
 * 主畫面統計／logs 起算：max(營運日起點, stats_reset_at)
 * @param {{ start: Date, end: Date }} range
 * @param {string|null|undefined} statsResetAt
 */
function applyStatsResetToTimeRange(range, statsResetAt) {
  if (!statsResetAt) return range;
  const resetMs = new Date(statsResetAt).getTime();
  if (!Number.isFinite(resetMs)) return range;
  if (resetMs > range.start.getTime()) {
    return { start: new Date(resetMs), end: range.end };
  }
  return range;
}

/**
 * @param {object} [options] - startTime, endTime, timeRange
 * @param {string|null|undefined} statsResetAt
 */
function resolvePeopleCountingStatsTimeRange(options = {}, statsResetAt) {
  return applyStatsResetToTimeRange(
    resolveStatsTimeRange(options),
    statsResetAt,
  );
}

/** 營運日內 stats_reset_at 是否仍影響目前統計窗口（跨日後自動失效） */
function isStatsResetActive(statsResetAt) {
  if (!statsResetAt) return false;
  const opDay = resolveStatsTimeRange({});
  const effective = resolvePeopleCountingStatsTimeRange({}, statsResetAt);
  return effective.start.getTime() > opDay.start.getTime();
}

/** 讀寫 access_control 事件調閱攝影機（undefined＝未傳、null＝清除） */
function parseOptionalEventCameraDeviceId(value) {
  if (value === null) return null;
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/**
 * 主畫面 logs（未傳時間區間）時帶入 reset 起算點
 * @param {{ statsResetAt?: string|null }} cfg
 * @param {object} options
 */
function enrichOptionsWithStatsReset(cfg, options = {}) {
  if (options.startTime || options.endTime || options.timeRange) {
    return options;
  }
  if (!cfg.statsResetAt) return options;
  const { start, end } = resolvePeopleCountingStatsTimeRange(
    {},
    cfg.statsResetAt,
  );
  return {
    ...options,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

module.exports = {
  CAMERA_MODE,
  normalizeCameraMode,
  isFaceRecognitionCameraMode,
  resolvePeopleCountingCameraDevices,
  resolveFaceCameraDirection,
  parsePeopleCountingConfigFields,
  applyStatsResetToTimeRange,
  resolvePeopleCountingStatsTimeRange,
  enrichOptionsWithStatsReset,
  isStatsResetActive,
  parseOptionalEventCameraDeviceId,
};
