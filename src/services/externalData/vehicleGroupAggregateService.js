/**
 * 車輛群組彙總服務
 * 從 anpr.vehicle_custom_list（list_type=0）、anpr.vehicle_and_list_relation、platform.vehicle_list
 * 組出「群組 + 群組內車輛（plate_license, owner_name）」；不含人員大頭照／platform.person
 */

const handlerFactory = require("./handlerFactory");

/**
 * 取得車輛群組列表（含各群組內車輛名單）
 * 回傳格式：{ groups: [{ id, list_name, list_sequence, vehicles: [{ vehicle_id, plate_license, owner_name }] }] }
 * 另含「未分類」：vehicle_list_id=0 的關聯對應之車輛
 */
async function getVehicleGroups() {
  const customListHandler = handlerFactory.getHandler("anpr", "vehicle_custom_list");
  const relationHandler = handlerFactory.getHandler("anpr", "vehicle_and_list_relation");
  const vehicleListHandler = handlerFactory.getHandler("platform", "vehicle_list");

  const [groupsResult, relationResult, platformListResult] = await Promise.all([
    customListHandler.getList({ list_type: 0, limit: 500 }),
    relationHandler.getList({ limit: 5000 }),
    vehicleListHandler.getList({ limit: 5000 }),
  ]);

  const groups = groupsResult.data || [];
  const relations = relationResult.data || [];
  const platformList = platformListResult.data || [];

  const vehicleIdToInfo = new Map();
  for (const row of platformList) {
    const id = row.id != null ? Number(row.id) : null;
    if (id != null && !Number.isNaN(id)) {
      vehicleIdToInfo.set(id, {
        vehicle_id: id,
        plate_license: row.plate_license ?? null,
        owner_name: row.owner_name ?? null,
      });
    }
  }

  const vehicleIdsByListId = new Map();
  const unassignedVehicleIds = new Set();
  for (const r of relations) {
    const listId = r.vehicle_list_id != null ? Number(r.vehicle_list_id) : null;
    const vId = r.vehicle_id != null ? Number(r.vehicle_id) : null;
    if (vId == null || Number.isNaN(vId)) continue;
    if (listId === 0 || listId == null || Number.isNaN(listId)) {
      unassignedVehicleIds.add(vId);
      continue;
    }
    if (!vehicleIdsByListId.has(listId)) {
      vehicleIdsByListId.set(listId, []);
    }
    vehicleIdsByListId.get(listId).push(vId);
  }

  const result = [];

  for (const g of groups) {
    const id = g.id != null ? Number(g.id) : null;
    if (id == null || Number.isNaN(id)) continue;
    const vehicleIds = vehicleIdsByListId.get(id) || [];
    const vehicles = vehicleIds
      .map((vid) => vehicleIdToInfo.get(vid))
      .filter(Boolean);
    const listName =
      g.list_name != null && String(g.list_name).trim() !== ""
        ? String(g.list_name).trim()
        : `群組 ${id}`;
    result.push({
      id,
      list_name: listName,
      list_sequence: g.list_sequence != null ? Number(g.list_sequence) : 0,
      vehicles,
    });
  }

  const unassignedVehicles = [...unassignedVehicleIds]
    .map((vid) => vehicleIdToInfo.get(vid))
    .filter(Boolean);
  if (unassignedVehicles.length > 0) {
    result.push({
      id: 0,
      list_name: "未分類",
      list_sequence: -1,
      vehicles: unassignedVehicles,
    });
  }

  result.sort((a, b) => {
    if (a.list_sequence !== b.list_sequence) {
      return (a.list_sequence ?? 0) - (b.list_sequence ?? 0);
    }
    return (a.id ?? 0) - (b.id ?? 0);
  });

  return { groups: result };
}

module.exports = {
  getVehicleGroups,
};
