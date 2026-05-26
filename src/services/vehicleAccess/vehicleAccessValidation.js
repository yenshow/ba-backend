/**
 * 車輛進出地點設定驗證（vehicle_access system_config）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const yscpVehicleFeature = require("../../utils/yscpVehicleAccessFeature");
const {
  ensureIntArray,
  assertCamerasNotUsedByPeopleCountingIsapi,
} = require("../location/cameraDeviceConflict");

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
  return {
    dataSource: c.data_source === "isapi_camera" ? "isapi_camera" : "yscp",
    entryLaneId: c.entry_lane_id ?? null,
    exitLaneId: c.exit_lane_id ?? null,
    entryCameraDeviceIds: ensureIntArray(c.entry_camera_device_ids),
    exitCameraDeviceIds: ensureIntArray(c.exit_camera_device_ids),
    cameraChannelId:
      c.camera_channel_id != null && Number.isFinite(Number(c.camera_channel_id))
        ? Math.trunc(Number(c.camera_channel_id))
        : 1,
  };
}

/**
 * @param {object} systemConfig - DB JSON（snake_case）
 * @param {number|null} excludeLocationId
 */
async function validateVehicleAccessConfig(systemConfig, excludeLocationId = null) {
  const cfg = parseConfig(systemConfig);
  if (yscpVehicleFeature.shouldSkipYscp(cfg.dataSource)) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "YSCP 車輛資料源已關閉（ENABLE_YSCP_VEHICLE_ACCESS=false），請改用 ISAPI 車牌攝影機",
    );
  }
  if (cfg.dataSource === "yscp") {
    return cfg;
  }

  if (cfg.entryCameraDeviceIds.length === 0) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "ISAPI 車輛地點至少需要一個入口攝影機",
    );
  }

  const entrySet = new Set(cfg.entryCameraDeviceIds);
  const exitSet = new Set(cfg.exitCameraDeviceIds);
  for (const id of entrySet) {
    if (exitSet.has(id)) {
      throwApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        "入口與出口不可選擇同一台攝影機",
      );
    }
  }

  const allDevices = [...entrySet, ...exitSet];
  await assertCamerasNotUsedByPeopleCountingIsapi(allDevices, excludeLocationId);

  const dupRows = await db.query(
    `
      SELECT ls.location_id, ls.system_config
      FROM location_systems ls
      WHERE ls.system_type = 'vehicle_access'
        AND COALESCE(ls.system_config->>'data_source', 'yscp') = 'isapi_camera'
        AND ($1::int IS NULL OR ls.location_id <> $1::int)
    `,
    [excludeLocationId],
  );
  for (const r of dupRows || []) {
    const other = parseConfig(r.system_config);
    const otherIds = [...other.entryCameraDeviceIds, ...other.exitCameraDeviceIds];
    for (const id of allDevices) {
      if (otherIds.includes(id)) {
        throwApiError(
          C.PEOPLE_COUNTING_VALIDATION_FAILED,
          `攝影機設備 ${id} 已被其他車輛進出地點使用`,
        );
      }
    }
  }

  const typeRows = await db.query(
    `SELECT id, type_code FROM devices WHERE id = ANY(?::int[])`,
    [allDevices],
  );
  for (const d of typeRows || []) {
    if (String(d.type_code || "").toLowerCase() !== "camera") {
      throwApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        `設備 ${d.id} 必須為攝影機（type_code=camera）`,
      );
    }
  }

  return cfg;
}

module.exports = {
  parseConfig,
  validateVehicleAccessConfig,
};
