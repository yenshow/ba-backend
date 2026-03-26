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
 * 閾值規則緩存（規則寫入資料庫後就是固定的，可以永久緩存）
 * key: source, value: { rules: Array, timestamp: number }
 */
const thresholdRulesCache = new Map();

/**
 * 清除指定來源的閾值規則緩存（當規則更新時調用）
 * @param {string} source - 系統來源
 */
function clearThresholdRulesCache(source = null) {
  if (source) {
    thresholdRulesCache.delete(source);
  } else {
    thresholdRulesCache.clear();
  }
}

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
 * 查詢閾值規則（帶緩存）
 * 規則寫入資料庫後就是固定的，可以永久緩存直到手動清除
 * @param {string} source - 系統來源
 * @param {string} parameter - 參數名稱（可選）
 * @returns {Promise<Array>} 閾值規則列表
 */
async function getThresholdRules(source, parameter = null) {
  try {
    // 檢查緩存
    const cacheKey = source;
    let cached = thresholdRulesCache.get(cacheKey);

    // 如果緩存不存在，從資料庫查詢並緩存
    if (!cached) {
      const query = `
        SELECT * FROM alert_rules
        WHERE source = ? 
          AND alert_type = 'threshold'
          AND condition_type = 'threshold'
          AND enabled = TRUE
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END, id DESC
      `;

      const result = await db.query(query, [source]);
      const rules = result || [];

      // 永久緩存（規則寫入後就是固定的）
      thresholdRulesCache.set(cacheKey, {
        rules: rules,
        timestamp: Date.now(),
      });

      cached = thresholdRulesCache.get(cacheKey);
    }

    // 如果指定了參數，過濾出該參數的規則
    if (parameter) {
      return cached.rules.filter(
        (rule) => rule.condition_config?.parameter === parameter
      );
    }

    return cached.rules;
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
 * 建立警報規則
 * @param {Object} payload
 * @returns {Promise<Object>} 建立後的規則
 */
async function createAlertRule(payload) {
  const {
    source,
    alert_type,
    severity,
    name = null,
    dimension_key = null,
    target_type = null,
    target_id = null,
    condition_type = null,
    condition_config = null,
    message_template = null,
    enabled = true,
  } = payload;

  const query = `
    INSERT INTO alert_rules (
      source,
      alert_type,
      severity,
      name,
      dimension_key,
      target_type,
      target_id,
      condition_type,
      condition_config,
      message_template,
      enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
    RETURNING *
  `;

  const result = await db.query(query, [
    source,
    alert_type,
    severity,
    name,
    dimension_key,
    target_type,
    target_id,
    condition_type,
    condition_config ? JSON.stringify(condition_config) : null,
    message_template,
    enabled,
  ]);

  const rule = result?.[0] || null;
  if (!rule) {
    throw new Error("建立警報規則失敗");
  }

  if (rule.alert_type === "threshold") {
    clearThresholdRulesCache(rule.source);
  }

  return rule;
}

/**
 * 更新警報規則
 * @param {number} id
 * @param {Object} updates
 * @returns {Promise<Object>} 更新後規則
 */
async function updateAlertRule(id, updates) {
  const existingResult = await db.query(
    "SELECT * FROM alert_rules WHERE id = ? LIMIT 1",
    [id]
  );
  const existingRule = existingResult?.[0] || null;
  if (!existingRule) {
    throw new Error("RULE_NOT_FOUND");
  }

  const fields = [];
  const params = [];

  if (updates.source !== undefined) {
    fields.push("source = ?");
    params.push(updates.source);
  }
  if (updates.alert_type !== undefined) {
    fields.push("alert_type = ?");
    params.push(updates.alert_type);
  }
  if (updates.severity !== undefined) {
    fields.push("severity = ?");
    params.push(updates.severity);
  }
  if (updates.name !== undefined) {
    fields.push("name = ?");
    params.push(updates.name);
  }
  if (updates.dimension_key !== undefined) {
    fields.push("dimension_key = ?");
    params.push(updates.dimension_key);
  }
  if (updates.target_type !== undefined) {
    fields.push("target_type = ?");
    params.push(updates.target_type);
  }
  if (updates.target_id !== undefined) {
    fields.push("target_id = ?");
    params.push(updates.target_id);
  }
  if (updates.condition_type !== undefined) {
    fields.push("condition_type = ?");
    params.push(updates.condition_type);
  }
  if (updates.condition_config !== undefined) {
    fields.push("condition_config = ?::jsonb");
    params.push(
      updates.condition_config === null
        ? null
        : JSON.stringify(updates.condition_config)
    );
  }
  if (updates.message_template !== undefined) {
    fields.push("message_template = ?");
    params.push(updates.message_template);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    params.push(updates.enabled);
  }

  if (fields.length === 0) {
    return existingRule;
  }

  fields.push("updated_at = CURRENT_TIMESTAMP");
  params.push(id);

  const query = `
    UPDATE alert_rules
    SET ${fields.join(", ")}
    WHERE id = ?
    RETURNING *
  `;
  const result = await db.query(query, params);
  const updatedRule = result?.[0] || null;
  if (!updatedRule) {
    throw new Error("更新警報規則失敗");
  }

  const shouldClearThresholdCache =
    existingRule.alert_type === "threshold" ||
    updatedRule.alert_type === "threshold";
  if (shouldClearThresholdCache) {
    clearThresholdRulesCache(existingRule.source);
    if (updatedRule.source !== existingRule.source) {
      clearThresholdRulesCache(updatedRule.source);
    }
  }

  return updatedRule;
}

/**
 * 取得排水 bit_state 警報定義（套用 target 範圍）
 * 優先序：system > location > zone > global
 */
async function getDrainageBitStateRulesForSystem(systemId) {
  const q = `
    SELECT
      r.*,
      ls.location_id,
      l.zone_id
    FROM alert_rules r
    LEFT JOIN location_systems ls ON ls.id = ? AND ls.system_type = 'drainage'
    LEFT JOIN locations l ON l.id = ls.location_id
    WHERE r.source = 'drainage'
      AND r.condition_type = 'bit_state'
      AND r.enabled = TRUE
      AND (
        r.target_type IS NULL OR r.target_id IS NULL
        OR (r.target_type = 'system' AND r.target_id = ?)
        OR (r.target_type = 'location' AND r.target_id = ls.location_id)
        OR (r.target_type = 'zone' AND r.target_id = l.zone_id)
      )
    ORDER BY
      CASE r.target_type
        WHEN 'system' THEN 1
        WHEN 'location' THEN 2
        WHEN 'zone' THEN 3
        ELSE 4
      END,
      CASE r.severity WHEN 'critical' THEN 1 WHEN 'error' THEN 2 WHEN 'warning' THEN 3 END,
      r.id DESC
  `;
  const rows = await db.query(q, [systemId, systemId]);
  return rows || [];
}

/**
 * 刪除警報規則
 * @param {number} id
 * @returns {Promise<Object>} 刪除前的規則
 */
async function deleteAlertRule(id) {
  const result = await db.query(
    "DELETE FROM alert_rules WHERE id = ? RETURNING *",
    [id]
  );
  const deletedRule = result?.[0] || null;
  if (!deletedRule) {
    throw new Error("RULE_NOT_FOUND");
  }

  if (deletedRule.alert_type === "threshold") {
    clearThresholdRulesCache(deletedRule.source);
  }

  return deletedRule;
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

/**
 * 匹配規則（通用函數）
 * 優先級：指定來源規則 > 全域規則
 * @param {Array} rules - 規則列表
 * @param {string} conditionType - 條件類型（用於過濾）
 * @param {number} sourceId - 來源 ID（用於匹配指定來源規則）
 * @returns {Object|null} 匹配到的規則，如果沒有則返回 null
 */
function matchRule(rules, conditionType, sourceId) {
  if (!rules || rules.length === 0) {
    return null;
  }

  // 過濾出指定條件類型的規則
  const candidateRules = rules.filter(
    (r) => r.condition_type === conditionType
  );

  if (candidateRules.length === 0) {
    return null;
  }

  // 優先級匹配：指定來源規則 > 全域規則
  // 1. 先找指定 source_id 的規則（確保類型匹配）
  const specificRule = candidateRules.find(
    (r) =>
      r.condition_config?.source_id !== undefined &&
      Number(r.condition_config.source_id) === Number(sourceId)
  );

  if (specificRule) {
    return specificRule;
  }

  // 2. 再找沒有指定 source_id 的全域規則
  const globalRule = candidateRules.find(
    (r) =>
      !r.condition_config ||
      r.condition_config.source_id === undefined
  );

  return globalRule || null;
}

module.exports = {
  getAlertRules,
  getThresholdRules,
  getErrorCountRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getDrainageBitStateRulesForSystem,
  evaluateThreshold,
  formatMessage,
  getParameterDisplayName,
  groupRulesByParameter,
  matchRule,
  clearThresholdRulesCache,
  SEVERITY_ORDER,
};

