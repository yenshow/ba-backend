const BaseExternalDataService = require("../baseExternalDataService");

/**
 * 車輛自訂名單專用處理器（anpr.vehicle_custom_list）
 * 用於車輛群組：篩選 list_type = 0，取得群組 id、list_name、list_sequence
 */
class VehicleCustomListHandler extends BaseExternalDataService {
  constructor() {
    super("anpr", "vehicle_custom_list", {
      defaultOrderBy: "list_sequence",
      defaultOrderDirection: "ASC",
      defaultLimit: 100,
      maxLimit: 500,
    });
  }

  getSearchableColumns() {
    return ["list_name", "list_description"];
  }

  /**
   * 覆寫：預設只回傳 list_type = 0 的結果（車輛群組用）
   */
  async getList(filters = {}) {
    if (filters.list_type === undefined) {
      filters.list_type = 0;
    }
    return await super.getList(filters);
  }

  async getCount(filters = {}) {
    if (filters.list_type === undefined) {
      filters.list_type = 0;
    }
    return await super.getCount(filters);
  }
}

module.exports = VehicleCustomListHandler;
