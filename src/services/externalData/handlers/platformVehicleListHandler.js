const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Platform Vehicle List 專用處理器（platform.vehicle_list）
 * 固定車輛名單：plate_license（對應 passageway_log_data.license_plate）、owner_name、person_id（查 standard_head_portrait）
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
