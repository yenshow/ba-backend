const db = require("../../database/db");
const locationService = require("./locationService");

// ========== 區域管理函數 ==========

// 取得區域列表（使用統一表）
async function getZones() {
  try {
    const result = await locationService.getZones({
      locationType: "environment",
    });
    return { zones: result.zones };
  } catch (error) {
    console.error("取得區域列表失敗:", error);
    throw new Error("取得區域列表失敗: " + error.message);
  }
}

// 取得單一區域（使用統一表）
async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "environment");
    return { zone: result.zone };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得區域失敗:", error);
    throw new Error("取得區域失敗: " + error.message);
  }
}

// 建立區域（使用統一表）
async function createZone(zoneData, userId) {
  try {
    const { name, locations = [] } = zoneData;

    // 將 locations 轉換為統一格式（加入 locationType）
    const unifiedLocations = locations.map((loc) => ({
      ...loc,
      locationType: "environment",
    }));

    const result = await locationService.createZone(
      {
        ...zoneData,
        locations: unifiedLocations,
      },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: result.zone,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("建立區域失敗:", error);
    throw new Error("建立區域失敗: " + error.message);
  }
}

// 更新區域（使用統一表）
async function updateZone(id, zoneData, userId) {
  try {
    const { name, locations } = zoneData;

    // 將 locations 轉換為統一格式（加入 locationType）
    const unifiedLocations = locations
      ? locations.map((loc) => ({
          ...loc,
          locationType: "environment",
        }))
      : undefined;

    const result = await locationService.updateZone(
      id,
      {
        ...(name !== undefined && { name }),
        locations: unifiedLocations,
      },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: result.zone,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("更新區域失敗:", error);
    throw new Error("更新區域失敗: " + error.message);
  }
}

// 刪除區域（使用統一表）
async function deleteZone(id) {
  try {
    return await locationService.deleteZone(id);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("刪除區域失敗:", error);
    throw new Error("刪除區域失敗: " + error.message);
  }
}

// ========== 感測器讀數管理函數 ==========

async function getReadings(locationId, options = {}) {
  try {
    const { startTime, endTime, limit = 1000 } = options;

    let query = `
      SELECT recorded_at as timestamp, data
      FROM environment_readings
      WHERE location_id = $1
    `;
    const params = [parseInt(locationId, 10)];
    let paramIndex = 2;

    if (startTime) {
      query += ` AND recorded_at >= $${paramIndex++}`;
      params.push(new Date(startTime));
    }

    if (endTime) {
      query += ` AND recorded_at <= $${paramIndex++}`;
      params.push(new Date(endTime));
    }

    query += ` ORDER BY recorded_at ASC LIMIT $${paramIndex}`;
    params.push(limit);

    const rows = await db.query(query, params);

    return {
      readings: rows.map((r) => {
        const data = typeof r.data === "object" ? r.data : (r.data ? JSON.parse(r.data) : {});
        const ts = r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
        return {
          id: `env_${locationId}_${ts.getTime()}`,
          locationId: String(locationId),
          timestamp: ts.toISOString(),
          data,
          createdAt: ts.toISOString(),
        };
      }),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得讀數失敗:", error);
    throw new Error("取得讀數失敗: " + error.message);
  }
}

module.exports = {
  // 區域管理
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
  getReadings,
};
