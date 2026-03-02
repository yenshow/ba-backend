const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Platform Vehicle List 專用處理器（platform.vehicle_list）
 * 固定車輛名單：plate_license、owner_name、person_id、person_group_id（對應 platform.person_group.id，供車輛群組穩定顯示）
 */
class PlatformVehicleListHandler extends BaseExternalDataService {
  constructor() {
    super("platform", "vehicle_list", {
      defaultOrderBy: "id",
      defaultOrderDirection: "ASC",
      defaultLimit: 200,
      maxLimit: 1000,
    });
  }

  getSearchableColumns() {
    return ["plate_license", "owner_name"];
  }
}

module.exports = PlatformVehicleListHandler;
