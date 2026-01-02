/**
 * 警報規則服務
 * 提供規則查詢、條件評估和訊息格式化功能
 */

const db = require("../../database/db");

/**
 * 嚴重程度排序（用於規則匹配優先級）
 */
const SEVERITY_ORDER = {
  critical: 1,
  error: 2,
  warning: 3,
};

/**
 * 查詢警報規則
 * @param {string} source - 系統來源
 * @param {string} alertType - 警報類型
 * @param {boolean} enabled - 是否只查詢啟用的規則（預設 true）
 * @returns {Promise<Array>} 規則列表
 */
async function getAlertRules(source, alertType, enabled = true) {
  try {
    let query = `
      SELECT * FROM alert_rules
      WHERE source = ? AND alert_type = ?
    `;
    const params = [source, alertType];

    if (enabled) {
      query += " AND enabled = TRUE";
    }

    query += " ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC";

    const result = await db.query(query, params);
    return result || [];
  } catch (error) {
    console.error(
      `[alertRuleService] 查詢規則失敗 (source: ${source}, alertType: ${alertType}):`,
      error
    );
    return [];
  }
}

/**
 * 查詢閾值規則
 * @param {string} source - 系統來源
 * @param {string} parameter - 參數名稱（可選）
 * @returns {Promise<Array>} 閾值規則列表
 */
async function getThresholdRules(source, parameter = null) {
  try {
    let query = `
      SELECT * FROM alert_rules
      WHERE source = ? 
        AND alert_type = 'threshold'
        AND condition_type = 'threshold'
        AND enabled = TRUE
    `;
    const params = [source];

    if (parameter) {
      query += " AND condition_config->>'parameter' = ?";
      params.push(parameter);
    }

    query +=
      " ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC";

    const result = await db.query(query, params);
    return result || [];
  } catch (error) {
    console.error(
      `[alertRuleService] 查詢閾值規則失敗 (source: ${source}, parameter: ${parameter}):`,
      error
    );
    return [];
  }
}

/**
 * 查詢錯誤次數規則
 * @param {string} source - 系統來源
 * @param {string} alertType - 警報類型
 * @returns {Promise<Object|null>} 錯誤次數規則（如果存在）
 */
async function getErrorCountRule(source, alertType) {
  try {
    const query = `
      SELECT * FROM alert_rules
      WHERE source = ?
        AND alert_type = ?
        AND condition_type = 'error_count'
        AND enabled = TRUE
      ORDER BY id DESC
      LIMIT 1
    `;

    const result = await db.query(query, [source, alertType]);
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    console.error(
      `[alertRuleService] 查詢錯誤次數規則失敗 (source: ${source}, alertType: ${alertType}):`,
      error
    );
    return null;
  }
}

/**
 * 評估閾值條件
 * @param {Object} config - 條件配置 { parameter, operator, value, unit }
 * @param {number} value - 當前數值
 * @returns {boolean} 是否符合條件
 */
function evaluateThreshold(config, value) {
  if (value === null || value === undefined) {
    return false;
  }

  const operator = config.operator;
  const threshold = config.value;

  if (typeof threshold !== "number" || typeof value !== "number") {
    return false;
  }

  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    default:
      console.warn(
        `[alertRuleService] 不支援的運算符: ${operator}`
      );
      return false;
  }
}

/**
 * 格式化訊息模板
 * @param {string} template - 訊息模板
 * @param {Object} variables - 變數對象
 * @returns {string} 格式化後的訊息
 */
function formatMessage(template, variables) {
  if (!template) {
    return "";
  }

  let message = template;

  // 替換所有變數 {variable_name}
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{${key}\\}`, "g");
    message = message.replace(regex, String(value));
  }

  return message;
}

/**
 * 取得參數顯示名稱
 * @param {string} parameter - 參數代碼
 * @returns {string} 顯示名稱
 */
function getParameterDisplayName(parameter) {
  const displayNames = {
    pm25: "PM2.5",
    pm10: "PM10",
    tvoc: "TVOC",
    hcho: "HCHO",
    humidity: "濕度",
    temperature: "溫度",
    co2: "CO2",
    noise: "噪音值",
    wind: "風速",
  };

  return displayNames[parameter] || parameter.toUpperCase();
}

/**
 * 按參數分組規則
 * @param {Array} rules - 規則列表
 * @returns {Map<string, Array>} 按參數分組的規則
 */
function groupRulesByParameter(rules) {
  const grouped = new Map();

  for (const rule of rules) {
    const parameter = rule.condition_config?.parameter;
    if (!parameter) continue;

    if (!grouped.has(parameter)) {
      grouped.set(parameter, []);
    }
    grouped.get(parameter).push(rule);
  }

  // 對每個參數的規則按嚴重程度排序
  for (const [parameter, paramRules] of grouped) {
    paramRules.sort((a, b) => {
      const orderA = SEVERITY_ORDER[a.severity] || 999;
      const orderB = SEVERITY_ORDER[b.severity] || 999;
      return orderA - orderB;
    });
  }

  return grouped;
}

module.exports = {
  getAlertRules,
  getThresholdRules,
  getErrorCountRule,
  evaluateThreshold,
  formatMessage,
  getParameterDisplayName,
  groupRulesByParameter,
  SEVERITY_ORDER,
};

