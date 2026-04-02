const locationService = require("./locationService");

const toEmergencyRescueZone = (zone) => ({ ...zone });

async function getZones() {
  try {
    const result = await locationService.getZones({
      locationType: "emergency_rescue",
    });
    return { zones: result.zones.map(toEmergencyRescueZone) };
  } catch (error) {
    console.error("取得緊急求救區域列表失敗:", error);
    throw new Error("取得緊急求救區域列表失敗: " + error.message);
  }
}

async function getZoneById(id) {
  try {
    const result = await locationService.getZoneById(id, "emergency_rescue");
    return { zone: toEmergencyRescueZone(result.zone) };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得緊急求救區域失敗:", error);
    throw new Error("取得緊急求救區域失敗: " + error.message);
  }
}

function areaToUnifiedLocation(area) {
  return {
    name: area.name,
    locationType: "emergency_rescue",
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
      zone: toEmergencyRescueZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("建立緊急求救區域失敗:", error);
    throw new Error("建立緊急求救區域失敗: " + error.message);
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
      zone: toEmergencyRescueZone(result.zone),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("更新緊急求救區域失敗:", error);
    throw new Error("更新緊急求救區域失敗: " + error.message);
  }
}

async function deleteZone(id) {
  try {
    return await locationService.deleteZone(id);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("刪除緊急求救區域失敗:", error);
    throw new Error("刪除緊急求救區域失敗: " + error.message);
  }
}

module.exports = {
  getZones,
  getZoneById,
  createZone,
  updateZone,
  deleteZone,
};
