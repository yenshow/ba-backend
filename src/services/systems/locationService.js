const db = require("../../database/db");

/**
 * 統一地點管理服務（多系統架構）
 *
 * 此服務提供統一的地點和區域管理 API，支援一個地點多個系統
 * 使用 location_systems 表來關聯地點和系統
 * 
 * 注意：資料庫中仍使用 floors 表，但 API 層面統一使用 zones 命名
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
    console.error(errorMessage, error);
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
    case "environment":
      return {
        ...baseSystem,
        config: {
          deviceId: config.device_id || undefined,
          parameters: config.parameters || [],
        },
      };

    case "lighting":
      return {
        ...baseSystem,
        config: {
          deviceId: config.device_id || undefined,
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

    case "people_counting":
      return {
        ...baseSystem,
        config: {
          personGroupIds: config.person_group_ids || [],
          entryDoorId: config.entry_door_id || undefined,
          exitDoorId: config.exit_door_id || undefined,
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
  return {
    id: String(location.id),
    zoneId: String(location.zone_id),
    name: location.name,
    description: location.description || undefined,
    systems: systems.map(formatSystem),
  };
}

/**
 * 格式化區域資料為前端格式
 */
function formatZone(zone, locations = []) {
  return {
    id: String(zone.id),
    name: zone.name,
    buildingId: zone.building_id || undefined,
    floorNumber: zone.floor_number || undefined,
    imageUrl: zone.image_url || undefined,
    description: zone.description || undefined,
    locations: locations,
  };
}

/**
 * 載入地點的所有系統
 */
async function loadLocationSystems(locationId) {
  const systems = await db.query(
    `SELECT * FROM location_systems WHERE location_id = $1 ORDER BY created_at ASC`,
    [locationId]
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

  sql += " ORDER BY l.created_at ASC, ls.created_at ASC";

  const rows = await db.query(sql, params);
  const locationMap = groupLocationRowsByLocation(rows);

  // 格式化為前端格式
  const locationsWithSystems = Array.from(locationMap.values()).map(
    (location) => formatLocation(location, location.systems)
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

    sql += " ORDER BY created_at DESC";

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

    locationsSql += " ORDER BY l.zone_id, l.created_at ASC, ls.created_at ASC";

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
        formatLocation(location, location.systems)
      );
      return formatZone(zone, locations);
    });

    return { zones: zonesWithLocations };
  } catch (error) {
    console.error("取得區域列表失敗:", error);
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
    console.error("取得區域失敗:", error);
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
      floorNumber,
      description,
      imageUrl,
      locations = [],
    } = zoneData;

    // 驗證必填欄位
    const trimmedName = validateName(name, "區域名稱");

    // 檢查區域名稱是否已存在
    const existingZone = await db.query(
      "SELECT id FROM zones WHERE name = $1",
      [trimmedName]
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
      if (floorNumber !== undefined) {
        updates.push(`floor_number = $${paramIndex++}`);
        params.push(floorNumber || null);
      }
      if (imageUrl !== undefined) {
        updates.push(`image_url = $${paramIndex++}`);
        params.push(imageUrl || null);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description || null);
      }

      if (updates.length > 0) {
        params.push(zoneId);
        await db.query(
          `UPDATE zones SET ${updates.join(
            ", "
          )}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
          params
        );
      }
    } else {
      // 建立新區域
      const zoneResult = await db.query(
        `INSERT INTO zones (name, building_id, floor_number, image_url, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          trimmedName,
          buildingId || null,
          floorNumber || null,
          imageUrl || null,
          description || null,
          userId || null,
        ]
      );
      zoneId = zoneResult[0].id;
    }

    // 如果有地點需要建立，使用事務確保一起建立
    const validLocations = getValidLocations(locations);
    if (validLocations.length > 0) {
      await db.transaction(async (query) => {
        for (const location of validLocations) {
          await createLocationWithSystems(query, zoneId, location, userId);
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
    console.error("建立區域失敗:", error);
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
 * 更新區域
 */
async function updateZone(id, zoneData, userId) {
  try {
    const { name, buildingId, floorNumber, imageUrl, description, locations } =
      zoneData;

    // 檢查區域是否存在
    const existing = await db.query(
      "SELECT id, name FROM zones WHERE id = $1",
      [id]
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
          [trimmedName, id]
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
              userId
            );
          }
        }

        // 刪除當前區域中沒有系統的地點
        await query(
          `DELETE FROM locations 
           WHERE zone_id = $1 
           AND NOT EXISTS (SELECT 1 FROM location_systems WHERE location_id = locations.id)`,
          [id]
        );

        // 如果當前區域沒有地點了，刪除它
        const remainingLocations = await query(
          "SELECT id FROM locations WHERE zone_id = $1",
          [id]
        );
        if (remainingLocations.length === 0) {
          await query("DELETE FROM zones WHERE id = $1", [id]);
        }
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

      if (floorNumber !== undefined) {
        updates.push(`floor_number = $${paramIndex++}`);
        params.push(floorNumber || null);
      }

      if (imageUrl !== undefined) {
        updates.push(`image_url = $${paramIndex++}`);
        params.push(imageUrl || null);
      }

      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description || null);
      }

      if (updates.length > 0) {
        params.push(id);
        await query(
          `UPDATE zones 
           SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP
           WHERE id = $${paramIndex}`,
          params
        );
      }

      // 處理地點更新
      if (locations !== undefined) {
        const validLocations = getValidLocations(locations);

        const existingLocations = await query(
          "SELECT id FROM locations WHERE zone_id = $1",
          [id]
        );
        const existingLocationIds = new Set(
          existingLocations.map((l) => String(l.id))
        );

        const updatedLocationIds = new Set();
        for (const location of validLocations) {
          const locationId = location.id ? String(location.id) : null;

          if (locationId && existingLocationIds.has(locationId)) {
            // 地點已存在，更新它
            await updateLocationWithSystems(
              query,
              parseInt(locationId),
              location,
              userId
            );
            updatedLocationIds.add(locationId);
          } else {
            // 地點不存在或沒有 id，使用 createLocationWithSystems
            // 它會自動處理：如果地點名稱已存在，則使用現有地點並添加系統
            const newLocationId = await createLocationWithSystems(
              query,
              id,
              location,
              userId
            );
            updatedLocationIds.add(String(newLocationId));
          }
        }

        // 刪除不在更新列表中的地點（只刪除完全沒有系統的地點）
        const locationsToDelete = Array.from(existingLocationIds).filter(
          (id) => !updatedLocationIds.has(id)
        );
        if (locationsToDelete.length > 0) {
          // 只刪除沒有系統的地點（避免誤刪其他系統使用的地點）
          await query(
            `DELETE FROM locations 
             WHERE id = ANY($1::int[]) 
             AND NOT EXISTS (SELECT 1 FROM location_systems WHERE location_id = locations.id)`,
            [locationsToDelete.map((id) => parseInt(id))]
          );
        }
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
    console.error("更新區域失敗:", error);
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
      [id]
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
    console.error("刪除區域失敗:", error);
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
    console.error("取得地點失敗:", error);
    throw new Error("取得地點失敗: " + error.message);
  }
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
        userId
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
      "該區域已存在同名地點。由於地點是跨系統共用的，請直接使用該地點。"
    );
    console.error("建立地點失敗:", error);
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
    await db.transaction(async (query) => {
      await updateLocationWithSystems(query, id, locationData, userId);
    });

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
      "unique_floor_location_name",
      "該樓層已存在同名地點。由於地點是跨系統共用的，請直接使用該地點。"
    );
    console.error("更新地點失敗:", error);
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
      [id]
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
    console.error("刪除地點失敗:", error);
    throw new Error("刪除地點失敗: " + error.message);
  }
}

// ========== 系統管理函數 ==========

/**
 * 建立系統配置物件
 */
function buildSystemConfig(systemType, config) {
  switch (systemType) {
    case "environment":
      return {
        device_id: config.deviceId || null,
        parameters: config.parameters || [],
      };

    case "lighting":
      return {
        device_id: config.deviceId || null,
        location_x: config.location?.x || 50.0,
        location_y: config.location?.y || 50.0,
        modbus_config: config.modbus || {},
      };

    case "people_counting":
      return {
        person_group_ids: config.personGroupIds || [],
        entry_door_id: config.entryDoorId || null,
        exit_door_id: config.exitDoorId || null,
      };

    default:
      return config || {};
  }
}

/**
 * 建立系統（用於事務內部）
 */
async function createSystem(query, locationId, system) {
  const { systemType, config = {} } = system;

  if (
    !systemType ||
    !["environment", "lighting", "people_counting"].includes(systemType)
  ) {
    throw new Error(`無效的系統類型: ${systemType}`);
  }

  const systemConfig = buildSystemConfig(systemType, config);

  const result = await query(
    `INSERT INTO location_systems (location_id, system_type, system_config)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [locationId, systemType, JSON.stringify(systemConfig)]
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
    "SELECT system_type FROM location_systems WHERE id = $1",
    [systemId]
  );
  if (existing.length === 0) {
    throw new Error(`系統 ID ${systemId} 不存在`);
  }

  const currentSystemType = existing[0].system_type;
  const targetSystemType = systemType || currentSystemType;

  if (
    !["environment", "lighting", "people_counting"].includes(targetSystemType)
  ) {
    throw new Error(`無效的系統類型: ${targetSystemType}`);
  }

  const systemConfig = buildSystemConfig(targetSystemType, config);

  await query(
    `UPDATE location_systems
     SET system_type = $1, system_config = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [targetSystemType, JSON.stringify(systemConfig), systemId]
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
      parameters,
      location: locationXY,
      modbus,
      personGroupIds,
      entryDoorId,
      exitDoorId,
      config,
    } = location;

    // 如果有現成的 config，直接使用
    if (config) {
      finalSystems = [{ systemType: locationType, config }];
    } else {
      // 否則從 location 物件中提取配置
      const systemConfig = {};
      switch (locationType) {
        case "environment":
          if (deviceId !== undefined) systemConfig.deviceId = deviceId;
          if (parameters !== undefined) systemConfig.parameters = parameters;
          break;
        case "lighting":
          if (deviceId !== undefined) systemConfig.deviceId = deviceId;
          if (locationXY !== undefined) systemConfig.location = locationXY;
          if (modbus !== undefined) systemConfig.modbus = modbus;
          break;
        case "people_counting":
          if (personGroupIds !== undefined)
            systemConfig.personGroupIds = personGroupIds;
          if (entryDoorId !== undefined) systemConfig.entryDoorId = entryDoorId;
          if (exitDoorId !== undefined) systemConfig.exitDoorId = exitDoorId;
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
    [zoneId, trimmedName]
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
        [description || null, locationId]
      );
    }
  } else {
    // 建立新地點
    const locationResult = await query(
      `INSERT INTO locations (zone_id, name, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [zoneId, trimmedName, description || null, userId || null]
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
      [locationId, systemType]
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
      [locationId]
    );
    const currentLocationName = (currentLocation[0]?.name || "").trim();

      // 只有當名稱真正改變時才檢查重複並更新
      if (trimmedName !== currentLocationName) {
        // 檢查是否有其他地點使用相同名稱（同一區域內）
        const nameCheck = await query(
          "SELECT id FROM locations WHERE zone_id = (SELECT zone_id FROM locations WHERE id = $1) AND name = $2 AND id != $1",
          [locationId, trimmedName]
        );
        if (nameCheck.length > 0) {
          const duplicateError = new Error(
            `地點名稱 "${trimmedName}" 已被該區域的其他地點使用。由於地點是跨系統共用的，請直接使用該地點。`
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
        ", "
      )}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
      params
    );
  }

  // 處理系統更新
  if (systems !== undefined) {
    // 查詢現有系統，建立兩個索引：
    // 1. 以 id 為鍵（用於更新現有系統）
    // 2. 以 (location_id, system_type) 為鍵（用於檢查唯一約束）
    const existingSystems = await query(
      "SELECT id, system_type FROM location_systems WHERE location_id = $1",
      [locationId]
    );
    const existingSystemIds = new Set(existingSystems.map((s) => String(s.id)));
    const existingSystemTypes = new Map(
      existingSystems.map((s) => [s.system_type, s.id])
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
      (id) => !updatedSystemIds.has(id)
    );
    if (systemsToDelete.length > 0) {
      await query(`DELETE FROM location_systems WHERE id = ANY($1::int[])`, [
        systemsToDelete.map((id) => parseInt(id)),
      ]);
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
  createLocation,
  updateLocation,
  deleteLocation,
};
