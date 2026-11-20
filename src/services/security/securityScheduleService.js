/**
 * 保全時間排程：規則→綁多地點；isPermittedNow（排程內活動不升級為警報）
 * 無綁定啟用規則＝不依時段告警（視為許可）；24 小時防區由閘門略過本函式語意
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const DOW_SUNDAY = 0;

const ARMING_MODES = new Set(["immediate", "delay", "twenty_four_hour"]);
const DEFAULT_ENTRY_DELAY_SEC = 30;
const DEFAULT_EXIT_DELAY_SEC = 60;

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
  if (t instanceof Date && !Number.isNaN(t.getTime())) {
    return (
      t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds()
    );
  }
  const s = String(t || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

function timeSlice(t) {
  const sec = timeToSeconds(t);
  if (sec == null) return String(t || "").slice(0, 8);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
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
  return [
    ...new Set(days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6)),
  ];
}

function normalizeLocationIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [
    ...new Set(
      ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 正規化地點佈防設定（API camelCase 或 DB snake_case）
 * @param {Record<string, unknown>|null|undefined} config
 */
function normalizeArmingConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const rawMode = String(
    c.armingMode ?? c.arming_mode ?? "immediate",
  ).trim();
  const armingMode = ARMING_MODES.has(rawMode) ? rawMode : "immediate";
  return {
    armingMode,
    entryDelaySec: clampInt(
      c.entryDelaySec ?? c.entry_delay_sec,
      0,
      300,
      DEFAULT_ENTRY_DELAY_SEC,
    ),
    exitDelaySec: clampInt(
      c.exitDelaySec ?? c.exit_delay_sec,
      0,
      600,
      DEFAULT_EXIT_DELAY_SEC,
    ),
  };
}

function mapRuleRow(row, locationIds = []) {
  return {
    id: row.id,
    name: row.name || "",
    daysOfWeek: Array.isArray(row.days_of_week)
      ? row.days_of_week.map(Number)
      : normalizeDays(row.days_of_week),
    windowStart: timeSlice(row.window_start),
    windowEnd: timeSlice(row.window_end),
    enabled: Boolean(row.enabled),
    locationIds: locationIds.map(Number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listAll() {
  const rules = await db.query(
    `SELECT id, name, days_of_week, window_start, window_end, enabled, created_at, updated_at
     FROM security_schedule_rules
     ORDER BY id ASC`,
  );
  if (!rules?.length) return [];

  const locs = await db.query(
    `SELECT rule_id, location_id
     FROM security_schedule_rule_locations
     WHERE rule_id = ANY(?)
     ORDER BY rule_id ASC, location_id ASC`,
    [rules.map((r) => r.id)],
  );
  const byRule = new Map();
  for (const row of locs || []) {
    const rid = Number(row.rule_id);
    if (!byRule.has(rid)) byRule.set(rid, []);
    byRule.get(rid).push(Number(row.location_id));
  }
  return rules.map((r) => mapRuleRow(r, byRule.get(Number(r.id)) || []));
}

async function assertSecurityLocationIds(locationIds, query = db.query) {
  const ids = normalizeLocationIds(locationIds);
  if (ids.length === 0) {
    throwApiError(C.VALIDATION_REQUIRED, "規則須至少綁定一個保全地點");
  }
  const rows = await query(
    `SELECT DISTINCT location_id
     FROM location_systems
     WHERE system_type = 'security' AND location_id = ANY(?)`,
    [ids],
  );
  const ok = new Set((rows || []).map((r) => Number(r.location_id)));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length > 0) {
    throwApiError(
      C.VALIDATION_REQUIRED,
      `地點非保全系統或不存在：${missing.join(", ")}`,
    );
  }
  return ids;
}

/**
 * 全量取代保全時間排程規則
 * @param {Array<{name?:string,daysOfWeek?:number[],windowStart:string,windowEnd:string,enabled?:boolean,locationIds:number[]}>} rules
 */
async function replaceAll(rules) {
  const list = Array.isArray(rules) ? rules : [];
  for (const r of list) {
    if (!r?.windowStart || !r?.windowEnd) {
      throwApiError(C.VALIDATION_REQUIRED, "規則必須有 windowStart／windowEnd");
    }
    if (timeToSeconds(r.windowStart) === timeToSeconds(r.windowEnd)) {
      throwApiError(C.VALIDATION_REQUIRED, "時段起迄不可相同");
    }
    if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length === 0) {
      throwApiError(C.VALIDATION_REQUIRED, "規則須至少選擇一天");
    }
    if (normalizeLocationIds(r.locationIds).length === 0) {
      throwApiError(C.VALIDATION_REQUIRED, "規則須至少綁定一個保全地點");
    }
  }

  await db.transaction(async (query) => {
    for (const r of list) {
      await assertSecurityLocationIds(r.locationIds, query);
    }
    await query(`DELETE FROM security_schedule_rules`);
    for (const r of list) {
      const locationIds = normalizeLocationIds(r.locationIds);
      const inserted = await query(
        `INSERT INTO security_schedule_rules
          (name, days_of_week, window_start, window_end, enabled)
         VALUES (?, ?::int[], ?::time, ?::time, ?)
         RETURNING id`,
        [
          r.name != null ? String(r.name).slice(0, 80) : null,
          normalizeDays(r.daysOfWeek),
          String(r.windowStart),
          String(r.windowEnd),
          r.enabled !== false,
        ],
      );
      const ruleId = inserted?.[0]?.id;
      if (!ruleId) continue;
      for (const lid of locationIds) {
        await query(
          `INSERT INTO security_schedule_rule_locations (rule_id, location_id)
           VALUES (?, ?)`,
          [ruleId, lid],
        );
      }
    }
  });
  return listAll();
}

/**
 * 時間排程內＝true（不告警，UI 活動態）；無綁定啟用規則＝true（不依時段告警）
 */
async function isPermittedNow(locationId, at = new Date()) {
  const lid = Number(locationId);
  if (!Number.isFinite(lid) || lid <= 0) return true;
  const rows = await db.query(
    `SELECT r.days_of_week, r.window_start, r.window_end
     FROM security_schedule_rules r
     INNER JOIN security_schedule_rule_locations rl ON rl.rule_id = r.id
     WHERE rl.location_id = ? AND r.enabled = TRUE`,
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
 * 讀取保全地點佈防設定（含 systemId／locationId）
 * @returns {Promise<{systemId:number,locationId:number,armingMode:string,entryDelaySec:number,exitDelaySec:number}|null>}
 */
async function getArmingConfigBySystemId(systemId) {
  const sid = Number(systemId);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const rows = await db.query(
    `SELECT id, location_id, system_config
     FROM location_systems
     WHERE id = ? AND system_type = 'security'`,
    [sid],
  );
  const row = rows?.[0];
  if (!row) return null;
  const cfg =
    typeof row.system_config === "string"
      ? JSON.parse(row.system_config)
      : row.system_config || {};
  const arming = normalizeArmingConfig(cfg);
  return {
    systemId: sid,
    locationId: Number(row.location_id),
    ...arming,
  };
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
  listAll,
  replaceAll,
  isPermittedNow,
  isPermittedNowBySystemId,
  getArmingConfigBySystemId,
  listSecurityLocationsByAccessDeviceId,
  normalizeArmingConfig,
  isTimeInWindow,
  toTaipeiParts,
  timeToSeconds,
};
