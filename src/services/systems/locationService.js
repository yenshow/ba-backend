const db = require("../../database/db");
const licenseService = require("../licenseService");
const logger = require("../../utils/logger");

const locationLogger = logger.createLogger("locationService");

/**
 * 統一地點管理服務（多系統架構）
 *
 * 此服務提供統一的地點和區域管理 API，支援一個地點多個系統
 * 使用 location_systems 表來關聯地點和系統
 *
 */

// ========== 共用輔助函數 ==========

/**
 * 處理唯一性約束錯誤
 */
function handleUniqueConstraintError(error, constraintName, errorMessage) {
  if (error.code === "23505" && error.constraint === constraintName) {
    const duplicateError = new Error(errorMessage);
    duplicateError.statusCode = 400;
    throw duplicateError;
  }
}

/**
 * 統一錯誤處理包裝器
 * @param {Function} fn - 異步函數
 * @param {string} errorMessage - 錯誤訊息
 * @param {Function} handleConstraint - 約束錯誤處理函數（可選）
 */
async function handleErrors(fn, errorMessage, handleConstraint) {
  try {
    return await fn();
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    if (handleConstraint) {
      handleConstraint(error);
    }
    locationLogger.error(errorMessage, {
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error(errorMessage + error.message);
  }
}

/**
 * 驗證名稱
 */
function validateName(name, fieldName = "名稱") {
  if (!name || name.trim().length === 0) {
    throw new Error(`${fieldName}不能為空`);
  }
  if (name.length > 100) {
    throw new Error(`${fieldName}長度不能超過 100 字元`);
  }
  return name.trim();
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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
          modbus:
            config.modbus_config && Object.keys(config.modbus_config).length > 0
              ? config.modbus_config
              : undefined,
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

    case "people_counting":
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
        },
      };

    case "vehicle_access":
      return {
        ...baseSystem,
        config: {
          entryLaneId: config.entry_lane_id ?? undefined,
          exitLaneId: config.exit_lane_id ?? undefined,
        },
      };

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

// ========== 區域管理函數 ==========

/**
 * 取得區域列表
 * 優化：批次查詢所有區域的地點和系統，避免為每個區域分別查詢
 */
async function getZones(filters = {}) {
  try {
    let sql = "SELECT * FROM zones WHERE 1=1";
    const params = [];

    // 支援 systemType 或 locationType 篩選（向後兼容）
    const systemType = filters.systemType || filters.locationType;
    if (systemType) {
      // 只返回有該系統類型地點的區域
      // 這樣在每個系統頁面只會看到有該系統地點的區域，總覽更清晰
      sql += `
        AND id IN (
          SELECT DISTINCT l.zone_id 
          FROM locations l
          INNER JOIN location_systems ls ON l.id = ls.location_id
          WHERE ls.system_type = $1
        )
      `;
      params.push(systemType);
    }

    sql += " ORDER BY sort_order ASC, id ASC";

    const zones = await db.query(sql, params);

    // 如果沒有區域，直接返回
    if (zones.length === 0) {
      return { zones: [] };
    }

    // 批次查詢所有區域的地點和系統
    const zoneIds = zones.map((z) => z.id);

    // 構建批次查詢 SQL
    let locationsSql = `
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
      WHERE l.zone_id = ANY($1::int[])
    `;
    const locationsParams = [zoneIds];

    if (systemType) {
      // 只返回有該系統類型的地點
      locationsSql += ` AND EXISTS (
        SELECT 1 FROM location_systems ls2 
        WHERE ls2.location_id = l.id AND ls2.system_type = $2
      )`;
      locationsParams.push(systemType);
    }

    locationsSql +=
      " ORDER BY l.zone_id, l.sort_order ASC, l.id ASC, ls.created_at ASC";

    const locationRows = await db.query(locationsSql, locationsParams);

    // 將地點按區域分組
    const locationsByZoneId = new Map();
    for (const row of locationRows) {
      const zoneId = row.zone_id;
      if (!locationsByZoneId.has(zoneId)) {
        locationsByZoneId.set(zoneId, []);
      }
      locationsByZoneId.get(zoneId).push(row);
    }

    // 格式化為前端格式
    const zonesWithLocations = zones.map((zone) => {
      const zoneRows = locationsByZoneId.get(zone.id) || [];
      const locationMap = groupLocationRowsByLocation(zoneRows);
      const locations = Array.from(locationMap.values()).map((location) =>
        formatLocation(location, location.systems),
      );
      return formatZone(zone, locations);
    });

    return { zones: zonesWithLocations };
  } catch (error) {
    locationLogger.error("取得區域列表失敗", {
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("取得區域列表失敗: " + error.message);
  }
}

/**
 * 取得單一區域
 */
async function getZoneById(id, systemTypeOrLocationType = null) {
  try {
    const zones = await db.query("SELECT * FROM zones WHERE id = $1", [id]);

    if (zones.length === 0) {
      const error = new Error("區域不存在");
      error.statusCode = 404;
      throw error;
    }

    const zone = zones[0];
    const locations = await loadZoneLocations(id, systemTypeOrLocationType);

    return {
      zone: formatZone(zone, locations),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    locationLogger.error("取得區域失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("取得區域失敗: " + error.message);
  }
}

// 向後兼容函數別名

/**
 * 建立區域
 */
async function createZone(zoneData, userId) {
  try {
    const {
      name,
      buildingId,
      description,
      imageUrl,
      locations = [],
      sortOrder: zoneSortOrderBody,
    } = zoneData;

    // 驗證必填欄位
    const trimmedName = validateName(name, "區域名稱");

    // 檢查區域名稱是否已存在
    const existingZone = await db.query(
      "SELECT id FROM zones WHERE name = $1",
      [trimmedName],
    );

    let zoneId;
    let isMerged = false;

    if (existingZone.length > 0) {
      // 區域名稱已存在，使用現有區域（自動合併）
      zoneId = existingZone[0].id;
      isMerged = true;

      // 更新區域的其他欄位
      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (buildingId !== undefined) {
        updates.push(`building_id = $${paramIndex++}`);
        params.push(buildingId || null);
      }
      if (imageUrl !== undefined) {
        updates.push(`image_url = $${paramIndex++}`);
        params.push(imageUrl || null);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description || null);
      }
      if (zoneSortOrderBody !== undefined && zoneSortOrderBody !== null) {
        const n = parseInt(zoneSortOrderBody, 10);
        if (!Number.isNaN(n) && n >= 0) {
          updates.push(`sort_order = $${paramIndex++}`);
          params.push(n);
        }
      }

      if (updates.length > 0) {
        params.push(zoneId);
        await db.query(
          `UPDATE zones SET ${updates.join(
            ", ",
          )}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
          params,
        );
      }
    } else {
      // 建立新區域
      let zoneSortVal;
      if (zoneSortOrderBody !== undefined && zoneSortOrderBody !== null) {
        const n = parseInt(zoneSortOrderBody, 10);
        if (!Number.isNaN(n) && n >= 0) zoneSortVal = n;
      }
      if (zoneSortVal === undefined) {
        const r = await db.query(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM zones`,
        );
        zoneSortVal = r[0]?.n ?? 0;
      }
      const zoneResult = await db.query(
        `INSERT INTO zones (name, building_id, image_url, description, created_by, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          trimmedName,
          buildingId || null,
          imageUrl || null,
          description || null,
          userId || null,
          zoneSortVal,
        ],
      );
      zoneId = zoneResult[0].id;
    }

    // 如果有地點需要建立，使用事務確保一起建立
    const validLocations = getValidLocations(locations);
    if (validLocations.length > 0) {
      await db.transaction(async (query) => {
        const orderedLocationIds = [];
        for (const location of validLocations) {
          const nid = await createLocationWithSystems(
            query,
            zoneId,
            location,
            userId,
          );
          orderedLocationIds.push(nid);
        }
        for (let i = 0; i < orderedLocationIds.length; i++) {
          await query(
            `UPDATE locations SET sort_order = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND zone_id = $3`,
            [i, orderedLocationIds[i], zoneId],
          );
        }
      });
    }

    // 取得建立後的完整區域資料
    const zoneResult = await getZoneById(zoneId);
    return {
      merged: isMerged,
      message: isMerged ? "地點已合併到現有區域" : "區域建立成功",
      zone: zoneResult.zone,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    handleUniqueConstraintError(error, "zones_name_key", "區域名稱已存在");
    locationLogger.error("建立區域失敗", {
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("建立區域失敗: " + error.message);
  }
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

/**
 * 更新區域
 */
async function updateZone(id, zoneData, userId) {
  try {
    const { name, buildingId, imageUrl, description, locations, sortOrder } =
      zoneData;

    // 檢查區域是否存在
    const existing = await db.query(
      "SELECT id, name FROM zones WHERE id = $1",
      [id],
    );
    if (existing.length === 0) {
      const error = new Error("區域不存在");
      error.statusCode = 404;
      throw error;
    }

    const currentZone = existing[0];
    const currentZoneName = (currentZone.name || "").trim();

    // 檢查是否需要合併區域（名稱改為已存在的名稱）
    let targetZoneId = null;
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName !== currentZoneName) {
        if (!trimmedName || trimmedName.length === 0) {
          throw new Error("區域名稱不能為空");
        }
        const nameCheck = await db.query(
          "SELECT id FROM zones WHERE name = $1 AND id != $2",
          [trimmedName, id],
        );
        if (nameCheck.length > 0) {
          targetZoneId = nameCheck[0].id;
        }
      }
    }

    // 如果需要合併區域，執行合併邏輯
    if (targetZoneId) {
      await db.transaction(async (query) => {
        // 將當前區域的地點移動到目標區域
        if (locations !== undefined && locations.length > 0) {
          const validLocations = getValidLocations(locations);

          for (const location of validLocations) {
            // 使用 createLocationWithSystems 自動處理合併（如果地點已存在則使用現有地點）
            await createLocationWithSystems(
              query,
              targetZoneId,
              location,
              userId,
            );
          }
        }

        // 刪除當前區域中沒有系統的地點
        await deleteLocationsWithoutSystems(query, id);

        // 如果當前區域沒有地點了，刪除它
        await deleteEmptyZoneIfNeeded(query, id);
      });

      // 返回目標區域的資料
      const targetZoneResult = await getZoneById(targetZoneId);
      return {
        merged: true,
        message: "區域已合併到現有區域",
        zone: targetZoneResult.zone,
      };
    }

    // 正常更新區域
    await db.transaction(async (query) => {
      // 更新樓層基本資訊
      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (name !== undefined) {
        const trimmedName = validateName(name, "區域名稱");
        // 只有當名稱真正改變時才更新
        if (trimmedName !== currentZoneName) {
          updates.push(`name = $${paramIndex++}`);
          params.push(trimmedName);
        }
      }

      if (buildingId !== undefined) {
        updates.push(`building_id = $${paramIndex++}`);
        params.push(buildingId || null);
      }

      if (imageUrl !== undefined) {
        updates.push(`image_url = $${paramIndex++}`);
        params.push(imageUrl || null);
      }

      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description || null);
      }

      if (sortOrder !== undefined && sortOrder !== null) {
        const so = parseInt(sortOrder, 10);
        if (!Number.isNaN(so) && so >= 0) {
          updates.push(`sort_order = $${paramIndex++}`);
          params.push(so);
        }
      }

      if (updates.length > 0) {
        params.push(id);
        await query(
          `UPDATE zones 
           SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP
           WHERE id = $${paramIndex}`,
          params,
        );
      }

      // 處理地點更新
      if (locations !== undefined) {
        const validLocations = getValidLocations(locations);

        const existingLocations = await query(
          "SELECT id FROM locations WHERE zone_id = $1",
          [id],
        );
        const existingLocationIds = new Set(
          existingLocations.map((l) => String(l.id)),
        );

        const updatedLocationIds = new Set();
        const orderedLocationIds = [];
        for (const location of validLocations) {
          const locationIdStr = location.id ? String(location.id) : null;

          let resolvedId;
          if (locationIdStr && existingLocationIds.has(locationIdStr)) {
            await updateLocationWithSystems(
              query,
              parseInt(locationIdStr, 10),
              location,
              userId,
            );
            resolvedId = parseInt(locationIdStr, 10);
            updatedLocationIds.add(locationIdStr);
          } else {
            resolvedId = await createLocationWithSystems(
              query,
              id,
              location,
              userId,
            );
            updatedLocationIds.add(String(resolvedId));
          }
          orderedLocationIds.push(resolvedId);
        }

        for (let i = 0; i < orderedLocationIds.length; i++) {
          await query(
            `UPDATE locations SET sort_order = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND zone_id = $3`,
            [i, orderedLocationIds[i], id],
          );
        }

        // 刪除不在更新列表中的地點（只刪除完全沒有系統的地點）
        const locationsToDelete = Array.from(existingLocationIds).filter(
          (id) => !updatedLocationIds.has(id),
        );
        await deleteLocationsByIdsWithoutSystems(
          query,
          locationsToDelete.map((id) => parseInt(id)),
        );

        // 清理更新後無系統的地點（確保資料一致性）
        await deleteLocationsWithoutSystems(query, id);
      }
    });

    const zoneResult = await getZoneById(id);
    return {
      merged: false,
      message: "區域更新成功",
      zone: zoneResult.zone,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    handleUniqueConstraintError(error, "zones_name_key", "區域名稱已存在");
    locationLogger.error("更新區域失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("更新區域失敗: " + error.message);
  }
}

/**
 * 刪除區域
 */
async function deleteZone(id) {
  try {
    const result = await db.query(
      "DELETE FROM zones WHERE id = $1 RETURNING id",
      [id],
    );

    if (result.length === 0) {
      const error = new Error("區域不存在");
      error.statusCode = 404;
      throw error;
    }

    return {
      message: "區域刪除成功",
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    if (error.code === "23503") {
      const constraintError = new Error("無法刪除區域：仍有地點關聯到此區域");
      constraintError.statusCode = 400;
      throw constraintError;
    }
    locationLogger.error("刪除區域失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("刪除區域失敗: " + error.message);
  }
}

// ========== 地點管理函數 ==========

/**
 * 取得單一地點（含所有系統）
 */
async function getLocationById(id) {
  try {
    const locations = await db.query("SELECT * FROM locations WHERE id = $1", [
      id,
    ]);

    if (locations.length === 0) {
      const error = new Error("地點不存在");
      error.statusCode = 404;
      throw error;
    }

    const location = locations[0];
    const systems = await loadLocationSystems(id);

    return {
      location: formatLocation(location, systems),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    locationLogger.error("取得地點失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("取得地點失敗: " + error.message);
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

    const result = await getLocationById(locationId);
    return {
      message: "地點建立成功",
      location: result.location,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    handleUniqueConstraintError(
      error,
      "unique_zone_location_name",
      "該區域已存在同名地點。由於地點是跨系統共用的，請直接使用該地點。",
    );
    locationLogger.error("建立地點失敗", {
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("建立地點失敗: " + error.message);
  }
}

/**
 * 更新地點（含系統）
 */
async function updateLocation(id, locationData, userId) {
  try {
    // 檢查地點是否存在
    const existing = await db.query("SELECT * FROM locations WHERE id = $1", [
      id,
    ]);
    if (existing.length === 0) {
      const error = new Error("地點不存在");
      error.statusCode = 404;
      throw error;
    }

    // 使用事務更新地點和系統
    let locationDeleted = false;
    await db.transaction(async (query) => {
      await updateLocationWithSystems(query, id, locationData, userId);

      // 檢查地點是否已被刪除（因為變成無系統）
      const locationCheck = await query(
        "SELECT id FROM locations WHERE id = $1",
        [id],
      );
      locationDeleted = locationCheck.length === 0;
    });

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
    if (error.statusCode) {
      throw error;
    }
    handleUniqueConstraintError(
      error,
      "unique_zone_location_name",
      "該區域已存在同名地點。由於地點是跨系統共用的，請直接使用該地點。",
    );
    locationLogger.error("更新地點失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("更新地點失敗: " + error.message);
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
      const error = new Error("地點不存在");
      error.statusCode = 404;
      throw error;
    }

    return {
      message: "地點刪除成功",
      id: String(id),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    locationLogger.error("刪除地點失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    throw new Error("刪除地點失敗: " + error.message);
  }
}

// ========== 系統管理函數 ==========

/**
 * 建立系統配置物件
 */
/** DB snake_case → people_counting buildSystemConfig 用的 camel 欄位（供 update 合併） */
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
        modbus_config: config.modbus || {},
      };

    case "hvac":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: config.modbus || {},
        status_points: config.statusPoints || {},
      };

    case "air_circulation":
      return {
        device_ids: deviceIdsFromApiSystemConfig(config),
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: config.modbus || {},
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
        modbus_config: config.modbus || {},
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
        modbus_config: config.modbus || {},
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
        modbus_config: config.modbus || {},
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
        modbus_config: config.modbus || {},
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
        modbus_config: config.modbus || {},
        equipment_kind: config.equipmentKind || "detector",
        view_category:
          config.viewCategory === undefined || config.viewCategory === null
            ? "smoke"
            : config.viewCategory,
        status_points: config.statusPoints || {},
      };

    case "people_counting": {
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
      };
    }

    case "vehicle_access":
      return {
        entry_lane_id: config.entryLaneId ?? null,
        exit_lane_id: config.exitLaneId ?? null,
      };

    default:
      return config || {};
  }
}

const CONTROLLER_QUOTA_SYSTEM_TYPES = new Set([
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
    const err = new Error(`不支援的 system_type：${systemType}`);
    err.statusCode = 400;
    throw err;
  }

  const licensed =
    Array.isArray(license?.features) && license.features.includes(systemType);
  if (!licensed) {
    const err = new Error(`未授權功能：${systemType}`);
    err.statusCode = 403;
    err.code = "FEATURE_NOT_LICENSED";
    err.feature = systemType;
    throw err;
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
    const err = new Error("綁定的設備不存在");
    err.statusCode = 400;
    throw err;
  }
  if (deviceRows[0].type_code !== "controller") {
    const err = new Error("此系統僅允許綁定 controller 類型設備");
    err.statusCode = 400;
    throw err;
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
    const err = new Error("已達到授權配額上限");
    err.statusCode = 403;
    err.code = "LICENSE_QUOTA_EXCEEDED";
    err.feature = systemType;
    err.used = used;
    err.max = max;
    throw err;
  }
}

/**
 * 建立系統（用於事務內部）
 */
async function createSystem(query, locationId, system) {
  const { systemType, config = {} } = system;

  if (
    !systemType ||
    ![
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
    ].includes(systemType)
  ) {
    throw new Error(`無效的系統類型: ${systemType}`);
  }

  const systemConfig = buildSystemConfig(systemType, config);

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
    throw new Error(`系統 ID ${systemId} 不存在`);
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

  if (
    ![
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
    ].includes(targetSystemType)
  ) {
    throw new Error(`無效的系統類型: ${targetSystemType}`);
  }

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

  const systemConfig = buildSystemConfig(targetSystemType, effectiveConfig);

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
        case "vehicle_access":
          if (entryLaneId !== undefined) systemConfig.entryLaneId = entryLaneId;
          if (exitLaneId !== undefined) systemConfig.exitLaneId = exitLaneId;
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
        throw new Error("系統類型不能為空");
      }

      // 檢查是否已有相同 system_type 的系統
      if (processedSystemTypes.has(systemType)) {
        throw new Error(`地點不能有多個相同類型的系統: ${systemType}`);
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
  // 區域管理 API
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
  loadZoneLocations,
  formatZone,
  formatLocation,
  // 地點管理 API
  getLocationById,
  getPeopleCountingSyncableLocationsWithAccessControlDevices,
  createLocation,
  updateLocation,
  deleteLocation,
};
