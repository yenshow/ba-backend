/**
 * 刪除設備時，自地點 system_config 與警報攝影機聯動移除設備 ID 引用，並刷新訂閱。
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("Device Ref Cleanup");

const CONTROLLER_SYSTEM_TYPES = new Set([
  "environment",
  "lighting",
  "hvac",
  "air_circulation",
  "drainage",
  "power",
  "fire",
  "emergency_rescue",
  "smoke_alarm",
]);

/** 各 system_type 在 location_systems.system_config 內的設備 ID 欄位 */
const LOCATION_DEVICE_FIELDS = {
  people_counting: {
    arrays: [
      "entry_device_ids",
      "exit_device_ids",
      "camera_device_ids",
      "entry_camera_device_ids",
      "exit_camera_device_ids",
    ],
    roles: [],
    scalars: [],
  },
  vehicle_access: {
    arrays: ["entry_camera_device_ids", "exit_camera_device_ids"],
    roles: [],
    scalars: [],
  },
  elevator: {
    arrays: ["access_device_ids"],
    roles: ["ladder_device", "call_device", "floor_detection"],
    scalars: [],
  },
  access_security: {
    arrays: [],
    roles: [],
    scalars: ["indoor_device_id"],
  },
};

const parsePositiveInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const normalizeDeviceIds = (deviceIds) => {
  const values = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
  return [
    ...new Set(
      values.map((value) => parsePositiveInt(value)).filter(Boolean),
    ),
  ];
};

const parseJsonConfig = (raw) => {
  if (!raw) return {};
  if (typeof raw === "object") return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...parsed } : {};
  } catch {
    return {};
  }
};

const getLocationDeviceFields = (systemType) => {
  if (LOCATION_DEVICE_FIELDS[systemType]) {
    return LOCATION_DEVICE_FIELDS[systemType];
  }
  if (CONTROLLER_SYSTEM_TYPES.has(systemType)) {
    return { arrays: ["device_ids"], roles: [], scalars: [] };
  }
  return { arrays: [], roles: [], scalars: [] };
};

const stripFromIntArray = (arr, removeIds) => {
  if (!Array.isArray(arr)) {
    return { value: arr, changed: false };
  }
  const next = arr
    .map((value) => Number(value))
    .filter((n) => Number.isFinite(n) && n > 0 && !removeIds.has(n));
  return { value: next, changed: next.length !== arr.length };
};

const stripFromArrayField = (config, fieldName, removeIds) => {
  const { value, changed } = stripFromIntArray(config[fieldName], removeIds);
  if (!changed) return false;
  if (value.length > 0) {
    config[fieldName] = value;
  } else {
    delete config[fieldName];
  }
  return true;
};

const stripElevatorRole = (config, fieldName, removeIds) => {
  const role = config[fieldName];
  if (!role || typeof role !== "object") return false;
  if (!removeIds.has(parsePositiveInt(role.device_id))) return false;
  delete config[fieldName];
  return true;
};

const stripScalarDeviceId = (config, fieldName, removeIds) => {
  if (!Object.prototype.hasOwnProperty.call(config, fieldName)) return false;
  if (!removeIds.has(parsePositiveInt(config[fieldName]))) return false;
  delete config[fieldName];
  return true;
};

const stripDeviceIdsFromSystemConfig = (systemType, rawConfig, removeIds) => {
  const config = parseJsonConfig(rawConfig);
  const { arrays, roles, scalars } = getLocationDeviceFields(systemType);
  let changed = false;

  for (const fieldName of arrays) {
    if (stripFromArrayField(config, fieldName, removeIds)) changed = true;
  }
  for (const fieldName of roles) {
    if (stripElevatorRole(config, fieldName, removeIds)) changed = true;
  }
  for (const fieldName of scalars || []) {
    if (stripScalarDeviceId(config, fieldName, removeIds)) changed = true;
  }

  return { config, changed };
};

/**
 * 自 location_systems.system_config 移除指定設備 ID（單次掃表，可批次）。
 */
async function removeDeviceIdsFromLocationSystems(deviceIds) {
  const ids = normalizeDeviceIds(deviceIds);
  if (ids.length === 0) {
    return { updatedCount: 0, affectedRows: [] };
  }

  const removeIds = new Set(ids);
  const rows = await db.query(
    `SELECT id, location_id, system_type, system_config
     FROM location_systems`,
    [],
  );

  const affectedRows = [];
  for (const row of rows || []) {
    const { config, changed } = stripDeviceIdsFromSystemConfig(
      row.system_type,
      row.system_config,
      removeIds,
    );
    if (!changed) continue;

    await db.query(
      `UPDATE location_systems
       SET system_config = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(config), row.id],
    );
    affectedRows.push({
      locationSystemId: row.id,
      locationId: row.location_id,
      systemType: row.system_type,
    });
  }

  return {
    updatedCount: affectedRows.length,
    affectedRows,
  };
}

async function removeDeviceFromAlertIdArrayTable(tableName, columnName, deviceId) {
  const id = parsePositiveInt(deviceId);
  if (!id) {
    return { updatedCount: 0 };
  }

  const rows = await db.query(
    `SELECT id, ${columnName}
     FROM ${tableName}
     WHERE ? = ANY(${columnName})`,
    [id],
  );

  let updatedCount = 0;
  for (const row of rows || []) {
    const current = Array.isArray(row[columnName]) ? row[columnName] : [];
    const next = current
      .map((value) => Number(value))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== id);
    if (next.length === current.length) continue;

    await db.query(
      `UPDATE ${tableName}
       SET ${columnName} = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [next, row.id],
    );
    updatedCount += 1;
  }

  return { updatedCount };
}

async function removeDeviceFromAlertCameraLinkages(deviceId) {
  return removeDeviceFromAlertIdArrayTable(
    "alert_camera_linkages",
    "camera_device_ids",
    deviceId,
  );
}

async function removeDeviceFromAlertSipRingLinkages(deviceId) {
  return removeDeviceFromAlertIdArrayTable(
    "alert_sip_ring_linkages",
    "device_ids",
    deviceId,
  );
}

/**
 * 刪除設備前：清理地點／警報引用並刷新訂閱。
 */
async function removeDeviceReferences(deviceId) {
  const locationSystems = await removeDeviceIdsFromLocationSystems(deviceId);
  const alertCameraLinkages = await removeDeviceFromAlertCameraLinkages(deviceId);
  const alertSipRingLinkages =
    await removeDeviceFromAlertSipRingLinkages(deviceId);

  if (
    locationSystems.updatedCount > 0 ||
    alertCameraLinkages.updatedCount > 0 ||
    alertSipRingLinkages.updatedCount > 0
  ) {
    logger.info("已移除已刪設備之地點／警報引用", {
      deviceId,
      locationSystemsUpdated: locationSystems.updatedCount,
      alertCameraLinkagesUpdated: alertCameraLinkages.updatedCount,
      alertSipRingLinkagesUpdated: alertSipRingLinkages.updatedCount,
      affectedSystemTypes: [
        ...new Set(locationSystems.affectedRows.map((row) => row.systemType)),
      ],
    });
  }

  require("./locationShared").refreshAfterLocationOrZoneDelete(logger);
  return { locationSystems, alertCameraLinkages, alertSipRingLinkages };
}

module.exports = {
  removeDeviceIdsFromLocationSystems,
  removeDeviceFromAlertCameraLinkages,
  removeDeviceFromAlertSipRingLinkages,
  removeDeviceReferences,
};
