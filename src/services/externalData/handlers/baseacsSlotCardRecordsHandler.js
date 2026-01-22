const BaseExternalDataService = require("../baseExternalDataService");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const config = require("../../../config");
const logger = require("../../../utils/logger");

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
   * 計算近兩天的開始時間（兩天前的 00:00:00）
   */
  getTwoDaysAgo() {
    const now = new Date();
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(now.getDate() - 2);
    twoDaysAgo.setHours(0, 0, 0, 0);
    return twoDaysAgo;
  }

  /**
   * 套用預設篩選條件（is_deleted 和近兩天時間範圍）
   */
  applyDefaultFilters(filters) {
    // 預設只顯示未刪除的記錄（is_deleted = false）
    if (filters.is_deleted === undefined) {
      filters.is_deleted = false;
    }

    // 預設篩選近兩天的資料
    // 如果未指定時間範圍且未指定自訂時間，則使用近兩天
    if (!filters.timeRange && !filters.startTime && !filters.endTime) {
      filters.swip_card_rev_time_start = this.getTwoDaysAgo().toISOString();
    }

    // 處理時間範圍篩選
    if (filters.timeRange) {
      const timeRange = this.getTimeRange(filters.timeRange);
      if (timeRange) {
        filters.swip_card_rev_time_start = timeRange.start.toISOString();
        filters.swip_card_rev_time_end = timeRange.end.toISOString();
      }
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
  }

  /**
   * 覆寫：取得資料列表
   */
  async getList(filters = {}) {
    this.applyDefaultFilters(filters);

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
    this.applyDefaultFilters(filters);
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

  /**
   * 獲取 YSCP 報警圖片（內部方法）
   * @param {string} picUri - 圖片 URI
   * @returns {Promise<object>} 圖片數據
   */
  async _getAlarmPicture(picUri) {
    const serviceLogger = logger.createLogger("YSCP Alarm Picture Service");
    
    try {
      // 構建 URL 路徑
      const urlPath = `/artemis/api/eventService/${config.yscp.apiVersion}/image_data`;
      const fullUrl = `${config.yscp.host}${urlPath}`;

      // 構建簽名
      const accept = "application/json";
      const contentType = "application/json;charset=UTF-8";
      const textToSign = `POST\n${accept}\n${contentType}\n${urlPath}`;
      const signature = crypto
        .createHmac("sha256", config.yscp.secretKey)
        .update(textToSign)
        .digest("base64");

      // 配置 HTTPS Agent 以處理自簽名證書
      const httpsAgent = new https.Agent({
        rejectUnauthorized: config.yscp.rejectUnauthorized,
      });

      // 發送請求
      const response = await axios.post(
        fullUrl,
        { picUri },
        {
          headers: {
            Accept: accept,
            "Content-Type": contentType,
            "X-Ca-Key": config.yscp.accessKey,
            "X-Ca-Signature": signature,
          },
          httpsAgent,
        }
      );

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      serviceLogger.error("獲取報警圖片失敗", {
        picUri,
        error: error.response?.data || error.message,
      });

      return {
        success: false,
        error: error.response?.data || error.message,
        status: error.response?.status || 500,
      };
    }
  }

  /**
   * 根據記錄 ID 獲取快照圖片
   * @param {number} id - 記錄 ID
   * @returns {Promise<object>} 圖片數據
   */
  async getPictureById(id) {
    const recordResult = await this.getById(id);
    
    if (!recordResult.success || !recordResult.data) {
      return { success: false, error: "記錄不存在" };
    }

    const picUri = recordResult.data.snap_pic_url?.trim();
    if (!picUri) {
      return { success: false, error: "該記錄沒有快照圖片 URL" };
    }

    const pictureResult = await this._getAlarmPicture(picUri);
    if (!pictureResult.success) {
      return {
        success: false,
        error: pictureResult.error || "獲取圖片失敗",
        status: pictureResult.status,
      };
    }

    return {
      success: true,
      data: {
        recordId: id,
        picUri,
        image: pictureResult.data,
      },
    };
  }

  /**
   * 根據 snap_pic_url 直接獲取圖片
   * @param {string} picUri - 圖片 URI
   * @returns {Promise<object>} 圖片數據
   */
  async getPictureByUri(picUri) {
    if (!picUri?.trim()) {
      return { success: false, error: "picUri 參數不能為空" };
    }

    const pictureResult = await this._getAlarmPicture(picUri.trim());
    if (!pictureResult.success) {
      return {
        success: false,
        error: pictureResult.error || "獲取圖片失敗",
        status: pictureResult.status,
      };
    }

    return {
      success: true,
      data: {
        picUri: picUri.trim(),
        image: pictureResult.data,
      },
    };
  }
}

module.exports = BaseacsSlotCardRecordsHandler;
