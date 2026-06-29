const db = require("../../database/db");
const logger = require("../../utils/logger");
const C = require("../../utils/apiErrorCodes");
const { rethrowIfApiError, throwApiError, causeDetails } = require("../../utils/apiErrorMeta");
const {
  failLocationZoneList,
  failLocationZoneGet,
  failLocationZoneCreate,
  failLocationZoneUpdate,
  failLocationZoneDelete,
} = require("../../utils/locationErrors");
const shared = require("./locationShared");
const systemOps = require("./locationSystemOps");

const {
  validateName,
  formatZone,
  formatLocation,
  groupLocationRowsByLocation,
  loadZoneLocations,
  handleUniqueConstraintError,
  getValidLocations,
  deleteLocationsWithoutSystems,
  deleteLocationsByIdsWithoutSystems,
  deleteEmptyZoneIfNeeded,
} = shared;

const { createLocationWithSystems, updateLocationWithSystems } = systemOps;
const {
  syncElevatorFloorsFromLocations,
} = require("../ladderSdk/sdkDoorService");
const {
  invalidateLocationCache: invalidateElevatorLocationCache,
} = require("../monitoring/elevatorLocationCache");

const syncElevatorFloorsIfPresent = async (locations) => {
  if (locations === undefined) return;
  const validLocations = getValidLocations(locations);
  if (validLocations.length > 0) {
    await syncElevatorFloorsFromLocations(validLocations);
    invalidateElevatorLocationCache();
  }
};

const locationLogger = logger.createLogger("locationZoneOps");

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
    rethrowIfApiError(error);
    locationLogger.error("取得區域列表失敗", {
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationZoneList("取得區域列表失敗", causeDetails(error));
  }
}

/**
 * 取得單一區域
 */
async function getZoneById(id, systemTypeOrLocationType = null) {
  try {
    const zones = await db.query("SELECT * FROM zones WHERE id = $1", [id]);

    if (zones.length === 0) {
      throwApiError(C.LOCATION_ZONE_NOT_FOUND, "區域不存在");
    }

    const zone = zones[0];
    const locations = await loadZoneLocations(id, systemTypeOrLocationType);

    return {
      zone: formatZone(zone, locations),
    };
  } catch (error) {
    rethrowIfApiError(error);
    locationLogger.error("取得區域失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationZoneGet("取得區域失敗", causeDetails(error));
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
      await syncElevatorFloorsIfPresent(locations);
    }

    // 取得建立後的完整區域資料
    const zoneResult = await getZoneById(zoneId);
    return {
      merged: isMerged,
      message: isMerged ? "地點已合併到現有區域" : "區域建立成功",
      zone: zoneResult.zone,
    };
  } catch (error) {
    rethrowIfApiError(error);
    handleUniqueConstraintError(
      error,
      "zones_name_key",
      C.LOCATION_ZONE_NAME_DUPLICATE,
      "區域名稱已存在",
    );
    locationLogger.error("建立區域失敗", {
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationZoneCreate("建立區域失敗", causeDetails(error));
  }
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
      throwApiError(C.LOCATION_ZONE_NOT_FOUND, "區域不存在");
    }

    const currentZone = existing[0];
    const currentZoneName = (currentZone.name || "").trim();

    // 檢查是否需要合併區域（名稱改為已存在的名稱）
    let targetZoneId = null;
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName !== currentZoneName) {
        if (!trimmedName || trimmedName.length === 0) {
          throwApiError(C.LOCATION_ZONE_NAME_REQUIRED, "區域名稱不能為空");
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

      await syncElevatorFloorsIfPresent(locations);

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

    await syncElevatorFloorsIfPresent(locations);

    const zoneResult = await getZoneById(id);
    return {
      merged: false,
      message: "區域更新成功",
      zone: zoneResult.zone,
    };
  } catch (error) {
    rethrowIfApiError(error);
    handleUniqueConstraintError(
      error,
      "zones_name_key",
      C.LOCATION_ZONE_NAME_DUPLICATE,
      "區域名稱已存在",
    );
    locationLogger.error("更新區域失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationZoneUpdate("更新區域失敗", causeDetails(error));
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
      throwApiError(C.LOCATION_ZONE_NOT_FOUND, "區域不存在");
    }

    return {
      message: "區域刪除成功",
    };
  } catch (error) {
    rethrowIfApiError(error);
    if (error.code === "23503") {
      throwApiError(
        C.LOCATION_ZONE_DELETE_FORBIDDEN,
        "無法刪除區域：仍有地點關聯到此區域",
      );
    }
    locationLogger.error("刪除區域失敗", {
      id,
      error: error?.message || String(error),
      module: "locationService",
    });
    failLocationZoneDelete("刪除區域失敗", causeDetails(error));
  }
}

module.exports = {
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
  loadZoneLocations: shared.loadZoneLocations,
  formatZone: shared.formatZone,
  formatLocation: shared.formatLocation,
};
