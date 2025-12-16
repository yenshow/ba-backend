const db = require("../database/db");

// ========== 共用輔助函數 ==========

// 格式化區域資料為前端格式
function formatArea(area) {
  return {
    id: String(area.id),
    name: area.name,
    location: {
      x: parseFloat(area.location_x),
      y: parseFloat(area.location_y),
    },
    deviceId: area.device_id || undefined,
    modbus:
      area.modbus_config && Object.keys(area.modbus_config).length > 0
        ? typeof area.modbus_config === "string"
          ? JSON.parse(area.modbus_config)
          : area.modbus_config
        : undefined,
  };
}

// 格式化樓層資料為前端格式
function formatFloor(floor, areas = []) {
  return {
    id: String(floor.id),
    name: floor.name,
    imageUrl: floor.image_url || undefined,
    areas: areas.map(formatArea),
  };
}

// 載入樓層的區域
async function loadFloorAreas(floorId) {
  const areas = await db.query(
    `SELECT la.*
     FROM lighting_areas la
     WHERE la.floor_id = $1
     ORDER BY la.created_at ASC`,
    [floorId]
  );
  return areas;
}

// 驗證並建立區域（用於事務內部）
async function validateAndCreateArea(query, floorId, area, userId) {
  const {
    name: areaName,
    location = { x: 50, y: 50 },
    deviceId,
    modbus,
  } = area;

  if (!areaName || areaName.trim().length === 0) {
    throw new Error("區域名稱不能為空");
  }

  // 驗證設備是否存在
  if (deviceId) {
    const devices = await query("SELECT id FROM devices WHERE id = $1", [
      deviceId,
    ]);
    if (devices.length === 0) {
      throw new Error(`設備 ID ${deviceId} 不存在`);
    }
  }

  // 驗證 modbus 配置
  if (modbus && typeof modbus !== "object") {
    throw new Error("Modbus 配置必須為物件");
  }

  const result = await query(
    `INSERT INTO lighting_areas 
     (floor_id, name, location_x, location_y, device_id, modbus_config, created_by) 
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      floorId,
      areaName.trim(),
      parseFloat(location.x || 50),
      parseFloat(location.y || 50),
      deviceId || null,
      JSON.stringify(modbus || {}),
      userId || null,
    ]
  );

  return result[0].id;
}

// 驗證並更新區域（用於事務內部）
async function validateAndUpdateArea(query, areaId, area, userId) {
  const {
    name: areaName,
    location = { x: 50, y: 50 },
    deviceId,
    modbus,
  } = area;

  if (!areaName || areaName.trim().length === 0) {
    throw new Error("區域名稱不能為空");
  }

  // 驗證設備是否存在
  if (deviceId) {
    const devices = await query("SELECT id FROM devices WHERE id = $1", [
      deviceId,
    ]);
    if (devices.length === 0) {
      throw new Error(`設備 ID ${deviceId} 不存在`);
    }
  }

  // 驗證 modbus 配置
  if (modbus && typeof modbus !== "object") {
    throw new Error("Modbus 配置必須為物件");
  }

  // 檢查區域是否存在
  const existing = await query("SELECT id FROM lighting_areas WHERE id = $1", [
    areaId,
  ]);
  if (existing.length === 0) {
    throw new Error(`區域 ID ${areaId} 不存在`);
  }

  await query(
    `UPDATE lighting_areas 
     SET name = $1, location_x = $2, location_y = $3, 
         device_id = $4, modbus_config = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $6`,
    [
      areaName.trim(),
      parseFloat(location.x || 50),
      parseFloat(location.y || 50),
      deviceId || null,
      JSON.stringify(modbus || {}),
      areaId,
    ]
  );
}

// ========== 樓層管理函數 ==========

// 取得樓層列表
async function getFloors() {
  try {
    const floors = await db.query(
      `SELECT * FROM lighting_floors ORDER BY created_at DESC`
    );

    // 為每個樓層載入區域
    const floorsWithAreas = await Promise.all(
      floors.map(async (floor) => {
        const areas = await loadFloorAreas(floor.id);
        return formatFloor(floor, areas);
      })
    );

    return { floors: floorsWithAreas };
  } catch (error) {
    console.error("取得樓層列表失敗:", error);
    throw new Error("取得樓層列表失敗: " + error.message);
  }
}

// 取得單一樓層
async function getFloorById(id) {
  try {
    const floors = await db.query(
      `SELECT * FROM lighting_floors WHERE id = $1`,
      [id]
    );

    if (floors.length === 0) {
      const error = new Error("樓層不存在");
      error.statusCode = 404;
      throw error;
    }

    const floor = floors[0];
    const areas = await loadFloorAreas(floor.id);

    return {
      floor: formatFloor(floor, areas),
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    console.error("取得樓層失敗:", error);
    throw new Error("取得樓層失敗: " + error.message);
  }
}

// 建立樓層
async function createFloor(floorData, userId) {
  try {
    const { name, imageUrl, areas = [] } = floorData;

    // 驗證必填欄位
    if (!name || name.trim().length === 0) {
      throw new Error("樓層名稱不能為空");
    }

    if (name.length > 100) {
      throw new Error("樓層名稱長度不能超過 100 字元");
    }

    // 使用事務確保樓層和區域一起建立
    const result = await db.transaction(async (query) => {
      // 建立樓層
      const floorResult = await query(
        `INSERT INTO lighting_floors (name, image_url, created_by) 
         VALUES ($1, $2, $3) 
         RETURNING id`,
        [name.trim(), imageUrl || null, userId || null]
      );

      const floorId = floorResult[0].id;

      // 建立區域
      for (const area of areas) {
        await validateAndCreateArea(query, floorId, area, userId);
      }

      return floorId;
    });

    // 取得建立後的完整樓層資料
    const floorResult = await getFloorById(result);
    return {
      message: "樓層建立成功",
      floor: floorResult.floor,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    // 處理唯一性約束錯誤
    if (
      error.code === "23505" &&
      error.constraint === "lighting_floors_name_key"
    ) {
      const duplicateError = new Error("樓層名稱已存在");
      duplicateError.statusCode = 400;
      throw duplicateError;
    }
    console.error("建立樓層失敗:", error);
    throw new Error("建立樓層失敗: " + error.message);
  }
}

// 更新樓層
async function updateFloor(id, floorData, userId) {
  try {
    const { name, imageUrl, areas } = floorData;

    // 檢查樓層是否存在
    const existing = await db.query(
      "SELECT * FROM lighting_floors WHERE id = $1",
      [id]
    );
    if (existing.length === 0) {
      const error = new Error("樓層不存在");
      error.statusCode = 404;
      throw error;
    }

    // 使用事務更新樓層和區域
    await db.transaction(async (query) => {
      // 更新樓層基本資訊
      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (name !== undefined) {
        if (name.trim().length === 0) {
          throw new Error("樓層名稱不能為空");
        }
        if (name.length > 100) {
          throw new Error("樓層名稱長度不能超過 100 字元");
        }
        updates.push(`name = $${paramIndex++}`);
        params.push(name.trim());
      }

      if (imageUrl !== undefined) {
        updates.push(`image_url = $${paramIndex++}`);
        params.push(imageUrl || null);
      }

      if (updates.length > 0) {
        params.push(id);
        await query(
          `UPDATE lighting_floors SET ${updates.join(
            ", "
          )}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
          params
        );
      }

      // 處理區域更新（智能更新：保留 ID，更新/新增/刪除）
      if (areas !== undefined) {
        // 取得現有區域 ID 列表
        const existingAreas = await query(
          "SELECT id FROM lighting_areas WHERE floor_id = $1",
          [id]
        );
        const existingAreaIds = new Set(existingAreas.map((a) => String(a.id)));

        // 處理每個區域
        const updatedAreaIds = new Set();
        for (const area of areas) {
          const areaId = area.id ? String(area.id) : null;

          if (areaId && existingAreaIds.has(areaId)) {
            // 更新現有區域（保留 ID）
            await validateAndUpdateArea(query, parseInt(areaId), area, userId);
            updatedAreaIds.add(areaId);
          } else {
            // 建立新區域
            const newAreaId = await validateAndCreateArea(
              query,
              id,
              area,
              userId
            );
            updatedAreaIds.add(String(newAreaId));
          }
        }

        // 刪除不在更新列表中的區域
        const areasToDelete = Array.from(existingAreaIds).filter(
          (id) => !updatedAreaIds.has(id)
        );
        if (areasToDelete.length > 0) {
          await query(`DELETE FROM lighting_areas WHERE id = ANY($1::int[])`, [
            areasToDelete.map((id) => parseInt(id)),
          ]);
        }
      }
    });

    // 取得更新後的完整樓層資料
    const floorResult = await getFloorById(id);
    return {
      message: "樓層更新成功",
      floor: floorResult.floor,
    };
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    // 處理唯一性約束錯誤
    if (
      error.code === "23505" &&
      error.constraint === "lighting_floors_name_key"
    ) {
      const duplicateError = new Error("樓層名稱已存在");
      duplicateError.statusCode = 400;
      throw duplicateError;
    }
    console.error("更新樓層失敗:", error);
    throw new Error("更新樓層失敗: " + error.message);
  }
}

// 刪除樓層
async function deleteFloor(id) {
  try {
    // 檢查樓層是否存在
    const floors = await db.query(
      "SELECT id FROM lighting_floors WHERE id = $1",
      [id]
    );
    if (floors.length === 0) {
      const error = new Error("樓層不存在");
      error.statusCode = 404;
      throw error;
    }

    // 刪除樓層（區域會自動級聯刪除）
    await db.query("DELETE FROM lighting_floors WHERE id = $1", [id]);

    return { message: "樓層已刪除" };
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
