const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Platform Person Group 專用處理器
 * 處理 platform.person_group 資料表的特殊邏輯
 */
class PlatformPersonGroupHandler extends BaseExternalDataService {
  constructor() {
    super("platform", "person_group", {
      defaultOrderBy: "id",
      defaultOrderDirection: "ASC",
      defaultLimit: 50,
      maxLimit: 1000,
    });
  }

  /**
   * 覆寫：取得可搜尋的欄位
   */
  getSearchableColumns() {
    return ["name"];
  }

  /**
   * 覆寫：取得資料列表（加入 is_deleted 過濾邏輯）
   */
  async getList(filters = {}) {
    // 預設只顯示未刪除的資料（is_deleted = 0）
    // 注意：如果 filters 中已經有 is_deleted，則使用指定的值
    if (filters.is_deleted === undefined) {
      filters.is_deleted = 0;
    }

    // 呼叫父類別的方法
    return await super.getList(filters);
  }
}

module.exports = PlatformPersonGroupHandler;
