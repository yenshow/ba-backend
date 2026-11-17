/**
 * 基礎設施 DO 時間排程工廠（照明／空調等）
 * 時刻觸發 on／off；一規則可綁多地點
 */
const db = require("../../database/db");
const modbusClient = require("../devices/modbusClient");
const modbusBatchService = require("../devices/modbusBatchService");
const { resolveDiDoParts } = require("../devices/modbusDiDoConfig");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const loggerFactory = require("../../utils/logger");
const {
  recordControlWriteEvent,
  markCoilControlWrite,
} = require("../operationalEvents/operationalEventHooks");

const FIRED_TTL_MS = 48 * 60 * 60 * 1000;

const getDeviceService = () => require("../devices/deviceService");

/** @param {Date|string|number} [at] */
function toTaipeiParts(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const yyyy = String(parts.year);
  const mo = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return {
    dow: weekdayMap[parts.weekday] ?? 0,
    hm: `${hh}:${mm}`,
    dateKey: `${yyyy}-${mo}-${dd}`,
  };
}

/** TIME／字串／Date（pg 偶發）→ 當日秒數 */
function timeToSeconds(t) {
  if (t instanceof Date && !Number.isNaN(t.getTime())) {
    return (
      t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds()
    );
  }
  const s = String(t || "").trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
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

function timeSlice(t) {
  const sec = timeToSeconds(t);
  if (sec == null) return String(t || "").slice(0, 8);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function timeMatchesHm(timeStr, hm) {
  const sec = timeToSeconds(timeStr);
  if (sec == null) return false;
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` === hm;
}

/**
 * @param {{
 *   systemType: string,
 *   rulesTable: string,
 *   locationsTable: string,
 *   eventSource: string,
 *   label: string,
 *   loggerName: string,
 * }} opts
 */
const ALLOWED_TABLES = new Set([
  "lighting_schedule_rules",
  "lighting_schedule_rule_locations",
  "hvac_schedule_rules",
  "hvac_schedule_rule_locations",
]);

function createDoScheduleService(opts) {
  const {
    systemType,
    rulesTable,
    locationsTable,
    eventSource,
    label,
    loggerName,
  } = opts;
  if (!ALLOWED_TABLES.has(rulesTable) || !ALLOWED_TABLES.has(locationsTable)) {
    throw new Error(`createDoScheduleService: 非法表名 ${rulesTable}/${locationsTable}`);
  }
  const logger = loggerFactory.createLogger(loggerName);
  /** @type {Map<string, number>} */
  const firedEdges = new Map();
  const deviceCfgCache = new Map();
  const DEVICE_CFG_TTL_MS = 60_000;

  function mapRuleRow(row, locationIds = []) {
    return {
      id: row.id,
      name: row.name || "",
      daysOfWeek: Array.isArray(row.days_of_week)
        ? row.days_of_week.map(Number)
        : normalizeDays(row.days_of_week),
      onTime: timeSlice(row.on_time),
      offTime: timeSlice(row.off_time),
      enabled: Boolean(row.enabled),
      locationIds: locationIds.map(Number),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function listAll() {
    const rules = await db.query(
      `SELECT id, name, days_of_week, on_time, off_time, enabled, created_at, updated_at
       FROM ${rulesTable}
       ORDER BY id ASC`,
    );
    if (!rules?.length) return [];

    const locs = await db.query(
      `SELECT rule_id, location_id
       FROM ${locationsTable}
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

  async function assertSystemLocationIds(locationIds, query = db.query) {
    const ids = normalizeLocationIds(locationIds);
    if (ids.length === 0) {
      throwApiError(C.VALIDATION_REQUIRED, `規則須至少綁定一個${label}地點`);
    }
    const rows = await query(
      `SELECT DISTINCT location_id
       FROM location_systems
       WHERE system_type = ? AND location_id = ANY(?)`,
      [systemType, ids],
    );
    const ok = new Set((rows || []).map((r) => Number(r.location_id)));
    const missing = ids.filter((id) => !ok.has(id));
    if (missing.length > 0) {
      throwApiError(
        C.VALIDATION_REQUIRED,
        `地點非${label}系統或不存在：${missing.join(", ")}`,
      );
    }
    return ids;
  }

  async function replaceAll(rules) {
    const list = Array.isArray(rules) ? rules : [];
    for (const r of list) {
      if (!r?.onTime || !r?.offTime) {
        throwApiError(C.VALIDATION_REQUIRED, "規則必須有 onTime／offTime");
      }
      if (timeToSeconds(r.onTime) === timeToSeconds(r.offTime)) {
        throwApiError(C.VALIDATION_REQUIRED, "開啟與關閉時刻不可相同");
      }
      if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length === 0) {
        throwApiError(C.VALIDATION_REQUIRED, "規則須至少選擇一天");
      }
      if (normalizeLocationIds(r.locationIds).length === 0) {
        throwApiError(C.VALIDATION_REQUIRED, `規則須至少綁定一個${label}地點`);
      }
    }

    await db.transaction(async (query) => {
      for (const r of list) {
        await assertSystemLocationIds(r.locationIds, query);
      }
      await query(`DELETE FROM ${rulesTable}`);
      for (const r of list) {
        const locationIds = normalizeLocationIds(r.locationIds);
        const inserted = await query(
          `INSERT INTO ${rulesTable}
            (name, days_of_week, on_time, off_time, enabled)
           VALUES (?, ?::int[], ?::time, ?::time, ?)
           RETURNING id`,
          [
            r.name != null ? String(r.name).slice(0, 80) : null,
            normalizeDays(r.daysOfWeek),
            String(r.onTime),
            String(r.offTime),
            r.enabled !== false,
          ],
        );
        const ruleId = inserted?.[0]?.id;
        if (!ruleId) continue;
        for (const lid of locationIds) {
          await query(
            `INSERT INTO ${locationsTable} (rule_id, location_id)
             VALUES (?, ?)`,
            [ruleId, lid],
          );
        }
      }
    });
    return listAll();
  }

  async function resolveDeviceEndpoint(deviceId) {
    if (!deviceId) return null;
    const id = Number(deviceId);
    const cached = deviceCfgCache.get(id);
    if (cached && Date.now() - cached.ts < DEVICE_CFG_TTL_MS) return cached.cfg;

    const { device } = await getDeviceService().getDeviceById(id);
    const c = device?.config || {};
    if (!c.host || c.port == null) return null;
    const cfg = {
      host: String(c.host).trim(),
      port: Number(c.port),
      unitId: Number(c.unitId ?? 1),
    };
    deviceCfgCache.set(id, { ts: Date.now(), cfg });
    return cfg;
  }

  async function resolveDoTarget(locationId) {
    const lid = Number(locationId);
    const rows = await db.query(
      `
      SELECT
        (ls.system_config->'device_ids'->>0)::int AS device_id,
        ls.system_config->'modbus_config' AS modbus_config
      FROM location_systems ls
      WHERE ls.system_type = ?
        AND ls.location_id = ?
        AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0
        AND (ls.system_config->'device_ids'->>0) ~ '^[0-9]+$'
      ORDER BY ls.id ASC
      LIMIT 1
      `,
      [systemType, lid],
    );
    const row = rows?.[0];
    if (!row) return null;

    const modbusConfigRaw =
      typeof row.modbus_config === "string"
        ? JSON.parse(row.modbus_config)
        : row.modbus_config;
    const { do: doPart } = resolveDiDoParts(modbusConfigRaw);
    if (!doPart || !Number.isFinite(Number(doPart.address))) return null;

    const deviceId = Number(row.device_id);
    if (!Number.isFinite(deviceId) || deviceId <= 0) return null;

    return { deviceId, doAddress: Number(doPart.address) };
  }

  async function writeScheduleDo({ locationId, value, ruleId, edge }) {
    const target = await resolveDoTarget(locationId);
    if (!target) {
      logger.warn(`${label}排程略過：地點無 DO 或未綁定`, {
        locationId,
        ruleId,
        edge,
      });
      return { success: false, skipped: true, reason: "no_do" };
    }

    const cfg = await resolveDeviceEndpoint(target.deviceId);
    if (!cfg) {
      logger.warn(`${label}排程略過：設備連線設定不足`, {
        locationId,
        deviceId: target.deviceId,
        ruleId,
        edge,
      });
      return { success: false, skipped: true, reason: "no_device_cfg" };
    }

    try {
      const ok = await modbusClient.writeCoil(
        Number(target.doAddress),
        Boolean(value),
        cfg,
      );
      if (!ok) {
        logger.warn(`${label}排程 writeCoil 回傳失敗`, {
          locationId,
          deviceId: target.deviceId,
          address: target.doAddress,
          ruleId,
          edge,
        });
        return { success: false };
      }

      modbusBatchService.invalidateDeviceCache(cfg, "coil");
      markCoilControlWrite(cfg, target.doAddress);
      void recordControlWriteEvent({
        deviceConfig: cfg,
        source: eventSource,
        deviceId: target.deviceId,
        address: target.doAddress,
        value: Boolean(value),
        payloadExtra: {
          fromDoSchedule: true,
          systemType,
          ruleId,
          edge,
          locationId: Number(locationId),
        },
      });
      return { success: true };
    } catch (err) {
      logger.warn(`${label}排程寫入 DO 失敗`, {
        locationId,
        ruleId,
        edge,
        error: err?.message || String(err),
      });
      return { success: false, error: err?.message || String(err) };
    }
  }

  function pruneFiredEdges(now = Date.now()) {
    for (const [key, ts] of firedEdges) {
      if (now - ts > FIRED_TTL_MS) firedEdges.delete(key);
    }
  }

  async function reconcileDueEdges(at = new Date()) {
    pruneFiredEdges();
    const { dow, hm, dateKey } = toTaipeiParts(at);

    const rules = await db.query(
      `SELECT id, days_of_week, on_time, off_time
       FROM ${rulesTable}
       WHERE enabled = TRUE`,
    );
    if (!rules?.length) return { fired: 0 };

    /** @type {Array<{id:number,edges:Array<'on'|'off'>}>} */
    const due = [];
    for (const rule of rules) {
      const days = Array.isArray(rule.days_of_week)
        ? rule.days_of_week.map(Number)
        : normalizeDays(rule.days_of_week);
      if (!days.includes(dow)) continue;

      /** @type {Array<'on'|'off'>} */
      const edges = [];
      if (timeMatchesHm(rule.on_time, hm)) edges.push("on");
      if (timeMatchesHm(rule.off_time, hm)) edges.push("off");
      const pending = edges.filter(
        (edge) => !firedEdges.has(`${rule.id}:${edge}:${dateKey}:${hm}`),
      );
      if (pending.length === 0) continue;
      due.push({ id: Number(rule.id), edges: pending });
    }
    if (due.length === 0) return { fired: 0 };

    const locRows = await db.query(
      `SELECT rule_id, location_id
       FROM ${locationsTable}
       WHERE rule_id = ANY(?)`,
      [due.map((d) => d.id)],
    );
    /** @type {Map<number, number[]>} */
    const locsByRule = new Map();
    for (const row of locRows || []) {
      const rid = Number(row.rule_id);
      if (!locsByRule.has(rid)) locsByRule.set(rid, []);
      locsByRule.get(rid).push(Number(row.location_id));
    }

    let fired = 0;
    for (const item of due) {
      const locationIds = locsByRule.get(item.id) || [];
      if (locationIds.length === 0) continue;

      for (const edge of item.edges) {
        const fireKey = `${item.id}:${edge}:${dateKey}:${hm}`;
        if (firedEdges.has(fireKey)) continue;

        const results = await Promise.all(
          locationIds.map((locationId) =>
            writeScheduleDo({
              locationId,
              value: edge === "on",
              ruleId: item.id,
              edge,
            }),
          ),
        );
        // 全部失敗不標記：同分鐘內可重試（避免 60s tick 錯過或短暫離線）
        const anyOk = results.some((r) => r?.success);
        if (!anyOk) {
          logger.warn(`${label}排程邊緣寫入皆失敗（將重試）`, {
            ruleId: item.id,
            edge,
            hm,
            locationCount: locationIds.length,
          });
          continue;
        }
        firedEdges.set(fireKey, Date.now());
        fired += 1;
        logger.info(`${label}排程邊緣已觸發`, {
          ruleId: item.id,
          edge,
          hm,
          locationCount: locationIds.length,
          successCount: results.filter((r) => r?.success).length,
        });
      }
    }
    return { fired };
  }

  return { listAll, replaceAll, reconcileDueEdges };
}

module.exports = { createDoScheduleService };
