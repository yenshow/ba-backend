const locationService = require("./locationService");

const toDrainageZone = (zone) => ({ ...zone, areas: zone.locations || [] });

async function getZones() {
  try {
    const result = await locationService.getZones({ locationType: "drainage" });
    return { zones: result.zones.map(toDrainageZone) };
  } catch (error) {
    console.error("取得排水區域列表失敗:", error);
    throw new Error("取得排水區域列表失敗: " + error.message);
  }
}

async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "drainage");
    return { zone: toDrainageZone(result.zone) };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得排水區域失敗:", error);
    throw new Error("取得排水區域失敗: " + error.message);
  }
}

function areaToUnifiedLocation(area) {
  return {
    name: area.name,
    locationType: "drainage",
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
    const { name, imageUrl, areas = [] } = zoneData;
    const unifiedLocations = areas.map(areaToUnifiedLocation);

    const result = await locationService.createZone(
      { name, imageUrl, locations: unifiedLocations },
      userId,
    );
    return {
      merged: result.merged,
      message: result.message,
      zone: toDrainageZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("建立排水區域失敗:", error);
    throw new Error("建立排水區域失敗: " + error.message);
  }
}

async function updateZone(id, zoneData, userId) {
  try {
    const { name, imageUrl, areas } = zoneData;
    const unifiedLocations = areas
      ? areas.map(areaToUnifiedLocation)
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
      zone: toDrainageZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("更新排水區域失敗:", error);
    throw new Error("更新排水區域失敗: " + error.message);
  }
}

async function deleteZone(id) {
  try {
    return await locationService.deleteZone(id);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("刪除排水區域失敗:", error);
    throw new Error("刪除排水區域失敗: " + error.message);
  }
}

module.exports = {
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
};
