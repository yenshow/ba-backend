const db = require("../../database/db");
const licenseService = require("../license/licenseService");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { createApiError, throwApiError } = require("../../utils/apiErrorMeta");
const { rethrowIfApiError } = require("../../utils/apiErrorMeta");
const shared = require("./locationShared");

const {
  validateName,
  assertValidSystemType,
  assignFlatSystemDeviceFields,
  assignFlatControllerFields,
  deviceIdsFromApiSystemConfig,
  deviceIdsFromDbSystemConfig,
  stripLegacyModbusDeviceId,
  deleteEmptyZoneIfNeeded,
} = shared;

const locationLogger = logger.createLogger("locationSystemOps");
const {
  validateVehicleAccessConfig,
  parseConfig,
  applyVehicleAccessEpochOnSave,
} = require("../vehicleAccess/vehicleAccessValidation");
const yscpVehicleFeature = require("../../utils/yscpVehicleAccessFeature");
const {
  ensureIntArray,
} = require("./locationShared");

async function validatePeopleCountingIsapiIfNeeded(systemConfig, locationId) {
  if ((systemConfig?.data_source || "yscp") !== "isapi_camera") return;
  // 目前規則：允許攝影機跨地點／跨系統重複使用（不在後端擋）。
  // 保留 ensureIntArray 以維持呼叫點兼容（有需要時可在此加回驗證）。
  ensureIntArray(systemConfig.camera_device_ids);
}

function peopleCountingRowConfigToMergeInput(raw) {
  if (!raw || typeof raw !== "object") return {};
  const c =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return {};
          }
        })()
      : raw;
  return {
    personGroupIds: c.person_group_ids,
    entryDoorIds: c.entry_door_ids,
    exitDoorIds: c.exit_door_ids,
    dataSource: c.data_source,
    entryDeviceIds: c.entry_device_ids,
    exitDeviceIds: c.exit_device_ids,
    cameraDeviceIds: Array.isArray(c.camera_device_ids)
      ? c.camera_device_ids
      : [],
    cameraChannelId: c.camera_channel_id,
    preferRegion: c.prefer_region,
    accessControlGroups: c.access_control_groups,
  };
}

/**
 * 僅以 incoming 已定義的鍵覆寫（undefined 表示未傳，保留 baseline）
 */
function shallowMergePeopleCountingConfig(baseline, incoming) {
  const out = { ...baseline };
  if (!incoming || typeof incoming !== "object") return out;
  for (const k of Object.keys(incoming)) {
    if (incoming[k] !== undefined) out[k] = incoming[k];
  }
  return out;
}

function buildSystemConfig(systemType, config) {
  switch (systemType) {
    case "environment": {
      const deviceIds = deviceIdsFromApiSystemConfig(config);
      return {
        device_ids: deviceIds,
        parameters: config.parameters || [],
      };
    }

    case "lighting":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
      };

    case "hvac":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        status_points: config.statusPoints || {},
      };

    case "air_circulation":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        equipment_kind: config.equipmentKind || "pump",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "air_circulation"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "drainage":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        equipment_kind: config.equipmentKind || "pump",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "drainage"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "power":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        equipment_kind: config.equipmentKind || "generator",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "generator"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "fire":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        equipment_kind: config.equipmentKind || "pump",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "sprinkler"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "emergency_rescue":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        equipment_kind: config.equipmentKind || "pump",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "sos"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "smoke_alarm":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: stripLegacyModbusDeviceId(config.modbus) || {},
        equipment_kind: config.equipmentKind || "detector",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "smoke"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "people_counting": {
      const {
        normalizeLogDisplayColumns,
        toStoredLogDisplayColumns,
      } = require("../peopleCounting/logDisplayColumns");
      const ids = Array.isArray(config.cameraDeviceIds)
        ? config.cameraDeviceIds
            .map((id) => Number(id))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
      return {
        person_group_ids: config.personGroupIds || [],
        entry_door_ids: Array.isArray(config.entryDoorIds)
          ? config.entryDoorIds
          : [],
        exit_door_ids: Array.isArray(config.exitDoorIds)
          ? config.exitDoorIds
          : [],
        data_source: config.dataSource || "yscp",
        entry_device_ids: Array.isArray(config.entryDeviceIds)
          ? config.entryDeviceIds
          : [],
        exit_device_ids: Array.isArray(config.exitDeviceIds)
          ? config.exitDeviceIds
          : [],
        camera_device_ids: ids,
        camera_channel_id: 1,
        prefer_region: config.preferRegion ?? false,
        access_control_groups: config.accessControlGroups || [], // 相容保留
        log_display_columns: (() => {
          const cols = toStoredLogDisplayColumns(
            normalizeLogDisplayColumns(config.logDisplayColumns),
          );
          return cols.length > 0 ? cols : undefined;
        })(),
      };
    }

    case "elevator": {
      const {
        normalizeLogDisplayColumns,
        toStoredLogDisplayColumns,
      } = require("../elevator/logDisplayColumns");
      const {
        validateElevatorFloorConfig,
      } = require("../elevator/elevatorFloorConfig");
      const validated = validateElevatorFloorConfig(config);
      const accessDeviceIds = Array.isArray(config.accessDeviceIds)
        ? config.accessDeviceIds
            .map((id) => Number(id))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const result = {
        device_ids: validated.deviceIds,
        access_device_ids: accessDeviceIds,
        log_display_columns: (() => {
          const cols = toStoredLogDisplayColumns(
            normalizeLogDisplayColumns(config.logDisplayColumns),
          );
          return cols.length > 0 ? cols : undefined;
        })(),
      };
      if (validated.floorCount != null) {
        result.floor_count = validated.floorCount;
        result.floor_names = validated.floorNames;
        result.floor_open_durations = validated.floorOpenDurations;
      }
      return result;
    }

    case "vehicle_access": {
      const {
        normalizeLogDisplayColumns,
        toStoredLogDisplayColumns,
      } = require("../vehicleAccess/logDisplayColumns");
      const entryCam = Array.isArray(config.entryCameraDeviceIds)
        ? config.entryCameraDeviceIds
            .map((id) => Number(id))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const exitCam = Array.isArray(config.exitCameraDeviceIds)
        ? config.exitCameraDeviceIds
            .map((id) => Number(id))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const ch =
        config.cameraChannelId != null &&
        Number.isFinite(Number(config.cameraChannelId))
          ? Math.trunc(Number(config.cameraChannelId))
          : 1;
      const vehicleGroupIds = Array.isArray(config.vehicleGroupIds)
        ? config.vehicleGroupIds
            .map((id) => Number(id))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const {
        normalizeOperationMode,
      } = require("../vehicleAccess/vehicleAccessConfig");
      return {
        data_source:
          config.dataSource === "isapi_camera" ? "isapi_camera" : "yscp",
        operation_mode: normalizeOperationMode(config.operationMode),
        stats_epoch_started_at: config.statsEpochStartedAt ?? undefined,
        stats_reset_at: config.statsResetAt ?? undefined,
        parking_capacity:
          config.parkingCapacity != null &&
          Number.isFinite(Number(config.parkingCapacity))
            ? Math.trunc(Number(config.parkingCapacity))
            : undefined,
        entry_lane_id: config.entryLaneId ?? null,
        exit_lane_id: config.exitLaneId ?? null,
        entry_camera_device_ids: entryCam,
        exit_camera_device_ids: exitCam,
        camera_channel_id: ch,
        vehicle_group_ids: vehicleGroupIds,
        log_display_columns: (() => {
          const cols = toStoredLogDisplayColumns(
            normalizeLogDisplayColumns(config.logDisplayColumns),
          );
          return cols.length > 0 ? cols : undefined;
        })(),
      };
    }

    default:
      return config || {};
  }
}

const CONTROLLER_QUOTA_SYSTEM_TYPES = new Set([
  "elevator",
  "lighting",
  "hvac",
  "air_circulation",
  "drainage",
  "power",
  "fire",
  "emergency_rescue",
]);

async function assertSystemLicensed(systemType) {
  const license = await licenseService.getLicenseState();
  const openAll = license?.activationMethod === "open_all";
  if (openAll) return;

  const activeKeys = licenseService.getActiveFeatureKeys();
  if (!activeKeys.includes(systemType)) {
    throw createApiError(C.DEVICE_UNSUPPORTED_FEATURE, `不支援的 system_type：${systemType}`);
  }

  const licensed =
    Array.isArray(license?.features) && license.features.includes(systemType);
  if (!licensed) {
    throw createApiError(C.FEATURE_NOT_LICENSED, `未授權功能：${systemType}`, {
      details: { feature: systemType },
    });
  }
}

async function assertControllerQuotaWithinLimit({
  query,
  systemType,
  nextDeviceId,
  currentDeviceId = null,
  excludeSystemId = null,
} = {}) {
  if (!CONTROLLER_QUOTA_SYSTEM_TYPES.has(systemType)) return;
  if (!nextDeviceId) return;
  if (currentDeviceId && Number(nextDeviceId) === Number(currentDeviceId))
    return;

  const license = await licenseService.getLicenseState();
  const openAll = license?.activationMethod === "open_all";
  if (openAll) return;

  const rawMax = license?.quotas?.[systemType]?.maxDevices;
  const max = rawMax == null ? null : Math.floor(Number(rawMax));
  const hasMax = Number.isFinite(max) && max >= 0;
  if (!hasMax) return;

  // 僅允許綁定 controller 類型設備（避免把用量算錯）
  const deviceRows = await query(
    `SELECT d.type_code
     FROM devices d
     WHERE d.id = $1`,
    [Number(nextDeviceId)],
  );
  if (deviceRows.length === 0) {
    throw createApiError(C.LOCATION_DEVICE_NOT_FOUND, "綁定的設備不存在");
  }
  if (deviceRows[0].type_code !== "controller") {
    throw createApiError(C.LOCATION_DEVICE_NOT_CONTROLLER, "此系統僅允許綁定 controller 類型設備");
  }

  const rows = await query(
    `SELECT
       COUNT(*)::int AS used,
       SUM(CASE WHEN device_id = $2 THEN 1 ELSE 0 END)::int AS has
     FROM (
       SELECT DISTINCT
        (ls.system_config->'device_ids'->>0)::int AS device_id
       FROM location_systems ls
       WHERE ls.system_type = $1
         AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
         AND ($3::int IS NULL OR ls.id <> $3::int)
     ) t`,
    [
      systemType,
      Number(nextDeviceId),
      excludeSystemId != null ? Number(excludeSystemId) : null,
    ],
  );

  const used = Number(rows?.[0]?.used ?? 0);
  const has = Number(rows?.[0]?.has ?? 0);
  if (used >= max && has === 0) {
    throw createApiError(C.LICENSE_QUOTA_EXCEEDED, "已達到授權配額上限", {
      details: { feature: systemType, used, max },
    });
  }
}

/**
 * 建立系統（用於事務內部）
 */
async function createSystem(query, locationId, system) {
  const { systemType, config = {} } = system;

  assertValidSystemType(systemType);

  let systemConfig = buildSystemConfig(systemType, config);

  if (
    systemType === "vehicle_access" &&
    yscpVehicleFeature.shouldSkipYscp(systemConfig.data_source)
  ) {
    throwApiError(
      C.PEOPLE_COUNTING_VALIDATION_FAILED,
      "YSCP 車輛資料源已關閉（ENABLE_YSCP_VEHICLE_ACCESS=false），請改用 ISAPI 車牌攝影機",
    );
  }

  if (systemType === "vehicle_access") {
    systemConfig = applyVehicleAccessEpochOnSave(systemConfig, null);
    await validateVehicleAccessConfig(systemConfig, locationId);
  }
  await validatePeopleCountingIsapiIfNeeded(systemConfig, locationId);

  // 授權/Quota（做法 B）：controller 類系統的用量以 location_systems 綁定計數
  await assertSystemLicensed(systemType);
  await assertControllerQuotaWithinLimit({
    query,
    systemType,
    nextDeviceId: Array.isArray(systemConfig?.device_ids)
      ? systemConfig.device_ids[0] ?? null
      : null,
  });

  const result = await query(
    `INSERT INTO location_systems (location_id, system_type, system_config)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [locationId, systemType, JSON.stringify(systemConfig)],
  );

  if (systemType === "vehicle_access") {
    require("../vehicleAccess/vehicleAccessService").refreshSubscribeAfterLocationChange();
    const vehiclePlateSyncService = require("../vehicleAccess/vehiclePlateSyncService");
    vehiclePlateSyncService.syncPlatesForLocation(locationId).catch((err) => {
      locationLogger.warn("vehicle plate sync after createSystem failed", {
        locationId,
        error: err?.message || String(err),
      });
    });
  }

  return result[0].id;
}

/**
 * 更新系統（用於事務內部）
 */
async function updateSystem(query, systemId, system) {
  const { systemType, config } = system;

  // 檢查系統是否存在
  const existing = await query(
    "SELECT system_type, system_config FROM location_systems WHERE id = $1",
    [systemId],
  );
  if (existing.length === 0) {
    throwApiError(
      C.LOCATION_SYSTEM_NOT_FOUND,
      `系統 ID ${systemId} 不存在`,
    );
  }

  const currentSystemType = existing[0].system_type;
  const currentSystemConfig =
    typeof existing[0].system_config === "string"
      ? (() => {
          try {
            return JSON.parse(existing[0].system_config);
          } catch {
            return {};
          }
        })()
      : existing[0].system_config || {};
  const currentDeviceId =
    deviceIdsFromDbSystemConfig(currentSystemConfig)[0] ?? null;
  const targetSystemType = systemType || currentSystemType;

  assertValidSystemType(targetSystemType);

  let effectiveConfig = config;
  if (
    targetSystemType === "people_counting" &&
    config &&
    typeof config === "object"
  ) {
    const baseline = peopleCountingRowConfigToMergeInput(
      existing[0]?.system_config,
    );
    effectiveConfig = shallowMergePeopleCountingConfig(baseline, config);
  }

  let systemConfig = buildSystemConfig(targetSystemType, effectiveConfig);

  const locRows = await query(
    "SELECT location_id FROM location_systems WHERE id = $1",
    [systemId],
  );
  const vaLocationId =
    locRows[0]?.location_id != null ? Number(locRows[0].location_id) : null;

  if (
    targetSystemType === "vehicle_access" &&
    yscpVehicleFeature.shouldSkipYscp(systemConfig.data_source)
  ) {
    return;
  }

  if (targetSystemType === "vehicle_access") {
    systemConfig = applyVehicleAccessEpochOnSave(
      systemConfig,
      currentSystemType === "vehicle_access" ? currentSystemConfig : null,
    );
    await validateVehicleAccessConfig(systemConfig, vaLocationId);
  }
  await validatePeopleCountingIsapiIfNeeded(systemConfig, vaLocationId);

  await assertSystemLicensed(targetSystemType);
  await assertControllerQuotaWithinLimit({
    query,
    systemType: targetSystemType,
    nextDeviceId: Array.isArray(systemConfig?.device_ids)
      ? systemConfig.device_ids[0] ?? null
      : null,
    currentDeviceId:
      targetSystemType === currentSystemType ? currentDeviceId : null,
    excludeSystemId: systemId,
  });

  await query(
    `UPDATE location_systems
     SET system_type = $1, system_config = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [targetSystemType, JSON.stringify(systemConfig), systemId],
  );

  if (targetSystemType === "vehicle_access") {
    require("../vehicleAccess/vehicleAccessService").refreshSubscribeAfterLocationChange();
    if (vaLocationId != null) {
      const vehiclePlateSyncService = require("../vehicleAccess/vehiclePlateSyncService");
      vehiclePlateSyncService.syncPlatesForLocation(vaLocationId).catch((err) => {
        locationLogger.warn("vehicle plate sync after updateSystem failed", {
          locationId: vaLocationId,
          error: err?.message || String(err),
        });
      });
    }
  }
}

/**
 * 建立地點和系統（用於事務內部）
 * 如果地點已存在，則使用現有地點並添加系統（支援跨系統共用）
 */
async function createLocationWithSystems(query, zoneId, location, userId) {
  const { name, description, systems = [], locationType } = location;

  // 如果沒有 systems 但有 locationType，自動轉換為 systems 陣列（向後兼容）
  let finalSystems = systems;
  if (finalSystems.length === 0 && locationType) {
    const {
      deviceId,
      deviceIds,
      parameters,
      location: locationXY,
      modbus,
      personGroupIds,
      entryDoorIds,
      exitDoorIds,
      dataSource,
      entryDeviceIds,
      exitDeviceIds,
      accessControlGroups,
      entryLaneId,
      exitLaneId,
      entryCameraDeviceIds,
      exitCameraDeviceIds,
      cameraChannelId,
      config,
      equipmentKind,
      viewCategory,
      statusPoints,
    } = location;

    // 如果有現成的 config，直接使用
    if (config) {
      finalSystems = [{ systemType: locationType, config }];
    } else {
      // 否則從 location 物件中提取配置
      const systemConfig = {};
      switch (locationType) {
        case "environment":
          assignFlatSystemDeviceFields(systemConfig, deviceId, deviceIds);
          if (parameters !== undefined) systemConfig.parameters = parameters;
          break;
        case "lighting":
          assignFlatSystemDeviceFields(systemConfig, deviceId, deviceIds);
          if (locationXY !== undefined) systemConfig.location = locationXY;
          if (modbus !== undefined) systemConfig.modbus = modbus;
          break;
        case "hvac":
        case "air_circulation":
        case "drainage":
        case "power":
        case "fire":
        case "emergency_rescue":
        case "smoke_alarm":
          assignFlatControllerFields(systemConfig, {
            deviceId,
            deviceIds,
            locationXY,
            modbus,
            equipmentKind,
            viewCategory,
            statusPoints,
          });
          break;
        case "people_counting":
          if (personGroupIds !== undefined)
            systemConfig.personGroupIds = personGroupIds;
          if (entryDoorIds !== undefined)
            systemConfig.entryDoorIds = entryDoorIds;
          if (exitDoorIds !== undefined) systemConfig.exitDoorIds = exitDoorIds;
          if (dataSource !== undefined) systemConfig.dataSource = dataSource;
          if (entryDeviceIds !== undefined)
            systemConfig.entryDeviceIds = entryDeviceIds;
          if (exitDeviceIds !== undefined)
            systemConfig.exitDeviceIds = exitDeviceIds;
          if (accessControlGroups !== undefined)
            systemConfig.accessControlGroups = accessControlGroups;
          break;
        case "elevator": {
          assignFlatSystemDeviceFields(systemConfig, deviceId, deviceIds);
          const acIds =
            location.accessDeviceIds ?? location.access_device_ids;
          if (acIds !== undefined) {
            systemConfig.accessDeviceIds = Array.isArray(acIds)
              ? acIds
                  .map((id) => Number(id))
                  .filter((n) => Number.isFinite(n) && n > 0)
              : [];
          }
          const fc = location.floorCount ?? location.floor_count;
          const fn = location.floorNames ?? location.floor_names;
          const fod =
            location.floorOpenDurations ?? location.floor_open_durations;
          if (fc !== undefined) systemConfig.floorCount = fc;
          if (fn !== undefined) systemConfig.floorNames = fn;
          if (fod !== undefined) systemConfig.floorOpenDurations = fod;
          if (location.logDisplayColumns !== undefined) {
            systemConfig.logDisplayColumns = location.logDisplayColumns;
          }
          break;
        }
        case "vehicle_access":
          if (entryLaneId !== undefined) systemConfig.entryLaneId = entryLaneId;
          if (exitLaneId !== undefined) systemConfig.exitLaneId = exitLaneId;
          if (dataSource !== undefined) systemConfig.dataSource = dataSource;
          if (entryCameraDeviceIds !== undefined)
            systemConfig.entryCameraDeviceIds = entryCameraDeviceIds;
          if (exitCameraDeviceIds !== undefined)
            systemConfig.exitCameraDeviceIds = exitCameraDeviceIds;
          if (cameraChannelId !== undefined)
            systemConfig.cameraChannelId = cameraChannelId;
          break;
      }

      if (Object.keys(systemConfig).length > 0) {
        finalSystems = [{ systemType: locationType, config: systemConfig }];
      }
    }
  }

  const trimmedName = validateName(name, "地點名稱");

  // 檢查地點是否已存在（同一區域內）
  const existingLocation = await query(
    "SELECT id, description FROM locations WHERE zone_id = $1 AND name = $2",
    [zoneId, trimmedName],
  );

  let locationId;

  if (existingLocation.length > 0) {
    // 地點已存在，使用現有地點
    locationId = existingLocation[0].id;

    // 如果提供了新的 description，更新它
    if (
      description !== undefined &&
      description !== existingLocation[0].description
    ) {
      await query(
        `UPDATE locations SET description = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [description || null, locationId],
      );
    }
  } else {
    let sortOrderToInsert = 0;
    if (location.sortOrder !== undefined && location.sortOrder !== null) {
      const so = parseInt(location.sortOrder, 10);
      if (!Number.isNaN(so) && so >= 0) sortOrderToInsert = so;
    } else {
      const maxRow = await query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM locations WHERE zone_id = $1`,
        [zoneId],
      );
      sortOrderToInsert = maxRow[0]?.n ?? 0;
    }
    const locationResult = await query(
      `INSERT INTO locations (zone_id, name, description, created_by, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        zoneId,
        trimmedName,
        description || null,
        userId || null,
        sortOrderToInsert,
      ],
    );
    locationId = locationResult[0].id;
  }

  // 建立或更新系統（如果系統已存在則更新，否則建立）
  for (const system of finalSystems) {
    const { systemType } = system;
    if (!systemType) continue;

    // 檢查該地點是否已有相同類型的系統
    const existingSystem = await query(
      "SELECT id FROM location_systems WHERE location_id = $1 AND system_type = $2",
      [locationId, systemType],
    );

    if (existingSystem.length > 0) {
      // 系統已存在，更新它
      await updateSystem(query, existingSystem[0].id, system);
    } else {
      // 系統不存在，建立新系統
      await createSystem(query, locationId, system);
    }
  }

  return locationId;
}

/**
 * 更新地點和系統（用於事務內部）
 */
async function updateLocationWithSystems(query, locationId, location, userId) {
  const { name, description, systems } = location;

  // 更新地點基本資訊
  const updates = [];
  const params = [];
  let paramIndex = 1;

  if (name !== undefined) {
    const trimmedName = validateName(name, "地點名稱");

    // 檢查當前地點的名稱
    const currentLocation = await query(
      "SELECT name FROM locations WHERE id = $1",
      [locationId],
    );
    const currentLocationName = (currentLocation[0]?.name || "").trim();

    // 只有當名稱真正改變時才檢查重複並更新
    if (trimmedName !== currentLocationName) {
      // 檢查是否有其他地點使用相同名稱（同一區域內）
      const nameCheck = await query(
        "SELECT id FROM locations WHERE zone_id = (SELECT zone_id FROM locations WHERE id = $1) AND name = $2 AND id != $1",
        [locationId, trimmedName],
      );
      if (nameCheck.length > 0) {
        const duplicateError = new Error(
          `地點名稱 "${trimmedName}" 已被該區域的其他地點使用。由於地點是跨系統共用的，請直接使用該地點。`,
        );
        duplicateError.statusCode = 400;
        throw duplicateError;
      }
      updates.push(`name = $${paramIndex++}`);
      params.push(trimmedName);
    }
  }

  if (description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    params.push(description);
  }

  if (updates.length > 0) {
    params.push(locationId);
    await query(
      `UPDATE locations SET ${updates.join(
        ", ",
      )}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
      params,
    );
  }

  // 處理系統更新
  if (systems !== undefined) {
    // 查詢現有系統，建立兩個索引：
    // 1. 以 id 為鍵（用於更新現有系統）
    // 2. 以 (location_id, system_type) 為鍵（用於檢查唯一約束）
    const existingSystems = await query(
      "SELECT id, system_type FROM location_systems WHERE location_id = $1",
      [locationId],
    );
    const existingSystemIds = new Set(existingSystems.map((s) => String(s.id)));
    const existingSystemTypes = new Map(
      existingSystems.map((s) => [s.system_type, s.id]),
    );

    const updatedSystemIds = new Set();
    const processedSystemTypes = new Set();

    for (const system of systems) {
      const { systemType } = system;
      if (!systemType) {
        throwApiError(C.LOCATION_SYSTEM_TYPE_REQUIRED, "系統類型不能為空");
      }

      if (processedSystemTypes.has(systemType)) {
        throwApiError(
          C.LOCATION_SYSTEM_TYPE_DUPLICATE,
          `地點不能有多個相同類型的系統: ${systemType}`,
        );
      }
      processedSystemTypes.add(systemType);

      const systemId = system.id ? String(system.id) : null;
      const existingSystemIdByType = existingSystemTypes.get(systemType);

      // 決定是更新還是創建
      if (systemId && existingSystemIds.has(systemId)) {
        // 情況1: 有 id 且存在於資料庫中，直接更新
        await updateSystem(query, parseInt(systemId), system);
        updatedSystemIds.add(systemId);
      } else if (existingSystemIdByType) {
        // 情況2: 沒有 id 或 id 不存在，但該 system_type 已存在，更新現有系統
        await updateSystem(query, existingSystemIdByType, system);
        updatedSystemIds.add(String(existingSystemIdByType));
      } else {
        // 情況3: 該 system_type 不存在，創建新系統
        const newSystemId = await createSystem(query, locationId, system);
        updatedSystemIds.add(String(newSystemId));
      }
    }

    // 刪除不在更新列表中的系統
    const systemsToDelete = Array.from(existingSystemIds).filter(
      (id) => !updatedSystemIds.has(id),
    );
    if (systemsToDelete.length > 0) {
      await query(`DELETE FROM location_systems WHERE id = ANY($1::int[])`, [
        systemsToDelete.map((id) => parseInt(id)),
      ]);
    }

    // 檢查更新後地點是否還有系統，如果沒有則刪除地點
    const remainingSystems = await query(
      "SELECT id FROM location_systems WHERE location_id = $1",
      [locationId],
    );
    if (remainingSystems.length === 0) {
      // 獲取 zoneId 以便後續清理
      const locationInfo = await query(
        "SELECT zone_id FROM locations WHERE id = $1",
        [locationId],
      );
      const zoneId = locationInfo[0]?.zone_id;

      // 刪除無系統的地點
      await query("DELETE FROM locations WHERE id = $1", [locationId]);

      // 如果區域沒有地點了，刪除區域
      if (zoneId) {
        await deleteEmptyZoneIfNeeded(query, zoneId);
      }
    }
  }
}

module.exports = {
  peopleCountingRowConfigToMergeInput,
  shallowMergePeopleCountingConfig,
  buildSystemConfig,
  assertSystemLicensed,
  assertControllerQuotaWithinLimit,
  createSystem,
  updateSystem,
  createLocationWithSystems,
  updateLocationWithSystems,
  CONTROLLER_QUOTA_SYSTEM_TYPES,
};
