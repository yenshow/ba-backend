/**
 * 營運事件：統一 envelope 寫入／查詢／清理
 * 寫入失敗僅 warn，不阻斷業務主流程
 */
const db = require("../../database/db");
const logger = require("../../utils/logger");
const config = require("../../config");
const websocketService = require("../websocket/websocketService");

const opLogger = logger.createLogger("operationalEvents");

const EVENT_KINDS = Object.freeze([
  "control_write",
  "state_change",
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

function parseMultiFilter(value) {
  if (value == null || value === "") return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildListWhere(filters = {}) {
  const { source, event_kind, start_date, end_date } = filters;
  let where = "WHERE 1=1";
  const params = [];

  // 篩選 people_counting 時一併含歷史 access_control
  const sources = parseMultiFilter(source);
  if (
    sources.includes("people_counting") &&
    !sources.includes("access_control")
  ) {
    sources.push("access_control");
  }
  if (sources.length === 1) {
    where += " AND oe.source = ?";
    params.push(sources[0]);
  } else if (sources.length > 1) {
    where += ` AND oe.source IN (${sources.map(() => "?").join(", ")})`;
    params.push(...sources);
  }

  const kinds = parseMultiFilter(event_kind);
  if (kinds.length === 1) {
    where += " AND oe.event_kind = ?";
    params.push(kinds[0]);
  } else if (kinds.length > 1) {
    where += ` AND oe.event_kind IN (${kinds.map(() => "?").join(", ")})`;
    params.push(...kinds);
  }

  // 半開區間 [start, end)：end 為次日 00:00 ISO；cast timestamptz 避免 TIMESTAMP 無時區誤切
  if (start_date) {
    where += " AND oe.occurred_at >= ?::timestamptz";
    params.push(start_date);
  }
  if (end_date) {
    where += " AND oe.occurred_at < ?::timestamptz";
    params.push(end_date);
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

    // 一律寫入 ISO（與門禁／人流一致），避免 TIMESTAMP + CURRENT_TIMESTAMP 在時區下被「今天」篩掉
    const occurredAt =
      input.occurred_at != null && String(input.occurred_at).trim() !== ""
        ? String(input.occurred_at)
        : new Date().toISOString();

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
        summary, actor_user_id,
        ref_table, ref_id, payload
      ) VALUES (
        ?::timestamptz, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?::jsonb
      )
      RETURNING id, occurred_at
      `,
      [
        occurredAt,
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
        input.ref_table != null ? String(input.ref_table) : null,
        toIntOrNull(input.ref_id),
        payload,
      ],
    );
    const row = rows?.[0];
    const id = row?.id ?? null;
    if (id != null) {
      websocketService.emitOperationalEventNew({
        id,
        source,
        event_kind: eventKind,
        summary,
        occurred_at:
          row.occurred_at != null
            ? new Date(row.occurred_at).toISOString()
            : new Date().toISOString(),
      });
    }
    return id;
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
      `SELECT COUNT(*)::int AS total FROM operational_events oe ${where}`,
      params,
    ),
    db.query(
      `
      SELECT
        oe.id, oe.occurred_at, oe.source, oe.event_kind,
        oe.location_id, oe.system_id, oe.device_id,
        oe.bit_key, oe.address, oe.old_value, oe.new_value,
        oe.summary, oe.actor_user_id,
        oe.ref_table, oe.ref_id, oe.payload, oe.created_at,
        d.name AS device_name,
        l.name AS location_name,
        z.name AS zone_name,
        u.username AS actor_username
      FROM operational_events oe
      LEFT JOIN devices d ON oe.device_id = d.id
      LEFT JOIN locations l ON oe.location_id = l.id
      LEFT JOIN zones z ON l.zone_id = z.id
      LEFT JOIN users u ON oe.actor_user_id = u.id
      ${where}
      ORDER BY oe.occurred_at DESC, oe.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, lim, off],
    ),
    db.query(
      `
      SELECT oe.event_kind, COUNT(*)::int AS count
      FROM operational_events oe
      ${where}
      GROUP BY oe.event_kind
      ORDER BY oe.event_kind
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

/**
 * @deprecated 營運事件改由備份雙層保留冷刪（BACKUP_ONLINE_RETENTION_DAYS）。
 * 保留函式供手動／相容呼叫；日常排程已停用。
 */
async function purgeExpiredEvents(retentionDays) {
  const days =
    toIntOrNull(retentionDays) ?? config.operationalEvents?.retentionDays ?? 90;
  const safeDays = Math.max(days, 1);
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const result = await db.query(
    `DELETE FROM operational_events WHERE occurred_at < ?`,
    [cutoff.toISOString()],
  );
  const deleted = result?.rowCount ?? 0;
  if (deleted > 0) {
    opLogger.info("營運事件過期清理完成（deprecated 直刪）", {
      deleted,
      retentionDays: safeDays,
    });
  }
  return { deleted, retentionDays: safeDays };
}

module.exports = {
  recordEvent,
  listEvents,
  purgeExpiredEvents,
};
