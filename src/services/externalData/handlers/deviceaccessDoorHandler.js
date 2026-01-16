const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Deviceaccess Door 專用處理器
 * 處理 deviceaccess.door 資料表的特殊邏輯
 */
class DeviceaccessDoorHandler extends BaseExternalDataService {
  constructor() {
    super("deviceaccess", "door", {
      defaultOrderBy: "dev_name",
      defaultOrderDirection: "ASC",
      defaultLimit: 100,
      maxLimit: 1000,
    });
  }

  /**
   * 覆寫：取得可搜尋的欄位
   */
  getSearchableColumns() {
    return ["dev_name", "guid"];
  }

  /**
   * 覆寫：取得資料列表
   */
  async getList(filters = {}) {
    // 預設只顯示未刪除的門（is_deleted = 0）
    if (filters.is_deleted === undefined) {
      filters.is_deleted = 0;
    }

    const result = await super.getList(filters);

    return result;
  }

  /**
   * 覆寫：取得資料總數
   */
  async getCount(filters = {}) {
    // 預設只顯示未刪除的門
    if (filters.is_deleted === undefined) {
      filters.is_deleted = 0;
    }

    return await super.getCount(filters);
  }

  /**
   * 根據 device_id 取得門列表
   */
  async getDoorsByDeviceId(deviceId, filters = {}) {
    filters.device_id = deviceId;
    return await this.getList(filters);
  }

  /**
   * 根據 physical_id 取得門資訊
   * 注意：physical_id 對應到 baseacs.slot_card_records.physical_id
   * 需要確認 physical_id 與 deviceaccess.door.id 的對應關係
   */
  async getDoorByPhysicalId(physicalId) {
    // 假設 physical_id 對應到 door.id
    // 如果實際對應關係不同，需要調整此方法
    return await this.getById(physicalId);
  }
}

module.exports = DeviceaccessDoorHandler;
