const locationService = require("./locationService");

// 注意：formatArea, formatFloor, loadFloorAreas, validateAndCreateArea, validateAndUpdateArea 
// 等函數已移除，統一使用 locationService 處理

// ========== 樓層管理函數 ==========

// 取得樓層列表（使用統一表，轉換為 lighting 格式）
async function getFloors() {
  try {
    const result = await locationService.getFloors({ locationType: "lighting" });
    // 轉換 locations 為 areas，保持向後兼容
    return {
      floors: result.floors.map((floor) => ({
        ...floor,
        areas: floor.locations || [],
      })),
    };
  } catch (error) {
    console.error("取得樓層列表失敗:", error);
    throw new Error("取得樓層列表失敗: " + error.message);
  }
}

// 取得單一樓層（使用統一表，轉換為 lighting 格式）
async function getFloorById(id) {
  try {
    const result = await locationService.getFloorById(id, "lighting");
    // 轉換 locations 為 areas，保持向後兼容
    return {
      floor: {
        ...result.floor,
        areas: result.floor.locations || [],
      },
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得樓層失敗:", error);
    throw new Error("取得樓層失敗: " + error.message);
  }
}

// 建立樓層（使用統一表）
async function createFloor(floorData, userId) {
  try {
    const { name, imageUrl, areas = [] } = floorData;

    // 將 areas 轉換為統一格式（加入 locationType）
    const unifiedLocations = areas.map((area) => ({
      name: area.name,
      locationType: "lighting",
      deviceId: area.deviceId,
      location: area.location || { x: 50, y: 50 },
      modbus: area.modbus,
    }));

    const result = await locationService.createFloor(
      {
        name,
        imageUrl,
        locations: unifiedLocations,
      },
      userId
    );

    // 轉換 locations 為 areas，保持向後兼容
    return {
      ...result,
      floor: {
        ...result.floor,
        areas: result.floor.locations || [],
      },
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("建立樓層失敗:", error);
    throw new Error("建立樓層失敗: " + error.message);
  }
}

// 更新樓層（使用統一表）
async function updateFloor(id, floorData, userId) {
  try {
    const { name, imageUrl, areas } = floorData;

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

    const result = await locationService.updateFloor(
      id,
      {
        ...(name !== undefined && { name }),
        ...(imageUrl !== undefined && { imageUrl }),
        locations: unifiedLocations,
      },
      userId
    );

    // 轉換 locations 為 areas，保持向後兼容
    return {
      ...result,
      floor: {
        ...result.floor,
        areas: result.floor.locations || [],
      },
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("更新樓層失敗:", error);
    throw new Error("更新樓層失敗: " + error.message);
  }
}

// 刪除樓層（使用統一表）
async function deleteFloor(id) {
  try {
    return await locationService.deleteFloor(id);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("刪除樓層失敗:", error);
    throw new Error("刪除樓層失敗: " + error.message);
  }
}

module.exports = {
  // 樓層管理
  getFloors,
  getFloorById,
  createFloor,
  updateFloor,
  deleteFloor,
};
