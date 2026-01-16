const BaseExternalDataService = require("../baseExternalDataService");

/**
 * Baseacs Slot Card Records 專用處理器
 * 處理 baseacs.slot_card_records 資料表的特殊邏輯
 */
class BaseacsSlotCardRecordsHandler extends BaseExternalDataService {
  constructor() {
    super("baseacs", "slot_card_records", {
      defaultOrderBy: "swip_card_rev_time",
      defaultOrderDirection: "DESC",
      defaultLimit: 50,
      maxLimit: 1000,
    });
  }

  /**
   * 覆寫：取得可搜尋的欄位
   */
  getSearchableColumns() {
    return ["full_name", "card_no", "message_key"];
  }

  /**
   * 取得時間範圍的開始和結束時間
   */
  getTimeRange(timeRange) {
    const now = new Date();
    const start = new Date();
    const end = new Date(now);

    switch (timeRange) {
      case "last_hour":
        // 過去一小時
        start.setHours(now.getHours() - 1);
        break;

      case "today":
        // 今天
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        break;

      case "yesterday":
        // 昨天
        start.setDate(now.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(now.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        break;

      case "this_week":
        // 本週（週一到今天）
        const dayOfWeek = now.getDay();
        const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // 週日視為週六
        start.setDate(now.getDate() - diff);
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        break;

      case "last_week":
        // 上週（週一到週日）
        const lastWeekStart = new Date(now);
        const lastWeekEnd = new Date(now);
        const lastDayOfWeek = now.getDay();
        const lastDiff = lastDayOfWeek === 0 ? 6 : lastDayOfWeek - 1;
        lastWeekStart.setDate(now.getDate() - lastDiff - 7);
        lastWeekStart.setHours(0, 0, 0, 0);
        lastWeekEnd.setDate(now.getDate() - lastDiff - 1);
        lastWeekEnd.setHours(23, 59, 59, 999);
        return { start: lastWeekStart, end: lastWeekEnd };

      case "last_30_days":
        // 最近 30 天
        start.setDate(now.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        break;

      default:
        return null;
    }

    return { start, end };
  }

  /**
   * 覆寫：取得資料列表
   */
  async getList(filters = {}) {
    // 預設只顯示未刪除的記錄（is_deleted = false）
    if (filters.is_deleted === undefined) {
      filters.is_deleted = false;
    }

    // 處理時間範圍篩選
    if (filters.timeRange) {
      const timeRange = this.getTimeRange(filters.timeRange);
      if (timeRange) {
        filters.swip_card_rev_time_start = timeRange.start.toISOString();
        filters.swip_card_rev_time_end = timeRange.end.toISOString();
      }
      // 移除 timeRange 參數，避免被當作一般篩選條件
      delete filters.timeRange;
    }

    // 處理自訂時間範圍
    if (filters.startTime) {
      filters.swip_card_rev_time_start = filters.startTime;
      delete filters.startTime;
    }
    if (filters.endTime) {
      filters.swip_card_rev_time_end = filters.endTime;
      delete filters.endTime;
    }

    const result = await super.getList(filters);

    // 後處理：標記未註冊的人員（person_id = -1）
    if (result.success && result.data) {
      result.data = result.data.map((item) => ({
        ...item,
        // 標記是否為未註冊人員（person_id = -1 代表未註冊）
        is_registered: item.person_id !== -1,
      }));
    }

    return result;
  }

  /**
   * 覆寫：取得單筆資料
   */
  async getById(id) {
    const result = await super.getById(id);

    if (result.success && result.data) {
      result.data = {
        ...result.data,
        // 標記是否為未註冊人員
        is_registered: result.data.person_id !== -1,
      };
    }

    return result;
  }

  /**
   * 覆寫：取得資料總數
   */
  async getCount(filters = {}) {
    // 預設只顯示未刪除的記錄
    if (filters.is_deleted === undefined) {
      filters.is_deleted = false;
    }

    // 處理時間範圍篩選（與 getList 相同邏輯）
    if (filters.timeRange) {
      const timeRange = this.getTimeRange(filters.timeRange);
      if (timeRange) {
        filters.swip_card_rev_time_start = timeRange.start.toISOString();
        filters.swip_card_rev_time_end = timeRange.end.toISOString();
      }
      delete filters.timeRange;
    }

    if (filters.startTime) {
      filters.swip_card_rev_time_start = filters.startTime;
      delete filters.startTime;
    }
    if (filters.endTime) {
      filters.swip_card_rev_time_end = filters.endTime;
      delete filters.endTime;
    }

    return await super.getCount(filters);
  }

  /**
   * 取得未註冊人員的刷卡記錄（person_id = -1）
   */
  async getUnregisteredRecords(filters = {}) {
    filters.person_id = -1;
    return await this.getList(filters);
  }

  /**
   * 取得特定人員的刷卡記錄
   */
  async getRecordsByPersonId(personId, filters = {}) {
    filters.person_id = personId;
    return await this.getList(filters);
  }
}

module.exports = BaseacsSlotCardRecordsHandler;
