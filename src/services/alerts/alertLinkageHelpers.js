/**
 * 警報聯動 CRUD 共用（normalize／PG int[]／依 rule_id 讀寫刪）
 * 不含 DO 主流程（alertLinkageService）與各域 process*。
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const normalizeId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalizeIdList = (v, maxLen = 100) => {
  if (!Array.isArray(v)) return [];
  const ids = v.map(normalizeId).filter(Boolean);
  return [...new Set(ids)].slice(0, maxLen);
};

const parsePgIntArray = (v, maxLen = 100) => {
  if (Array.isArray(v)) {
    return normalizeIdList(v, maxLen);
  }
  if (typeof v !== "string") return [];
  const inner = v.trim().replace(/^\s*\{|\}\s*$/g, "");
  if (!inner) return [];
  return normalizeIdList(
    inner.split(",").map((x) => String(x).trim()),
    maxLen,
  );
};

/**
 * @param {object} options
 * @param {string} options.tableName
 * @param {string} options.idsColumn DB 欄位名（device_ids / camera_device_ids / location_ids）
 * @param {string} options.payloadIdsKey upsert payload 鍵名
 * @param {number} [options.maxIds=100]
 * @param {(row: object, parseIds: Function) => object} [options.mapRow] 自訂列正規化
 */
function createRuleLinkageCrud(options) {
  const {
    tableName,
    idsColumn,
    payloadIdsKey,
    maxIds = 100,
    mapRow,
  } = options;

  const normalizeRow = (row) => {
    if (!row) return row;
    if (typeof mapRow === "function") {
      return mapRow(row, (v) => parsePgIntArray(v, maxIds));
    }
    return {
      ...row,
      [idsColumn]: parsePgIntArray(row[idsColumn], maxIds),
    };
  };

  async function getByRuleId(ruleId) {
    const rid = normalizeId(ruleId);
    if (!rid) return null;
    const rows = await db.query(
      `SELECT * FROM ${tableName} WHERE rule_id = ? LIMIT 1`,
      [rid],
    );
    return normalizeRow(rows?.[0] || null);
  }

  async function getByRuleIds(ruleIds) {
    const ids = Array.isArray(ruleIds)
      ? [...new Set(ruleIds.map(normalizeId).filter(Boolean))]
      : [];
    if (ids.length === 0) return [];
    const rows = await db.query(
      `SELECT * FROM ${tableName} WHERE rule_id = ANY(?)`,
      [ids],
    );
    return (rows || []).map(normalizeRow);
  }

  async function upsertForRule(ruleId, payload, userId = null) {
    const rid = normalizeId(ruleId);
    if (!rid) throwApiError(C.ALERT_LINKAGE_RULE_ID_INVALID, "rule_id 不合法");
    const enabled =
      payload?.enabled !== undefined ? Boolean(payload.enabled) : true;
    const idList = normalizeIdList(payload?.[payloadIdsKey], maxIds);

    const rows = await db.query(
      `
      INSERT INTO ${tableName} (rule_id, enabled, ${idsColumn}, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (rule_id)
      DO UPDATE SET
        enabled = EXCLUDED.enabled,
        ${idsColumn} = EXCLUDED.${idsColumn},
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [rid, enabled, idList, userId != null ? Number(userId) : null],
    );
    return normalizeRow(rows?.[0] || null);
  }

  async function deleteForRule(ruleId) {
    const rid = normalizeId(ruleId);
    if (!rid) return { deleted: 0 };
    const rows = await db.query(
      `DELETE FROM ${tableName} WHERE rule_id = ? RETURNING id`,
      [rid],
    );
    return { deleted: rows?.length || 0 };
  }

  return {
    getByRuleId,
    getByRuleIds,
    upsertForRule,
    deleteForRule,
    normalizeRow,
  };
}

module.exports = {
  normalizeId,
  normalizeIdList,
  parsePgIntArray,
  createRuleLinkageCrud,
};
