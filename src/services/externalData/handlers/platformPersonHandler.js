const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Platform Person 專用處理器
 * 處理 platform.person 資料表的特殊邏輯
 */
class PlatformPersonHandler extends BaseExternalDataService {
  constructor() {
    super("platform", "person", {
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
    return ["full_name", "given_name", "family_name", "person_code", "email"];
  }

  /**
   * 覆寫：取得資料列表（加入 person_type 過濾邏輯）
   */
  async getList(filters = {}) {
    // 如果指定只顯示 person_type = 0，則加入過濾條件
    // 注意：如果 filters 中已經有 person_type，則使用指定的值
    // 如果沒有指定，預設只顯示一般人員（person_type = 0）
    if (filters.person_type === undefined) {
      filters.person_type = 0;
    }

    // 呼叫父類別的方法
    return await super.getList(filters);
  }

  /**
   * 判斷人員類型
   * @param {number} personType - 人員類型
   * @returns {string} 人員類型描述
   */
  getPersonTypeLabel(personType) {
    const typeMap = {
      0: "一般人員",
      1: "訪客",
      2: "黑名單",
    };
    return typeMap[personType] || "未知";
  }
}

module.exports = PlatformPersonHandler;

