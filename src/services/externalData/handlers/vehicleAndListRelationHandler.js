const BaseExternalDataService = require("../baseExternalDataService");

/**
 * 車輛與名單關聯專用處理器（anpr.vehicle_and_list_relation）
 * 用於車輛群組：vehicle_list_id 對應 vehicle_custom_list.id，vehicle_id 對應 platform.vehicle_list.id
 */
class VehicleAndListRelationHandler extends BaseExternalDataService {
  constructor() {
    super("anpr", "vehicle_and_list_relation", {
      defaultOrderBy: "id",
      defaultOrderDirection: "ASC",
      defaultLimit: 500,
      maxLimit: 5000,
    });
  }

  getSearchableColumns() {
    return [];
  }
}

module.exports = VehicleAndListRelationHandler;
