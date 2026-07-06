const db = require("../../database/db");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { throwApiError, causeDetails, rethrowIfApiError } = require("../../utils/apiErrors");
const {
  failLocationGet,
  failLocationCreate,
  failLocationUpdate,
  failLocationDelete,
} = require("../../utils/locationErrors");
const shared = require("./locationShared");
const systemOps = require("./locationSystemOps");

const {
  validateName,
  formatLocation,
  loadLocationSystems,
  handleUniqueConstraintError,
} = shared;

const { createLocationWithSystems, updateLocationWithSystems } = systemOps;
const {
  syncElevatorFloorsFromLocations,
} = require("../ladderSdk/sdkDoorService");
const {
  invalidateLocationCache: invalidateElevatorLocationCache,
} = require("../monitoring/elevatorLocationCache");

const locationLogger = logger.createLogger("locationLocationOps");

async function getLocationById(id) {
  try {
    const locations = await db.query("SELECT * FROM locations WHERE id = $1", [
      id,
    ]);

    if (locations.length === 0) {
      throwApiError(C.LOCATION_NOT_FOUND, "地點不存在");
    }

    const location = locations[0];
    const systems = await loadLocationSystems(id);

    return {
      location: formatLocation(location, systems),
    };
  } catch (error) {
    rethrowIfApiError(error);
    locationLogger.error("取得地點失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationGet("取得地點失敗", causeDetails(error));
  }
}

/**
 * 取得「人流統計（門禁來源）」可同步地點 + 入口/出口門禁設備（含名稱）
 * - syncable 定義：people_counting 且 entry_device_ids 長度 > 0
 * - 目的：前端不再對 /api/locations/:id 做 N 次請求
 * @returns {{ locations: Array<{ id: number, name: string, zone_name: string, entry_devices: Array<{id:number,name:string}>, exit_devices: Array<{id:number,name:string}> }> }}
 */
async function getPeopleCountingSyncableLocationsWithAccessControlDevices() {
  // 1) 先找可同步地點 + entry/exit device ids（JSONB）
  const rows = await db.query(
    `
      SELECT
        l.id,
        l.name,
        z.name AS zone_name,
        COALESCE(ls.system_config->'entry_device_ids', '[]'::jsonb) AS entry_device_ids,
        COALESCE(ls.system_config->'exit_device_ids', '[]'::jsonb) AS exit_device_ids
      FROM locations l
      INNER JOIN zones z ON l.zone_id = z.id
      INNER JOIN location_systems ls
        ON l.id = ls.location_id AND ls.system_type = 'people_counting'
      WHERE COALESCE(jsonb_array_length(ls.system_config->'entry_device_ids'), 0) > 0
      ORDER BY z.name, l.name
    `,
    [],
  );

  const toIntList = (jsonbArr) => {
    const arr = Array.isArray(jsonbArr) ? jsonbArr : [];
    return Array.from(
      new Set(
        arr
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Math.trunc(n)),
      ),
    );
  };

  const entryIdsByLoc = new Map();
  const exitIdsByLoc = new Map();
  const allDeviceIds = new Set();

  for (const r of rows || []) {
    const locId = Number(r.id);
    const entry = toIntList(r.entry_device_ids);
    const exit = toIntList(r.exit_device_ids);
    entryIdsByLoc.set(locId, entry);
    exitIdsByLoc.set(locId, exit);
    for (const id of entry) allDeviceIds.add(id);
    for (const id of exit) allDeviceIds.add(id);
  }

  // 2) 批次把 device id -> name 拉回來（只抓 access_control）
  const deviceIdList = Array.from(allDeviceIds);
  const deviceNameById = new Map();
  if (deviceIdList.length > 0) {
    const devRows = await db.query(
      `
        SELECT id, name
        FROM devices
        WHERE id = ANY($1::int[])
          AND type_code = 'access_control'
      `,
      [deviceIdList],
    );
    for (const d of devRows || []) {
      deviceNameById.set(
        Number(d.id),
        String(d.name || "").trim() || `#${d.id}`,
      );
    }
  }

  const mapDevices = (ids) =>
    (ids || []).map((id) => ({ id, name: deviceNameById.get(id) || `#${id}` }));

  const locations = (rows || []).map((r) => {
    const id = Number(r.id);
    const entryIds = entryIdsByLoc.get(id) || [];
    const exitIds = exitIdsByLoc.get(id) || [];
    return {
      id,
      name: r.name,
      zone_name: r.zone_name,
      entry_devices: mapDevices(entryIds),
      exit_devices: mapDevices(exitIds),
    };
  });

  return { locations };
}

/**
 * 取得「車輛進出（ISAPI 攝影機）」可同步地點 + 入口/出口攝影機（含名稱）
 */
async function getVehicleAccessSyncableLocationsWithIsapiCameras() {
  const rows = await db.query(
    `
      SELECT
        l.id,
        l.name,
        z.name AS zone_name,
        COALESCE(ls.system_config->'entry_camera_device_ids', '[]'::jsonb) AS entry_camera_device_ids,
        COALESCE(ls.system_config->'exit_camera_device_ids', '[]'::jsonb) AS exit_camera_device_ids
      FROM locations l
      INNER JOIN zones z ON l.zone_id = z.id
      INNER JOIN location_systems ls
        ON l.id = ls.location_id AND ls.system_type = 'vehicle_access'
      WHERE COALESCE(ls.system_config->>'data_source', '') = 'isapi_camera'
        AND (
          COALESCE(jsonb_array_length(ls.system_config->'entry_camera_device_ids'), 0) > 0
          OR COALESCE(jsonb_array_length(ls.system_config->'exit_camera_device_ids'), 0) > 0
        )
      ORDER BY z.name, l.name
    `,
    [],
  );

  const toIntList = (jsonbArr) => {
    const arr = Array.isArray(jsonbArr) ? jsonbArr : [];
    return Array.from(
      new Set(
        arr
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Math.trunc(n)),
      ),
    );
  };

  const entryIdsByLoc = new Map();
  const exitIdsByLoc = new Map();
  const allDeviceIds = new Set();

  for (const r of rows || []) {
    const locId = Number(r.id);
    const entry = toIntList(r.entry_camera_device_ids);
    const exit = toIntList(r.exit_camera_device_ids);
    entryIdsByLoc.set(locId, entry);
    exitIdsByLoc.set(locId, exit);
    for (const id of entry) allDeviceIds.add(id);
    for (const id of exit) allDeviceIds.add(id);
  }

  const deviceIdList = Array.from(allDeviceIds);
  const deviceNameById = new Map();
  if (deviceIdList.length > 0) {
    const devRows = await db.query(
      `
        SELECT id, name
        FROM devices
        WHERE id = ANY($1::int[])
          AND type_code = 'camera'
      `,
      [deviceIdList],
    );
    for (const d of devRows || []) {
      deviceNameById.set(
        Number(d.id),
        String(d.name || "").trim() || `#${d.id}`,
      );
    }
  }

  const mapDevices = (ids) =>
    (ids || []).map((id) => ({ id, name: deviceNameById.get(id) || `#${id}` }));

  const locations = (rows || []).map((r) => {
    const id = Number(r.id);
    return {
      id,
      name: r.name,
      zone_name: r.zone_name,
      entry_devices: mapDevices(entryIdsByLoc.get(id) || []),
      exit_devices: mapDevices(exitIdsByLoc.get(id) || []),
    };
  });

  return { locations };
}

/**
 * 建立地點（含系統）
 */
async function createLocation(locationData, userId) {
  try {
    const { zoneId, name, description, systems = [] } = locationData;

    validateName(name, "地點名稱");

    // 使用事務建立地點和系統
    let locationId;
    await db.transaction(async (query) => {
      locationId = await createLocationWithSystems(
        query,
        zoneId,
        locationData,
        userId,
      );
    });

    await syncElevatorFloorsFromLocations([locationData]);

    const result = await getLocationById(locationId);
    return {
      message: "地點建立成功",
      location: result.location,
    };
  } catch (error) {
    rethrowIfApiError(error);
    handleUniqueConstraintError(
      error,
      "unique_zone_location_name",
      C.LOCATION_NAME_DUPLICATE,
      "該區域已存在同名地點。由於地點是跨系統共用的，請直接使用該地點。",
    );
    locationLogger.error("建立地點失敗", {
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationCreate("建立地點失敗", causeDetails(error));
  }
}

/**
 * 更新地點（含系統）
 */
async function updateLocation(id, locationData, userId, options = {}) {
  try {
    // 檢查地點是否存在
    const existing = await db.query("SELECT * FROM locations WHERE id = $1", [
      id,
    ]);
    if (existing.length === 0) {
      throwApiError(C.LOCATION_NOT_FOUND, "地點不存在");
    }

    // 使用事務更新地點和系統
    let locationDeleted = false;
    await db.transaction(async (query) => {
      await updateLocationWithSystems(
        query,
        id,
        locationData,
        userId,
        options,
      );

      // 檢查地點是否已被刪除（因為變成無系統）
      const locationCheck = await query(
        "SELECT id FROM locations WHERE id = $1",
        [id],
      );
      locationDeleted = locationCheck.length === 0;
    });

    if (!locationDeleted) {
      await syncElevatorFloorsFromLocations([locationData]);
      invalidateElevatorLocationCache();
    }

    // 如果地點已被刪除（因為變成無系統），返回特殊訊息
    if (locationDeleted) {
      return {
        message: "地點已刪除（無系統關聯）",
        location: null,
      };
    }

    const result = await getLocationById(id);
    return {
      message: "地點更新成功",
      location: result.location,
    };
  } catch (error) {
    rethrowIfApiError(error);
    handleUniqueConstraintError(
      error,
      "unique_zone_location_name",
      C.LOCATION_NAME_DUPLICATE,
      "該區域已存在同名地點。由於地點是跨系統共用的，請直接使用該地點。",
    );
    locationLogger.error("更新地點失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationUpdate("更新地點失敗", causeDetails(error));
  }
}

/**
 * 刪除地點
 */
async function deleteLocation(id) {
  try {
    const result = await db.query(
      "DELETE FROM locations WHERE id = $1 RETURNING id",
      [id],
    );

    if (result.length === 0) {
      throwApiError(C.LOCATION_NOT_FOUND, "地點不存在");
    }

    shared.refreshAfterLocationOrZoneDelete(locationLogger);

    return {
      message: "地點刪除成功",
      id: String(id),
    };
  } catch (error) {
    rethrowIfApiError(error);
    locationLogger.error("刪除地點失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationDelete("刪除地點失敗", causeDetails(error));
  }
}

module.exports = {
  getLocationById,
  getPeopleCountingSyncableLocationsWithAccessControlDevices,
  getVehicleAccessSyncableLocationsWithIsapiCameras,
  createLocation,
  updateLocation,
  deleteLocation,
};
