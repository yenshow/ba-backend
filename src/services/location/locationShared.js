const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

// ========== 共用輔助函數 ==========

/**
 * 處理唯一性約束錯誤
 */
function handleUniqueConstraintError(error, constraintName, code, errorMessage) {
  if (error.code === "23505" && error.constraint === constraintName) {
    throwApiError(code, errorMessage);
  }
}

const VALID_LOCATION_SYSTEM_TYPES = [
  "environment",
  "lighting",
  "hvac",
  "air_circulation",
  "people_counting",
  "vehicle_access",
  "drainage",
  "power",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
  "elevator",
];

function assertValidSystemType(systemType) {
  if (!systemType) {
    throwApiError(C.LOCATION_SYSTEM_TYPE_REQUIRED, "系統類型不能為空");
  }
  if (!VALID_LOCATION_SYSTEM_TYPES.includes(systemType)) {
    throwApiError(
      C.LOCATION_SYSTEM_TYPE_INVALID,
      `無效的系統類型: ${systemType}`,
    );
  }
}

/**
 * 驗證名稱
 */
function validateName(name, fieldName = "名稱") {
  if (!name || name.trim().length === 0) {
    const code =
      fieldName === "區域名稱"
        ? C.LOCATION_ZONE_NAME_REQUIRED
        : C.LOCATION_NAME_REQUIRED;
    throwApiError(code, `${fieldName}不能為空`);
  }
  if (name.length > 100) {
    const code =
      fieldName === "區域名稱"
        ? C.LOCATION_ZONE_NAME_TOO_LONG
        : C.LOCATION_NAME_TOO_LONG;
    throwApiError(code, `${fieldName}長度不能超過 100 字元`);
  }
  return name.trim();
}

/** modbus_config 僅保留點位／連線；設備 ID 以 `device_ids` / API `deviceId` 為 SSOT */
function stripLegacyModbusDeviceId(modbus) {
  if (!modbus || typeof modbus !== "object") return undefined;
  const { deviceId: _legacy, ...rest } = modbus;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** DB SSOT：`system_config.device_ids`（不再讀 `device_id` / `deviceId`） */
function deviceIdsFromDbSystemConfig(config) {
  if (!config || typeof config !== "object") return [];
  if (!Array.isArray(config.device_ids)) return [];
  return config.device_ids
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 寫入 DB：`deviceIds` / `deviceId`（API camel）→ 正整數去重陣列 */
function deviceIdsFromApiSystemConfig(config) {
  if (!config || typeof config !== "object") return [];
  const ids = Array.isArray(config.deviceIds)
    ? config.deviceIds.filter((id) => id != null && !Number.isNaN(Number(id)))
    : config.deviceId != null && config.deviceId !== ""
      ? [config.deviceId]
      : [];
  return [
    ...new Set(
      ids
        .map((x) => Math.trunc(Number(x)))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
}

function assignFlatSystemDeviceFields(systemConfig, deviceId, deviceIds) {
  if (deviceIds !== undefined) systemConfig.deviceIds = deviceIds;
  else if (deviceId !== undefined) systemConfig.deviceId = deviceId;
}

function assignFlatControllerFields(
  systemConfig,
  {
    deviceId,
    deviceIds,
    locationXY,
    modbus,
    equipmentKind,
    viewCategory,
    statusPoints,
  },
) {
  assignFlatSystemDeviceFields(systemConfig, deviceId, deviceIds);
  if (locationXY !== undefined) systemConfig.location = locationXY;
  if (modbus !== undefined) systemConfig.modbus = modbus;
  if (equipmentKind !== undefined) systemConfig.equipmentKind = equipmentKind;
  if (viewCategory !== undefined) systemConfig.viewCategory = viewCategory;
  if (statusPoints !== undefined) systemConfig.statusPoints = statusPoints;
}

/** 將任意值陣列轉為正整數陣列（去除 NaN / <=0，並截斷為 int） */
function ensureIntArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
}

/**
 * 格式化系統配置為前端格式
 */
function formatSystem(system) {
  const config =
    typeof system.system_config === "string"
      ? JSON.parse(system.system_config)
      : system.system_config || {};

  const baseSystem = {
    id: String(system.id),
    systemType: system.system_type,
  };

  // 根據系統類型格式化配置
  switch (system.system_type) {
    case "environment": {
      const deviceIds = deviceIdsFromDbSystemConfig(config);
      return {
        ...baseSystem,
        config: {
          deviceId: deviceIds[0],
          deviceIds: deviceIds.length ? deviceIds : undefined,
          parameters: config.parameters || [],
        },
      };
    }

    case "lighting": {
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
        },
      };
    }

    case "hvac": {
      const spHvac = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          statusPoints:
            spHvac &&
            typeof spHvac === "object" &&
            Object.keys(spHvac).length > 0
              ? spHvac
              : undefined,
        },
      };
    }

    case "air_circulation": {
      const sp = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          equipmentKind: config.equipment_kind || "pump",
          viewCategory:
            config.view_category === null || config.view_category === undefined
              ? "air_circulation"
              : String(config.view_category),
          statusPoints:
            sp && typeof sp === "object" && Object.keys(sp).length > 0
              ? sp
              : undefined,
        },
      };
    }

    case "drainage": {
      const sp = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          equipmentKind: config.equipment_kind || "pump",
          viewCategory:
            config.view_category === null || config.view_category === undefined
              ? "drainage"
              : String(config.view_category),
          statusPoints:
            sp && typeof sp === "object" && Object.keys(sp).length > 0
              ? sp
              : undefined,
        },
      };
    }

    case "power": {
      const spPow = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          equipmentKind: config.equipment_kind || "generator",
          viewCategory:
            config.view_category === null || config.view_category === undefined
              ? "generator"
              : String(config.view_category),
          statusPoints:
            spPow && typeof spPow === "object" && Object.keys(spPow).length > 0
              ? spPow
              : undefined,
        },
      };
    }

    case "fire": {
      const spFire = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          equipmentKind: config.equipment_kind || "pump",
          viewCategory:
            config.view_category === null || config.view_category === undefined
              ? "sprinkler"
              : String(config.view_category),
          statusPoints:
            spFire &&
            typeof spFire === "object" &&
            Object.keys(spFire).length > 0
              ? spFire
              : undefined,
        },
      };
    }

    case "emergency_rescue": {
      const spEr = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          equipmentKind: config.equipment_kind || "pump",
          viewCategory:
            config.view_category === null || config.view_category === undefined
              ? "sos"
              : String(config.view_category),
          statusPoints:
            spEr && typeof spEr === "object" && Object.keys(spEr).length > 0
              ? spEr
              : undefined,
        },
      };
    }

    case "smoke_alarm": {
      const spSmoke = config.status_points;
      const primary = deviceIdsFromDbSystemConfig(config)[0];
      return {
        ...baseSystem,
        config: {
          deviceId: primary,
          location: {
            x: config.location_x || 50.0,
            y: config.location_y || 50.0,
          },
          modbus: stripLegacyModbusDeviceId(config.modbus_config),
          equipmentKind: config.equipment_kind || "detector",
          viewCategory:
            config.view_category === null || config.view_category === undefined
              ? "smoke"
              : String(config.view_category),
          statusPoints:
            spSmoke &&
            typeof spSmoke === "object" &&
            Object.keys(spSmoke).length > 0
              ? spSmoke
              : undefined,
        },
      };
    }

    case "people_counting": {
      const {
        normalizeLogDisplayColumns,
      } = require("../peopleCounting/logDisplayColumns");
      return {
        ...baseSystem,
        config: {
          personGroupIds: config.person_group_ids || [],
          entryDoorIds: Array.isArray(config.entry_door_ids)
            ? config.entry_door_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          exitDoorIds: Array.isArray(config.exit_door_ids)
            ? config.exit_door_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          dataSource: config.data_source || "yscp",
          entryDeviceIds: Array.isArray(config.entry_device_ids)
            ? config.entry_device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          exitDeviceIds: Array.isArray(config.exit_device_ids)
            ? config.exit_device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          cameraDeviceIds: Array.isArray(config.camera_device_ids)
            ? config.camera_device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : undefined,
          cameraChannelId: config.camera_channel_id ?? undefined,
          preferRegion: config.prefer_region ?? undefined,
          accessControlGroups: config.access_control_groups || [], // 相容保留；門禁人員改由人員管理 API 處理
          logDisplayColumns: normalizeLogDisplayColumns(config.log_display_columns),
        },
      };
    }

    case "elevator": {
      const {
        normalizeLogDisplayColumns,
      } = require("../elevator/logDisplayColumns");
      const {
        normalizeElevatorFloorConfig,
      } = require("../elevator/elevatorFloorConfig");
      const floors = normalizeElevatorFloorConfig(config);
      return {
        ...baseSystem,
        config: {
          deviceIds: Array.isArray(config.device_ids)
            ? config.device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          accessDeviceIds: Array.isArray(config.access_device_ids)
            ? config.access_device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          logDisplayColumns: normalizeLogDisplayColumns(
            config.log_display_columns,
          ),
          ...(floors.floorCount != null
            ? {
                floorCount: floors.floorCount,
                floorNames: floors.floorNames,
                floorOpenDurations: floors.floorOpenDurations,
              }
            : {}),
        },
      };
    }

    case "vehicle_access": {
      const {
        normalizeLogDisplayColumns,
      } = require("../vehicleAccess/logDisplayColumns");
      const {
        normalizeOperationMode,
      } = require("../vehicleAccess/vehicleAccessConfig");
      return {
        ...baseSystem,
        config: {
          dataSource:
            config.data_source === "isapi_camera" ? "isapi_camera" : "yscp",
          operationMode: normalizeOperationMode(config.operation_mode),
          statsEpochStartedAt: config.stats_epoch_started_at ?? undefined,
          statsResetAt: config.stats_reset_at ?? undefined,
          parkingCapacity: config.parking_capacity ?? undefined,
          entryLaneId: config.entry_lane_id ?? undefined,
          exitLaneId: config.exit_lane_id ?? undefined,
          entryCameraDeviceIds: Array.isArray(config.entry_camera_device_ids)
            ? config.entry_camera_device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          exitCameraDeviceIds: Array.isArray(config.exit_camera_device_ids)
            ? config.exit_camera_device_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          cameraChannelId: config.camera_channel_id ?? 1,
          vehicleGroupIds: Array.isArray(config.vehicle_group_ids)
            ? config.vehicle_group_ids
                .map((id) => Number(id))
                .filter((n) => Number.isFinite(n) && n > 0)
            : [],
          logDisplayColumns: normalizeLogDisplayColumns(
            config.log_display_columns,
          ),
        },
      };
    }

    default:
      return {
        ...baseSystem,
        config: config,
      };
  }
}

/**
 * 格式化地點資料為前端格式（含所有系統）
 */
function formatLocation(location, systems = []) {
  const createdAt =
    location.created_at != null
      ? new Date(location.created_at).toISOString()
      : undefined;
  const sortOrder =
    location.sort_order != null ? Number(location.sort_order) : undefined;
  return {
    id: String(location.id),
    zoneId: String(location.zone_id),
    name: location.name,
    description: location.description || undefined,
    ...(createdAt ? { createdAt } : {}),
    ...(sortOrder !== undefined && !Number.isNaN(sortOrder)
      ? { sortOrder }
      : {}),
    systems: systems.map(formatSystem),
  };
}

/**
 * 格式化區域資料為前端格式
 */
function formatZone(zone, locations = []) {
  const sortOrder = zone.sort_order != null ? Number(zone.sort_order) : 0;
  return {
    id: String(zone.id),
    name: zone.name,
    buildingId: zone.building_id || undefined,
    imageUrl: zone.image_url || undefined,
    description: zone.description || undefined,
    sortOrder: Number.isNaN(sortOrder) ? 0 : sortOrder,
    locations: locations,
  };
}

/**
 * 載入地點的所有系統
 */
async function loadLocationSystems(locationId) {
  const systems = await db.query(
    `SELECT * FROM location_systems WHERE location_id = $1 ORDER BY created_at ASC`,
    [locationId],
  );
  return systems;
}

/**
 * 將查詢結果按地點分組（用於 JOIN 查詢）
 * @param {Array} rows - 查詢結果陣列（含地點和系統資料）
 * @returns {Map<number, Object>} 以地點 ID 為鍵的地點資料 Map
 */
function groupLocationRowsByLocation(rows) {
  const locationMap = new Map();

  for (const row of rows) {
    const locationId = row.id;

    // 如果地點還沒被加入 Map，先加入
    if (!locationMap.has(locationId)) {
      locationMap.set(locationId, {
        id: row.id,
        zone_id: row.zone_id,
        name: row.name,
        description: row.description,
        sort_order: row.sort_order,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        systems: [],
      });
    }

    // 如果有系統資料，加入系統陣列
    if (row.system_id) {
      locationMap.get(locationId).systems.push({
        id: row.system_id,
        location_id: row.location_id || locationId,
        system_type: row.system_type,
        system_config: row.system_config,
        created_at: row.system_created_at,
        updated_at: row.system_updated_at,
      });
    }
  }

  return locationMap;
}

/**
 * 載入區域的地點（含所有系統）
 * 優化：使用 JOIN 一次查詢地點和系統，避免 N+1 問題
 */
async function loadZoneLocations(zoneId, systemType = null) {
  let sql = `
    SELECT 
      l.id,
      l.zone_id,
      l.name,
      l.description,
      l.sort_order,
      l.created_by,
      l.created_at,
      l.updated_at,
      ls.id as system_id,
      ls.system_type,
      ls.system_config,
      ls.created_at as system_created_at,
      ls.updated_at as system_updated_at
    FROM locations l
    LEFT JOIN location_systems ls ON l.id = ls.location_id
    WHERE l.zone_id = $1
  `;
  const params = [zoneId];

  if (systemType) {
    // 只返回有該系統類型的地點
    sql += ` AND EXISTS (
      SELECT 1 FROM location_systems ls2 
      WHERE ls2.location_id = l.id AND ls2.system_type = $2
    )`;
    params.push(systemType);
  }

  sql += " ORDER BY l.sort_order ASC, l.id ASC, ls.created_at ASC";

  const rows = await db.query(sql, params);
  const locationMap = groupLocationRowsByLocation(rows);

  // 格式化為前端格式（維持 sort_order 順序：Map 依 rows 首次出現順序）
  const locationsWithSystems = Array.from(locationMap.values()).map(
    (location) => formatLocation(location, location.systems),
  );

  return locationsWithSystems;
}

/**
 * 驗證並過濾有效的地點
 */
function getValidLocations(locations) {
  return locations.filter((loc) => loc.name && loc.name.trim().length > 0);
}

/**
 * 刪除指定區域中無系統的地點（用於事務內部）
 */
async function deleteLocationsWithoutSystems(query, zoneId) {
  await query(
    `DELETE FROM locations 
     WHERE zone_id = $1 
     AND NOT EXISTS (SELECT 1 FROM location_systems WHERE location_id = locations.id)`,
    [zoneId],
  );
}

/**
 * 刪除指定地點列表中無系統的地點（用於事務內部）
 */
async function deleteLocationsByIdsWithoutSystems(query, locationIds) {
  if (locationIds.length === 0) return;
  await query(
    `DELETE FROM locations 
     WHERE id = ANY($1::int[]) 
     AND NOT EXISTS (SELECT 1 FROM location_systems WHERE location_id = locations.id)`,
    [locationIds],
  );
}

/**
 * 檢查並刪除空區域（用於事務內部）
 */
async function deleteEmptyZoneIfNeeded(query, zoneId) {
  const remainingLocations = await query(
    "SELECT id FROM locations WHERE zone_id = $1",
    [zoneId],
  );
  if (remainingLocations.length === 0) {
    await query("DELETE FROM zones WHERE id = $1", [zoneId]);
    return true;
  }
  return false;
}

module.exports = {
  handleUniqueConstraintError,
  assertValidSystemType,
  validateName,
  stripLegacyModbusDeviceId,
  deviceIdsFromDbSystemConfig,
  deviceIdsFromApiSystemConfig,
  assignFlatSystemDeviceFields,
  assignFlatControllerFields,
  ensureIntArray,
  formatSystem,
  formatLocation,
  formatZone,
  loadLocationSystems,
  groupLocationRowsByLocation,
  loadZoneLocations,
  VALID_LOCATION_SYSTEM_TYPES,
  getValidLocations,
  deleteLocationsWithoutSystems,
  deleteLocationsByIdsWithoutSystems,
  deleteEmptyZoneIfNeeded,
};
