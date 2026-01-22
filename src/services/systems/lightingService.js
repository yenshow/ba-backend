const locationService = require("./locationService");

// ========== 區域管理函數 ==========

// 取得區域列表（使用統一表，轉換為 lighting 格式）
async function getZones() {
  try {
    const result = await locationService.getZones({ locationType: "lighting" });
    // 轉換 locations 為 areas（照明系統使用 areas 術語）
    return {
      zones: result.zones.map((zone) => ({
        ...zone,
        areas: zone.locations || [],
      })),
    };
  } catch (error) {
    console.error("取得區域列表失敗:", error);
    throw new Error("取得區域列表失敗: " + error.message);
  }
}

// 取得單一區域（使用統一表，轉換為 lighting 格式）
async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "lighting");
    // 轉換 locations 為 areas（照明系統使用 areas 術語）
    return {
      zone: {
        ...result.zone,
        areas: result.zone.locations || [],
      },
    };
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
    const { name, imageUrl, areas = [] } = zoneData;

    // 將 areas 轉換為統一格式（加入 locationType）
    const unifiedLocations = areas.map((area) => ({
      name: area.name,
      locationType: "lighting",
      deviceId: area.deviceId,
      location: area.location || { x: 50, y: 50 },
      modbus: area.modbus,
    }));

    const result = await locationService.createZone(
      {
        name,
        imageUrl,
        locations: unifiedLocations,
      },
      userId
    );

    // 轉換 locations 為 areas（照明系統使用 areas 術語）
    return {
      merged: result.merged,
      message: result.message,
      zone: {
        ...result.zone,
        areas: result.zone.locations || [],
      },
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
    const { name, imageUrl, areas } = zoneData;

    // 將 areas 轉換為統一格式（加入 locationType）
    const unifiedLocations = areas
      ? areas.map((area) => ({
          ...area,
          name: area.name,
          locationType: "lighting",
          deviceId: area.deviceId,
          location: area.location || { x: 50, y: 50 },
          modbus: area.modbus,
        }))
      : undefined;

    const result = await locationService.updateZone(
      id,
      {
        ...(name !== undefined && { name }),
        ...(imageUrl !== undefined && { imageUrl }),
        locations: unifiedLocations,
      },
      userId
    );

    // 轉換 locations 為 areas（照明系統使用 areas 術語）
    return {
      merged: result.merged,
      message: result.message,
      zone: {
        ...result.zone,
        areas: result.zone.locations || [],
      },
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

module.exports = {
  // 區域管理
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
};
