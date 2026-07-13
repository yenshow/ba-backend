/**
 * 營運事件：統一 envelope 寫入／查詢／清理
 * 寫入失敗僅 warn，不阻斷業務主流程
 */
const db = require("../../database/db");
const logger = require("../../utils/logger");
const config = require("../../config");

const opLogger = logger.createLogger("operationalEvents");

const EVENT_KINDS = Object.freeze([
  "control_write",
  "state_change",
  "linkage_write",
  "access",
  "vehicle",
  "elevator",
]);

const toIntOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const toBoolOrNull = (v) => {
  if (v == null) return null;
  return Boolean(v);
};

function buildListWhere(filters = {}) {
  const { source, event_kind, start_date, end_date, q } = filters;
  let where = "WHERE 1=1";
  const params = [];

  if (source) {
    where += " AND source = ?";
    params.push(String(source));
  }
  if (event_kind) {
    where += " AND event_kind = ?";
    params.push(String(event_kind));
  }
  if (start_date) {
    where += " AND occurred_at >= ?";
    params.push(start_date);
  }
  if (end_date) {
    where += " AND occurred_at <= ?";
    params.push(end_date);
  }
  if (q && String(q).trim()) {
    where += " AND summary ILIKE ?";
    params.push(`%${String(q).trim()}%`);
  }

  return { where, params };
}

/**
 * 記錄一筆營運事件（fire-and-forget 語意：錯誤不拋出）
 * @returns {Promise<number|null>}
 */
async function recordEvent(input = {}) {
  try {
    const eventKind = String(input.event_kind || "").trim();
    if (!EVENT_KINDS.includes(eventKind)) {
      opLogger.warn("略過營運事件：無效 event_kind", { eventKind });
      return null;
    }

    const source = String(input.source || "").trim();
    if (!source) {
      opLogger.warn("略過營運事件：缺少 source");
      return null;
    }

    const summary =
      String(input.summary || "").trim() || `${source} ${eventKind}`;
    const alertId = toIntOrNull(input.alert_id);
    if (eventKind === "linkage_write" && alertId == null) {
      opLogger.warn("略過 linkage_write：缺少 alert_id", { source });
      return null;
    }

    let payload = null;
    if (input.payload != null) {
      payload =
        typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload);
    }

    const rows = await db.query(
      `
      INSERT INTO operational_events (
        occurred_at, source, event_kind,
        location_id, system_id, device_id,
        bit_key, address, old_value, new_value,
        summary, actor_user_id, alert_id,
        ref_table, ref_id, payload
      ) VALUES (
        COALESCE(?, CURRENT_TIMESTAMP), ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?::jsonb
      )
      RETURNING id
      `,
      [
        input.occurred_at || null,
        source,
        eventKind,
        toIntOrNull(input.location_id),
        toIntOrNull(input.system_id),
        toIntOrNull(input.device_id),
        input.bit_key != null ? String(input.bit_key) : null,
        toIntOrNull(input.address),
        toBoolOrNull(input.old_value),
        toBoolOrNull(input.new_value),
        summary,
        toIntOrNull(input.actor_user_id),
        alertId,
        input.ref_table != null ? String(input.ref_table) : null,
        toIntOrNull(input.ref_id),
        payload,
      ],
    );
    return rows?.[0]?.id ?? null;
  } catch (err) {
    opLogger.warn("寫入營運事件失敗（不影響主流程）", {
      error: err?.message || String(err),
      source: input?.source,
      event_kind: input?.event_kind,
    });
    return null;
  }
}

/**
 * 查詢列表（含 byKind 簡易統計，避免另開 /stats）
 */
async function listEvents(filters = {}) {
  const { where, params } = buildListWhere(filters);
  const lim = Math.min(Math.max(toIntOrNull(filters.limit) ?? 50, 1), 5000);
  const off = Math.max(toIntOrNull(filters.offset) ?? 0, 0);

  const [countRows, events, byKind] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total FROM operational_events ${where}`,
      params,
    ),
    db.query(
      `
      SELECT
        id, occurred_at, source, event_kind,
        location_id, system_id, device_id,
        bit_key, address, old_value, new_value,
        summary, actor_user_id, alert_id,
        ref_table, ref_id, payload, created_at
      FROM operational_events
      ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, lim, off],
    ),
    db.query(
      `
      SELECT event_kind, COUNT(*)::int AS count
      FROM operational_events
      ${where}
      GROUP BY event_kind
      ORDER BY event_kind
      `,
      params,
    ),
  ]);

  return {
    events: events || [],
    total: countRows?.[0]?.total ?? 0,
    limit: lim,
    offset: off,
    byKind: byKind || [],
  };
}

async function purgeExpiredEvents(retentionDays) {
  const days =
    toIntOrNull(retentionDays) ??
    config.operationalEvents?.retentionDays ??
    90;
  const safeDays = Math.max(days, 1);
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const result = await db.query(
    `DELETE FROM operational_events WHERE occurred_at < ?`,
    [cutoff.toISOString()],
  );
  const deleted = result?.rowCount ?? 0;
  if (deleted > 0) {
    opLogger.info("營運事件過期清理完成", { deleted, retentionDays: safeDays });
  }
  return { deleted, retentionDays: safeDays };
}

module.exports = {
  EVENT_KINDS,
  recordEvent,
  listEvents,
  purgeExpiredEvents,
};
