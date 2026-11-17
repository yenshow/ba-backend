/**
 * 保全時間排程：CRUD 與 isPermittedNow（排程內活動不升級為警報）
 * 無啟用規則＝不依時段告警（視為許可）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const DOW_SUNDAY = 0;

/** @param {Date|string|number} [at] */
function toTaipeiParts(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = weekdayMap[parts.weekday] ?? DOW_SUNDAY;
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const ss = String(parts.second || "00").padStart(2, "0");
  return { dow, time: `${hh}:${mm}:${ss}` };
}

/** TIME / HH:MM(:SS) → 秒 */
function timeToSeconds(t) {
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

/**
 * 判斷 time 是否落在 [start, end)（允許跨日）
 */
function isTimeInWindow(timeStr, startStr, endStr) {
  const t = timeToSeconds(timeStr);
  const a = timeToSeconds(startStr);
  const b = timeToSeconds(endStr);
  if (t == null || a == null || b == null) return false;
  if (a === b) return false;
  if (a < b) return t >= a && t < b;
  return t >= a || t < b;
}

function normalizeDays(days) {
  if (!Array.isArray(days) || days.length === 0) {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  return [...new Set(days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))];
}

async function listByLocationId(locationId) {
  const rows = await db.query(
    `SELECT id, location_id, name, days_of_week, window_start, window_end, enabled, created_at, updated_at
     FROM security_schedule_rules
     WHERE location_id = ?
     ORDER BY id ASC`,
    [Number(locationId)],
  );
  return (rows || []).map(mapRow);
}

function mapRow(row) {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name || "",
    daysOfWeek: Array.isArray(row.days_of_week)
      ? row.days_of_week.map(Number)
      : normalizeDays(row.days_of_week),
    windowStart: String(row.window_start).slice(0, 8),
    windowEnd: String(row.window_end).slice(0, 8),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 全量取代該地點時段
 * @param {number} locationId
 * @param {Array<{name?:string,daysOfWeek?:number[],windowStart:string,windowEnd:string,enabled?:boolean}>} rules
 */
async function replaceForLocation(locationId, rules) {
  const lid = Number(locationId);
  if (!Number.isFinite(lid) || lid <= 0) {
    throwApiError(C.VALIDATION_REQUIRED, "locationId 無效");
  }
  const list = Array.isArray(rules) ? rules : [];
  for (const r of list) {
    if (!r?.windowStart || !r?.windowEnd) {
      throwApiError(C.VALIDATION_REQUIRED, "時段必須有 windowStart／windowEnd");
    }
    if (timeToSeconds(r.windowStart) === timeToSeconds(r.windowEnd)) {
      throwApiError(C.VALIDATION_REQUIRED, "時段起迄不可相同");
    }
    if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length === 0) {
      throwApiError(C.VALIDATION_REQUIRED, "時段須至少選擇一天");
    }
  }

  await db.transaction(async (query) => {
    await query(`DELETE FROM security_schedule_rules WHERE location_id = ?`, [
      lid,
    ]);
    for (const r of list) {
      await query(
        `INSERT INTO security_schedule_rules
          (location_id, name, days_of_week, window_start, window_end, enabled)
         VALUES (?, ?, ?::int[], ?::time, ?::time, ?)`,
        [
          lid,
          r.name != null ? String(r.name).slice(0, 80) : null,
          normalizeDays(r.daysOfWeek),
          String(r.windowStart),
          String(r.windowEnd),
          r.enabled !== false,
        ],
      );
    }
  });
  return listByLocationId(lid);
}

/**
 * 時間排程內＝true（不告警，UI 活動態）；無啟用規則＝true（不依時段告警）
 */
async function isPermittedNow(locationId, at = new Date()) {
  const lid = Number(locationId);
  if (!Number.isFinite(lid) || lid <= 0) return true;
  const rows = await db.query(
    `SELECT days_of_week, window_start, window_end
     FROM security_schedule_rules
     WHERE location_id = ? AND enabled = TRUE`,
    [lid],
  );
  if (!rows?.length) return true;
  const { dow, time } = toTaipeiParts(at);
  for (const r of rows) {
    const days = Array.isArray(r.days_of_week)
      ? r.days_of_week.map(Number)
      : normalizeDays(r.days_of_week);
    if (!days.includes(dow)) continue;
    if (isTimeInWindow(time, r.window_start, r.window_end)) return true;
  }
  return false;
}

async function resolveLocationIdBySystemId(systemId) {
  const rows = await db.query(
    `SELECT location_id FROM location_systems WHERE id = ? AND system_type = 'security'`,
    [Number(systemId)],
  );
  return rows?.[0]?.location_id != null ? Number(rows[0].location_id) : null;
}

async function isPermittedNowBySystemId(systemId, at = new Date()) {
  const locationId = await resolveLocationIdBySystemId(systemId);
  if (locationId == null) return true;
  return isPermittedNow(locationId, at);
}

/**
 * 依門禁設備反查保全地點（access_device_ids 含此 device）
 */
async function listSecurityLocationsByAccessDeviceId(deviceId) {
  const did = Number(deviceId);
  if (!Number.isFinite(did) || did <= 0) return [];
  const rows = await db.query(
    `SELECT ls.id AS system_id, ls.location_id, l.name AS location_name
     FROM location_systems ls
     INNER JOIN locations l ON l.id = ls.location_id
     WHERE ls.system_type = 'security'
       AND ls.system_config->'access_device_ids' IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(
           COALESCE(ls.system_config->'access_device_ids', '[]'::jsonb)
         ) AS x(val)
         WHERE x.val::int = ?
       )`,
    [did],
  );
  return (rows || []).map((r) => ({
    systemId: Number(r.system_id),
    locationId: Number(r.location_id),
    locationName: r.location_name,
  }));
}

module.exports = {
  listByLocationId,
  replaceForLocation,
  isPermittedNow,
  isPermittedNowBySystemId,
  listSecurityLocationsByAccessDeviceId,
  isTimeInWindow,
  toTaipeiParts,
};
