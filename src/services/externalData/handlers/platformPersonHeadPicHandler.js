const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Platform Person Head Pic 專用處理器
 * 處理 platform.person_head_pic 資料表的特殊邏輯
 */
class PlatformPersonHeadPicHandler extends BaseExternalDataService {
  constructor() {
    super("platform", "person_head_pic", {
      defaultOrderBy: "id",
      defaultOrderDirection: "DESC",
      defaultLimit: 50,
      maxLimit: 1000,
    });
  }

  /**
   * 覆寫：取得可搜尋的欄位
   */
  getSearchableColumns() {
    return ["person_id"];
  }

  /**
   * 覆寫：取得資料列表
   * 注意：standard_head_portrait 為 Base64 編碼的二進位資料，需在前端解碼
   */
  async getList(filters = {}) {
    return await super.getList(filters);
  }

  /**
   * 取得人員頭像 ID
   * @param {number} personId - 人員 ID
   * @returns {Promise<number|null>} 頭像 ID，如果不存在則返回 null
   */
  async getHeadPicIdByPersonId(personId) {
    const result = await this.getList({ person_id: personId, limit: 1 });
    if (result.success && result.data && result.data.length > 0) {
      return result.data[0].id;
    }
    return null;
  }
}

module.exports = PlatformPersonHeadPicHandler;

