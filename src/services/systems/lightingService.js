const locationService = require("./locationService");
const logger = require("../../utils/logger");

const lightingLogger = logger.createLogger("lightingService");

/** 回傳與統一 zone 一致，僅使用 locations（不再附加 areas） */
const toLightingZone = (zone) => ({ ...zone });

// ========== 區域管理函數 ==========

async function getZones() {
  try {
    const result = await locationService.getZones({ locationType: "lighting" });
    return { zones: result.zones.map(toLightingZone) };
  } catch (error) {
    lightingLogger.error("取得區域列表失敗", {
      error: error?.message || String(error),
      module: "lightingService",
    });
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
    lightingLogger.error("取得區域失敗", {
      id,
      error: error?.message || String(error),
      module: "lightingService",
    });
    throw new Error("取得區域失敗: " + error.message);
  }
}

async function createZone(zoneData, userId) {
  try {
    const { name, imageUrl, locations = [] } = zoneData;
    const list = Array.isArray(locations) ? locations : [];
    const unifiedLocations = list.map((loc) => ({
      name: loc.name,
      locationType: "lighting",
      deviceId: loc.deviceId,
      location: loc.location || { x: 50, y: 50 },
      modbus: loc.modbus,
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
    lightingLogger.error("建立區域失敗", {
      error: error?.message || String(error),
      module: "lightingService",
    });
    throw new Error("建立區域失敗: " + error.message);
  }
}

async function updateZone(id, zoneData, userId) {
  try {
    const { name, imageUrl, locations } = zoneData;
    const unifiedLocations = Array.isArray(locations)
      ? locations.map((loc) => ({
          name: loc.name,
          locationType: "lighting",
          deviceId: loc.deviceId,
          location: loc.location || { x: 50, y: 50 },
          modbus: loc.modbus,
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
    lightingLogger.error("更新區域失敗", {
      id,
      error: error?.message || String(error),
      module: "lightingService",
    });
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
    lightingLogger.error("刪除區域失敗", {
      id,
      error: error?.message || String(error),
      module: "lightingService",
    });
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
