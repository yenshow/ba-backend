/**
 * 車輛進出地點設定：parse／validate／operation_mode／session epoch
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { vehicleAccess: yscpVehicleFeature } = require("../../utils/yscpSystemFeature");
const { ensureIntArray } = require("../location/locationShared");
const { parseStatsResetAtField } = require("../entryExit/locationStatsReset");
const { parseLaneId } = require("./vehicleAccessHelpers");

const OPERATION_MODES = ["construction_flow", "parking"];

function normalizeOperationMode(value) {
  return value === "parking" ? "parking" : "construction_flow";
}

/** @returns {number|null} 停車場在場上限（1–99999） */
function normalizeParkingCapacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.trunc(n), 99999);
}

/**
 * @param {object} raw - DB snake_case 或 API camelCase
 */
function parseVehicleAccessConfigFields(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const operationMode = normalizeOperationMode(
    c.operation_mode ?? c.operationMode,
  );
  const statsEpochStartedAt =
    c.stats_epoch_started_at ?? c.statsEpochStartedAt ?? null;
  const statsResetAt = parseStatsResetAtField(c);
  const parkingCapacity = normalizeParkingCapacity(
    c.parking_capacity ?? c.parkingCapacity,
  );
  return {
    operationMode,
    statsEpochStartedAt:
      statsEpochStartedAt != null ? String(statsEpochStartedAt) : null,
    statsResetAt: statsResetAt != null ? String(statsResetAt) : null,
    parkingCapacity,
  };
}

/**
 * Session／主畫面 logs 起算：max(stats_reset_at, stats_epoch_started_at)
 * @param {{ operationMode: string, statsEpochStartedAt?: string|null, statsResetAt?: string|null }} cfg
 * @param {string|Date|null} [locationCreatedAt]
 * @returns {string|null} ISO8601
 */
function getEffectiveSince(cfg, locationCreatedAt) {
  const resetMs = cfg.statsResetAt
    ? new Date(cfg.statsResetAt).getTime()
    : 0;
  let epochMs = cfg.statsEpochStartedAt
    ? new Date(cfg.statsEpochStartedAt).getTime()
    : 0;
  if (
    cfg.operationMode === "parking" &&
    !Number.isFinite(epochMs) &&
    locationCreatedAt
  ) {
    epochMs = new Date(locationCreatedAt).getTime();
  }
  const sinceMs = Math.max(
    Number.isFinite(resetMs) ? resetMs : 0,
    Number.isFinite(epochMs) ? epochMs : 0,
  );
  if (!sinceMs) return null;
  return new Date(sinceMs).toISOString();
}

/**
 * 儲存前合併 epoch（首次設為 parking 寫入 stats_epoch_started_at）
 * @param {object} systemConfig - snake_case（將寫入 DB）
 * @param {object|null} previousConfig - 既有 DB config
 */
function applyVehicleAccessEpochOnSave(systemConfig, previousConfig = null) {
  const prev = parseVehicleAccessConfigFields(previousConfig || {});
  const mode = normalizeOperationMode(systemConfig.operation_mode);
  const next = { ...systemConfig, operation_mode: mode };

  if (prev.statsEpochStartedAt) {
    next.stats_epoch_started_at = prev.statsEpochStartedAt;
  }
  if (prev.statsResetAt) {
    next.stats_reset_at = prev.statsResetAt;
  }

  if (mode === "parking" && !next.stats_epoch_started_at) {
    next.stats_epoch_started_at = new Date().toISOString();
  }

  if (mode !== "parking") {
    delete next.parking_capacity;
  } else {
    const cap = normalizeParkingCapacity(
      next.parking_capacity ?? prev.parkingCapacity,
    );
    if (cap != null) next.parking_capacity = cap;
  }

  return next;
}

function isEventAfterEffectiveSince(eventTimeIso, effectiveSinceIso) {
  if (!effectiveSinceIso) return true;
  const eventMs = new Date(eventTimeIso).getTime();
  const sinceMs = new Date(effectiveSinceIso).getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(sinceMs)) return true;
  return eventMs > sinceMs;
}

function parseConfig(config) {
  const c =
    typeof config === "string"
      ? (() => {
          try {
            return JSON.parse(config);
          } catch {
            return {};
          }
        })()
      : config || {};
  const modeFields = parseVehicleAccessConfigFields(c);
  return {
    dataSource: c.data_source === "isapi_camera" ? "isapi_camera" : "yscp",
    operationMode: modeFields.operationMode,
    statsEpochStartedAt: modeFields.statsEpochStartedAt,
    statsResetAt: modeFields.statsResetAt,
    parkingCapacity: modeFields.parkingCapacity,
    entryLaneId: c.entry_lane_id ?? null,
    exitLaneId: c.exit_lane_id ?? null,
    entryCameraDeviceIds: ensureIntArray(c.entry_camera_device_ids),
    exitCameraDeviceIds: ensureIntArray(c.exit_camera_device_ids),
    cameraChannelId:
      c.camera_channel_id != null &&
      Number.isFinite(Number(c.camera_channel_id))
        ? Math.trunc(Number(c.camera_channel_id))
        : 1,
    vehicleGroupIds: ensureIntArray(c.vehicle_group_ids),
  };
}

/**
 * @param {object} systemConfig - DB JSON（snake_case）
 */
async function validateVehicleAccessConfig(systemConfig) {
  const cfg = parseConfig(systemConfig);

  if (cfg.operationMode === "parking" && cfg.dataSource !== "isapi_camera") {
    throwApiError(
      C.VEHICLE_ACCESS_VALIDATION_FAILED,
      "停車場模式僅允許 ISAPI 車牌攝影機資料來源",
    );
  }

  if (cfg.operationMode === "parking" && cfg.parkingCapacity == null) {
    throwApiError(
      C.VEHICLE_ACCESS_VALIDATION_FAILED,
      "停車場模式請填寫在場車輛上限（正整數）",
    );
  }

  if (
    yscpVehicleFeature.shouldSkipYscp(cfg.dataSource) ||
    cfg.dataSource === "yscp"
  ) {
    if (cfg.operationMode === "parking") {
      throwApiError(
        C.VEHICLE_ACCESS_VALIDATION_FAILED,
        "YSCP 車道地點不可設為停車場模式",
      );
    }
    const entry = parseLaneId(cfg.entryLaneId);
    const exit = parseLaneId(cfg.exitLaneId);
    if (entry == null) {
      throwApiError(
        C.VEHICLE_ACCESS_VALIDATION_FAILED,
        "YSCP 車輛地點至少需要設定入口車道",
      );
    }
    if (entry != null && exit != null && entry === exit) {
      throwApiError(
        C.VEHICLE_ACCESS_VALIDATION_FAILED,
        "入口與出口車道不可相同",
      );
    }
    return cfg;
  }

  if (cfg.entryCameraDeviceIds.length === 0) {
    throwApiError(
      C.VEHICLE_ACCESS_VALIDATION_FAILED,
      "ISAPI 車輛地點至少需要一個入口攝影機",
    );
  }

  const entrySet = new Set(cfg.entryCameraDeviceIds);
  const exitSet = new Set(cfg.exitCameraDeviceIds);
  for (const id of entrySet) {
    if (exitSet.has(id)) {
      throwApiError(
        C.VEHICLE_ACCESS_VALIDATION_FAILED,
        "入口與出口不可選擇同一台攝影機",
      );
    }
  }

  const allDevices = [...entrySet, ...exitSet];

  const typeRows = await db.query(
    `SELECT id, type_code FROM devices WHERE id = ANY(?::int[])`,
    [allDevices],
  );
  for (const d of typeRows || []) {
    if (String(d.type_code || "").toLowerCase() !== "camera") {
      throwApiError(
        C.VEHICLE_ACCESS_VALIDATION_FAILED,
        `設備 ${d.id} 必須為攝影機（type_code=camera）`,
      );
    }
  }

  return cfg;
}

module.exports = {
  OPERATION_MODES,
  normalizeOperationMode,
  normalizeParkingCapacity,
  parseVehicleAccessConfigFields,
  getEffectiveSince,
  applyVehicleAccessEpochOnSave,
  isEventAfterEffectiveSince,
  parseConfig,
  validateVehicleAccessConfig,
};
