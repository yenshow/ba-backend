/**
 * 車輛進出地點設定驗證（vehicle_access system_config）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { vehicleAccess: yscpVehicleFeature } = require("../../utils/yscpSystemFeature");
const { ensureIntArray } = require("../location/locationShared");
const {
  normalizeOperationMode,
  parseVehicleAccessConfigFields,
  applyVehicleAccessEpochOnSave,
} = require("./vehicleAccessConfig");
const { parseLaneId } = require("./normalizeVehicleDirection");

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
 * @param {number|null} excludeLocationId
 */
async function validateVehicleAccessConfig(
  systemConfig,
  excludeLocationId = null,
) {
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
  parseConfig,
  validateVehicleAccessConfig,
  applyVehicleAccessEpochOnSave,
  normalizeOperationMode,
};
