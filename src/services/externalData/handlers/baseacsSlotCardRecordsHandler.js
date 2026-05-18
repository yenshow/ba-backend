const BaseExternalDataService = require("../baseExternalDataService");
const { applyDefaultTimeFilters } = require("../../../utils/dateRangeUtils");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const runtimeConfigService = require("../../runtimeConfigService");
const logger = require("../../../utils/logger");

/**
 * Baseacs 刷卡記錄專用處理器（baseacs.slot_card_records）
 * 時間：timeRange=today 或 startTime/endTime；未指定時預設今天
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

  getSearchableColumns() {
    return ["full_name", "card_no", "message_key"];
  }

  applyDefaultFilters(filters) {
    if (filters.is_deleted === undefined) filters.is_deleted = false;
    applyDefaultTimeFilters(
      filters,
      "swip_card_rev_time_start",
      "swip_card_rev_time_end",
    );
  }

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
      const yscp = runtimeConfigService.getYscp();
      const urlPath = `/artemis/api/eventService/${yscp.apiVersion}/image_data`;
      const fullUrl = `${yscp.host}${urlPath}`;

      // 構建簽名
      const accept = "application/json";
      const contentType = "application/json;charset=UTF-8";
      const textToSign = `POST\n${accept}\n${contentType}\n${urlPath}`;
      const signature = crypto
        .createHmac("sha256", yscp.secretKey)
        .update(textToSign)
        .digest("base64");

      // 配置 HTTPS Agent 以處理自簽名證書
      const httpsAgent = new https.Agent({
        rejectUnauthorized: yscp.rejectUnauthorized,
      });

      // 發送請求
      const response = await axios.post(
        fullUrl,
        { picUri },
        {
          headers: {
            Accept: accept,
            "Content-Type": contentType,
            "X-Ca-Key": yscp.accessKey,
            "X-Ca-Signature": signature,
          },
          httpsAgent,
        },
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
   * 批次獲取圖片
   * @param {Array<string>} picUris - 圖片 URI 列表
   * @returns {Promise<Array<object>>} 圖片數據列表
   */
  async getBatchPicturesByUri(picUris) {
    if (!Array.isArray(picUris) || picUris.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      picUris.map(async (picUri) => {
        if (!picUri?.trim()) {
          return {
            picUri: picUri || "",
            success: false,
            error: "picUri 參數不能為空",
          };
        }

        const pictureResult = await this._getAlarmPicture(picUri.trim());
        if (!pictureResult.success) {
          return {
            picUri: picUri.trim(),
            success: false,
            error: pictureResult.error || "獲取圖片失敗",
            status: pictureResult.status,
          };
        }

        return {
          picUri: picUri.trim(),
          success: true,
          image: pictureResult.data,
        };
      }),
    );

    return results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        return {
          picUri: picUris[index] || "",
          success: false,
          error: result.reason?.message || "獲取圖片失敗",
        };
      }
    });
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

    const results = await this.getBatchPicturesByUri([picUri]);
    const result = results[0];

    if (!result || !result.success) {
      return {
        success: false,
        error: result?.error || "獲取圖片失敗",
        status: result?.status,
      };
    }

    return {
      success: true,
      data: {
        picUri: result.picUri,
        image: result.image,
      },
    };
  }
}

module.exports = BaseacsSlotCardRecordsHandler;
