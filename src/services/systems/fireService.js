const locationService = require("./locationService");

const toFireZone = (zone) => ({ ...zone });

async function getZones() {
  try {
    const result = await locationService.getZones({ locationType: "fire" });
    return { zones: result.zones.map(toFireZone) };
  } catch (error) {
    console.error("取得消防區域列表失敗:", error);
    throw new Error("取得消防區域列表失敗: " + error.message);
  }
}

async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "fire");
    return { zone: toFireZone(result.zone) };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得消防區域失敗:", error);
    throw new Error("取得消防區域失敗: " + error.message);
  }
}

function areaToUnifiedLocation(area) {
  return {
    name: area.name,
    locationType: "fire",
    deviceId: area.deviceId,
    location: area.location || { x: 50, y: 50 },
    modbus: area.modbus,
    equipmentKind: area.equipmentKind,
    viewCategory: area.viewCategory,
    statusPoints: area.statusPoints,
  };
}

async function createZone(zoneData, userId) {
  try {
    const { name, imageUrl, locations = [] } = zoneData;
    const unifiedLocations = (Array.isArray(locations) ? locations : []).map(
      areaToUnifiedLocation,
    );

    const result = await locationService.createZone(
      { name, imageUrl, locations: unifiedLocations },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: toFireZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("建立消防區域失敗:", error);
    throw new Error("建立消防區域失敗: " + error.message);
  }
}

async function updateZone(id, zoneData, userId) {
  try {
    const { name, imageUrl, locations } = zoneData;
    const unifiedLocations = Array.isArray(locations)
      ? locations.map(areaToUnifiedLocation)
      : undefined;

    const result = await locationService.updateZone(
      id,
      {
        ...(name !== undefined && { name }),
        ...(imageUrl !== undefined && { imageUrl }),
        locations: unifiedLocations,
      },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: toFireZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("更新消防區域失敗:", error);
    throw new Error("更新消防區域失敗: " + error.message);
  }
}

async function deleteZone(id) {
  try {
    return await locationService.deleteZone(id);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("刪除消防區域失敗:", error);
    throw new Error("刪除消防區域失敗: " + error.message);
  }
}

module.exports = {
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
};
