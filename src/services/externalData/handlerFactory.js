const PlatformPersonHandler = require("./handlers/platformPersonHandler");
const PlatformPersonGroupHandler = require("./handlers/platformPersonGroupHandler");
const PlatformVehicleListHandler = require("./handlers/platformVehicleListHandler");
const BaseacsSlotCardRecordsHandler = require("./handlers/baseacsSlotCardRecordsHandler");
const DeviceaccessDoorHandler = require("./handlers/deviceaccessDoorHandler");
const PassagewayLogDataHandler = require("./handlers/passagewayLogDataHandler");
const LaneInfoHandler = require("./handlers/laneInfoHandler");
const systemMapping = require("./systemMapping");

/**
 * 處理器工廠
 * 根據 schema 和 table 動態選擇對應的處理器
 */
class HandlerFactory {
  constructor() {
    // 註冊所有可用的處理器
    this.handlers = new Map();

    // 註冊 platform schema 的處理器
    this.register("platform", "person", new PlatformPersonHandler());
    this.register("platform", "person_group", new PlatformPersonGroupHandler());
    this.register("platform", "vehicle_list", new PlatformVehicleListHandler());

    // 註冊 baseacs schema 的處理器
    this.register(
      "baseacs",
      "slot_card_records",
      new BaseacsSlotCardRecordsHandler(),
    );

    // 註冊 deviceaccess schema 的處理器
    this.register("deviceaccess", "door", new DeviceaccessDoorHandler());

    // 註冊 vehiclebiz schema 的處理器（車輛進出／出入口過車日誌、車道配置）
    this.register(
      "vehiclebiz",
      "passageway_log_data",
      new PassagewayLogDataHandler(),
    );
    this.register("vehiclebiz", "lane_info", new LaneInfoHandler());
  }

  /**
   * 註冊處理器
   */
  register(schema, table, handler) {
    const key = `${schema}.${table}`;
    this.handlers.set(key, handler);
  }

  /**
   * 取得處理器
   */
  getHandler(schema, table) {
    const key = `${schema}.${table}`;
    const handler = this.handlers.get(key);

    if (!handler) {
      throw new Error(
        `找不到 ${key} 的處理器。請確認 schema 和 table 是否正確，或該處理器是否已註冊。`,
      );
    }

    return handler;
  }

  /**
   * 檢查處理器是否存在
   */
  hasHandler(schema, table) {
    const key = `${schema}.${table}`;
    return this.handlers.has(key);
  }

  /**
   * 取得所有已註冊的處理器列表
   */
  getAllHandlers() {
    return Array.from(this.handlers.keys());
  }

  /**
   * 取得指定系統使用的所有處理器
   * @param {string} systemType - 系統類型
   * @returns {Array} 處理器資訊列表
   */
  getHandlersBySystem(systemType) {
    const tables = systemMapping.getTablesBySystem(systemType);
    return tables
      .filter(({ schema, table }) => this.hasHandler(schema, table))
      .map(({ schema, table }) => ({
        schema,
        table,
        handler: this.getHandler(schema, table),
      }));
  }

  /**
   * 取得所有系統及其使用的資料表對應關係
   * @returns {Object} 系統對應關係
   */
  getSystemTableMapping() {
    return systemMapping.getSystemTableMapping();
  }
}

// 匯出單例
module.exports = new HandlerFactory();
