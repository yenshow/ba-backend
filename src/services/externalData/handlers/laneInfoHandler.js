const BaseExternalDataService = require("../baseExternalDataService");

/**
 * 車道配置專用處理器（vehiclebiz.lane_info）
 * 供前端地點設定使用：lane_name（車道名稱）、lane_type（1 進 2 出）
 * 預設只顯示 deleted = 0（未刪除）
 */
class LaneInfoHandler extends BaseExternalDataService {
  constructor() {
    super("vehiclebiz", "lane_info", {
      defaultOrderBy: "id",
      defaultOrderDirection: "ASC",
      defaultLimit: 200,
      maxLimit: 500,
    });
  }

  getSearchableColumns() {
    return ["lane_name"];
  }

  applyDefaultFilters(filters) {
    if (filters.deleted === undefined) {
      filters.deleted = 0;
    }
  }

  async getList(filters = {}) {
    this.applyDefaultFilters(filters);
    return await super.getList(filters);
  }

  async getById(id) {
    const result = await super.getById(id);
    if (result.success && result.data && result.data.deleted !== 0) {
      return { success: false, message: "找不到該車道或已刪除" };
    }
    return result;
  }

  async getCount(filters = {}) {
    this.applyDefaultFilters(filters);
    return await super.getCount(filters);
  }
}

module.exports = LaneInfoHandler;
