/**
 * 外部資料表與系統的對應關係
 * 一個資料表可能被多個系統使用
 */

const SYSTEM_TABLE_MAPPING = {
  // 人流統計系統
  people_counting: [
    { schema: "platform", table: "person" },
    { schema: "platform", table: "person_group" },
    { schema: "baseacs", table: "slot_card_records" },
    { schema: "deviceaccess", table: "door" },
  ],

  // 車輛進出系統（過車日誌 + 地點設定用車道列表 + 固定車輛名單）
  vehicle_access: [
    { schema: "vehiclebiz", table: "passageway_log_data" },
    { schema: "vehiclebiz", table: "lane_info" },
    { schema: "platform", table: "vehicle_list" },
  ],
};

/**
 * 取得指定系統使用的資料表列表
 * @param {string} systemType - 系統類型
 * @returns {Array} 資料表列表
 */
function getTablesBySystem(systemType) {
  return SYSTEM_TABLE_MAPPING[systemType] || [];
}

/**
 * 取得使用指定資料表的所有系統
 * @param {string} schema - Schema 名稱
 * @param {string} table - Table 名稱
 * @returns {Array} 系統類型列表
 */
function getSystemsByTable(schema, table) {
  const systems = [];
  for (const [systemType, tables] of Object.entries(SYSTEM_TABLE_MAPPING)) {
    if (tables.some((t) => t.schema === schema && t.table === table)) {
      systems.push(systemType);
    }
  }
  return systems;
}

/**
 * 取得所有已定義的系統類型
 * @returns {Array} 系統類型列表
 */
function getAllSystemTypes() {
  return Object.keys(SYSTEM_TABLE_MAPPING);
}

/**
 * 檢查系統類型是否存在
 * @param {string} systemType - 系統類型
 * @returns {boolean} 是否存在
 */
function hasSystem(systemType) {
  return systemType in SYSTEM_TABLE_MAPPING;
}

/**
 * 取得系統與資料表的完整對應關係
 * @returns {Object} 系統對應關係
 */
function getSystemTableMapping() {
  return SYSTEM_TABLE_MAPPING;
}

module.exports = {
  SYSTEM_TABLE_MAPPING,
  getTablesBySystem,
  getSystemsByTable,
  getAllSystemTypes,
  hasSystem,
  getSystemTableMapping,
};
