const locationService = require("./locationService");

const toLightingZone = (zone) => ({ ...zone, areas: zone.locations || [] });

// ========== 區域管理函數 ==========

async function getZones() {
  try {
    const result = await locationService.getZones({ locationType: "lighting" });
    return { zones: result.zones.map(toLightingZone) };
  } catch (error) {
    console.error("取得區域列表失敗:", error);
    throw new Error("取得區域列表失敗: " + error.message);
  }
}

async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "lighting");
    return { zone: toLightingZone(result.zone) };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得區域失敗:", error);
    throw new Error("取得區域失敗: " + error.message);
  }
}

async function createZone(zoneData, userId) {
  try {
    const { name, imageUrl, areas = [] } = zoneData;
    const unifiedLocations = areas.map((area) => ({
      name: area.name,
      locationType: "lighting",
      deviceId: area.deviceId,
      location: area.location || { x: 50, y: 50 },
      modbus: area.modbus,
    }));

    const result = await locationService.createZone(
      { name, imageUrl, locations: unifiedLocations },
      userId
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: toLightingZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("建立區域失敗:", error);
    throw new Error("建立區域失敗: " + error.message);
  }
}

async function updateZone(id, zoneData, userId) {
  try {
    const { name, imageUrl, areas } = zoneData;
    const unifiedLocations = areas
      ? areas.map((area) => ({
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
    return {
      merged: result.merged,
      message: result.message,
      zone: toLightingZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("更新區域失敗:", error);
    throw new Error("更新區域失敗: " + error.message);
  }
}

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
