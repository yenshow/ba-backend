/**
 * 外部整合：共用查詢工具 + 六種 eventType adapter（對接／轉存）
 */
const { DateTime } = require("luxon");
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const logger = require("../../utils/logger").createLogger("eventAdapters");
const {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveVerifyMethodLabel,
  shouldDisplayAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");
const { normalizeEmployeeNo } = require("../peopleCounting/helpers/entryExitStats");
const {
  labelAlertStatus,
  labelAlertSeverity,
  labelAlertType,
  labelSystemSource,
  labelOperationalKind,
  labelVehicleDataSource,
  labelDimensionKey,
} = require("./exportDisplayLabels");

// --- 共用查詢工具 ---

function clampLimit(limit, fallback = 5000) {
  return Math.min(Math.max(Number(limit) || fallback, 1), 50000);
}

function formatTs(value, format) {
  const fmt = String(format ?? "").trim();
  if (!fmt || !value) return "";
  const dt = DateTime.fromJSDate(new Date(value)).setZone("Asia/Taipei");
  return dt.isValid ? dt.toFormat(fmt) : "";
}

/** 日期時間／日期／時間三分欄（與門禁 eventDateTime／eventDate／eventTime 同型） */
function timeSplitFields({
  dateTimeKey,
  dateKey,
  timeKey,
  labelStem,
  required = false,
}) {
  return [
    {
      key: dateTimeKey,
      label: `${labelStem}日期和時間`,
      requiresFormat: true,
      formatKind: "datetime",
      ...(required ? { required: true } : {}),
    },
    {
      key: dateKey,
      label: `${labelStem}日期`,
      requiresFormat: true,
      formatKind: "date",
    },
    {
      key: timeKey,
      label: `${labelStem}時間`,
      requiresFormat: true,
      formatKind: "time",
    },
  ];
}

function isTimeSplitKey(fieldKey, dateTimeKey, dateKey, timeKey) {
  return fieldKey === dateTimeKey || fieldKey === dateKey || fieldKey === timeKey;
}

function toJsonText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function fetchRowsAfterCursor({
  selectSql,
  timeColumn,
  idColumn = "id",
  idResultKey = "id",
  cursorTsText,
  cursorEventId,
  limit,
  extraWhere = "",
  extraParams = [],
}) {
  const lim = clampLimit(limit);
  const endIso = new Date().toISOString();
  const hasCursor = Boolean(cursorTsText && String(cursorTsText).trim());
  const cursorId = Number(cursorEventId);
  const hasEventId = Number.isFinite(cursorId) && cursorId > 0;

  let whereSql;
  let params;
  if (!hasCursor) {
    const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    whereSql = `${timeColumn} > ?::timestamptz AND ${timeColumn} <= ?::timestamptz`;
    params = [start, endIso, ...extraParams, lim];
  } else if (hasEventId) {
    whereSql = `(${timeColumn} > ?::timestamptz OR (${timeColumn} = ?::timestamptz AND ${idColumn} > ?))
      AND ${timeColumn} <= ?::timestamptz`;
    params = [
      String(cursorTsText).trim(),
      String(cursorTsText).trim(),
      cursorId,
      endIso,
      ...extraParams,
      lim,
    ];
  } else {
    whereSql = `${timeColumn} > ?::timestamptz AND ${timeColumn} <= ?::timestamptz`;
    params = [String(cursorTsText).trim(), endIso, ...extraParams, lim];
  }

  if (extraWhere) {
    whereSql = `(${whereSql}) AND (${extraWhere})`;
  }

  const rows = await db.query(
    `${selectSql}
     WHERE ${whereSql}
     ORDER BY ${timeColumn} ASC, ${idColumn} ASC
     LIMIT ?`,
    params,
  );
  const list = rows || [];
  const last = list.length ? list[list.length - 1] : null;
  return {
    rows: list,
    lastFetchedEventId:
      last?.[idResultKey] != null ? Number(last[idResultKey]) : null,
  };
}

async function fetchRowsInWindow({
  selectSql,
  timeColumn,
  idColumn = "id",
  startTime,
  endTime,
  limit,
  extraWhere = "",
  extraParams = [],
}) {
  const lim = clampLimit(limit);
  let whereSql = `${timeColumn} >= ?::timestamptz AND ${timeColumn} < ?::timestamptz`;
  const params = [
    new Date(startTime).toISOString(),
    new Date(endTime).toISOString(),
    ...extraParams,
  ];
  if (extraWhere) {
    whereSql = `(${whereSql}) AND (${extraWhere})`;
  }
  params.push(lim);
  const rows = await db.query(
    `${selectSql}
     WHERE ${whereSql}
     ORDER BY ${timeColumn} ASC, ${idColumn} ASC
     LIMIT ?`,
    params,
  );
  return rows || [];
}

function parseIdList(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
}

function parseStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.map((v) => String(v ?? "").trim()).filter(Boolean),
    ),
  ];
}

/** @param {string[]} allowed @param {string} fallback */
function parseEnumValue(raw, allowed, fallback) {
  const v = String(raw ?? "").trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/** 能源／環境：raw｜hourly（預設 hourly） */
function parseGrain(raw) {
  return parseEnumValue(raw, ["raw", "hourly"], "hourly");
}

/** 門禁：raw｜daily_first_last（預設 raw；相容舊 punchMode） */
function parseAccessGrain(raw) {
  return parseEnumValue(raw, ["raw", "daily_first_last"], "raw");
}

function readAccessGrain(obj) {
  return parseAccessGrain(obj?.grain ?? obj?.punchMode);
}

const GRAIN_FILTER_FIELD = {
  key: "grain",
  type: "string",
  label: "匯出粒度",
  enum: ["raw", "hourly"],
  enumLabels: {
    hourly: "每小時彙總（預設）",
    raw: "原始讀數",
  },
  required: false,
};

const ACCESS_GRAIN_FILTER_FIELD = {
  key: "grain",
  type: "string",
  label: "匯出粒度",
  enum: ["raw", "daily_first_last"],
  enumLabels: {
    raw: "逐筆（全部進出）",
    daily_first_last: "每日最早與最晚（考勤）",
  },
  required: false,
};

/**
 * 寫入 options_json.grain（依 adapter filterSchema）；清除舊 punchMode
 * @returns {object}
 */
function normalizeOptionsGrain(adapter, optionsJson) {
  const out = { ...(optionsJson || {}) };
  const grainField = adapter?.filterSchema?.fields?.find((f) => f.key === "grain");
  if (!grainField) {
    delete out.grain;
    delete out.punchMode;
    return out;
  }
  const allowed = Array.isArray(grainField.enum) ? grainField.enum : [];
  const fallback = allowed.includes("hourly")
    ? "hourly"
    : allowed[0] || "raw";
  out.grain = parseEnumValue(out.grain ?? out.punchMode, allowed, fallback);
  delete out.punchMode;
  return out;
}

function taipeiDateKey(ts) {
  if (!ts) return "";
  const dt = DateTime.fromJSDate(new Date(ts)).setZone("Asia/Taipei");
  return dt.isValid ? dt.toFormat("yyyy-MM-dd") : "";
}

function eventSortKey(evt) {
  const t = new Date(evt?.timestamp).getTime();
  const time = Number.isFinite(t) ? t : 0;
  const id = Number(evt?.id);
  return { time, id: Number.isFinite(id) ? id : 0 };
}

function cmpEventSort(a, b) {
  const ka = eventSortKey(a);
  const kb = eventSortKey(b);
  if (ka.time !== kb.time) return ka.time - kb.time;
  return ka.id - kb.id;
}

/** 每人（工號）每日：最早一筆 + 最晚一筆（僅一筆則不重複） */
function reduceDailyFirstLast(events) {
  const groups = new Map();
  for (const evt of events || []) {
    const emp = String(evt?.employeeId ?? "").trim();
    if (!emp) continue;
    const day = taipeiDateKey(evt.timestamp);
    if (!day) continue;
    const key = `${emp}\0${day}`;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, { first: evt, last: evt });
      continue;
    }
    if (cmpEventSort(evt, cur.first) < 0) cur.first = evt;
    if (cmpEventSort(evt, cur.last) > 0) cur.last = evt;
  }

  const out = [];
  for (const { first, last } of groups.values()) {
    out.push(first);
    if (first !== last) out.push(last);
  }
  out.sort(cmpEventSort);
  return out;
}

/**
 * 對接考勤彙整：批次觸及 limit 時末日本可能不完整，先扣住不輸出，游標停在完整日末。
 * 整批同日則仍輸出並推進游標（避免卡住）。
 */
function reduceDailyFirstLastForSync(rawEvents, fetchLimit) {
  const raw = rawEvents || [];
  const lim = clampLimit(fetchLimit);
  const reduced = reduceDailyFirstLast(raw);
  if (!raw.length) {
    return { events: [], cursorEvent: null };
  }

  const hitLimit = raw.length >= lim;
  if (!hitLimit) {
    return { events: reduced, cursorEvent: raw[raw.length - 1] };
  }

  const lastDay = taipeiDateKey(raw[raw.length - 1]?.timestamp);
  if (!lastDay) {
    return { events: reduced, cursorEvent: raw[raw.length - 1] };
  }

  const completeEvents = reduced.filter(
    (e) => taipeiDateKey(e.timestamp) && taipeiDateKey(e.timestamp) < lastDay,
  );
  if (completeEvents.length > 0) {
    const cursorPool = raw.filter((e) => taipeiDateKey(e.timestamp) < lastDay);
    return {
      events: completeEvents,
      cursorEvent: cursorPool[cursorPool.length - 1] ?? null,
    };
  }

  return { events: reduced, cursorEvent: raw[raw.length - 1] };
}

// --- 門禁（access_control）---

const ACCESS_CONTROL_FIELD_CATALOG = [
  { key: "employeeId", label: "員工/人員 ID", required: true },
  { key: "personName", label: "姓名" },
  { key: "personGroup", label: "人員群組" },
  { key: "deviceId", label: "出入口 ID" },
  { key: "deviceName", label: "出入口名稱" },
  { key: "deviceScreenshot", label: "設備截圖" },
  {
    key: "eventDateTime",
    label: "進出日期和時間",
    requiresFormat: true,
    formatKind: "datetime",
  },
  { key: "eventDate", label: "進出日期", requiresFormat: true, formatKind: "date" },
  { key: "eventTime", label: "進出時間", requiresFormat: true, formatKind: "time" },
  { key: "cardNo", label: "卡號" },
  { key: "direction", label: "進出方向" },
  { key: "verifyMethod", label: "驗證方式" },
];

const DIRECTION_LABEL = {
  entry: "進入",
  exit: "離開",
  failed: "失敗",
};

const getAccessControlFieldByKey = (key) =>
  ACCESS_CONTROL_FIELD_CATALOG.find((f) => f.key === key) ?? null;

function formatDirectionLabel(eventType) {
  if (eventType == null || eventType === "") return "";
  return DIRECTION_LABEL[eventType] || String(eventType);
}

function mapAccessControlEventToFieldValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "employeeId") return evt.employeeId ?? "";
  if (fieldKey === "personName") return evt.personName ?? "";
  if (fieldKey === "personGroup") return evt.unitName ?? "";
  if (fieldKey === "deviceId") {
    return evt.deviceId != null && evt.deviceId !== "" ? String(evt.deviceId) : "";
  }
  if (fieldKey === "deviceName") return evt.deviceName ?? "";
  if (fieldKey === "deviceScreenshot") return evt.deviceScreenshotUrl ?? "";
  if (fieldKey === "cardNo") return evt.cardNo ?? "";
  if (fieldKey === "direction") return formatDirectionLabel(evt.eventType);
  if (fieldKey === "verifyMethod") return evt.verifyMethod ?? "";

  const dt = evt.timestamp
    ? DateTime.fromJSDate(new Date(evt.timestamp)).setZone("Asia/Taipei")
    : null;

  if (fieldKey === "eventDateTime" || fieldKey === "eventDate" || fieldKey === "eventTime") {
    const fmt = String(fieldConfig?.format ?? "").trim();
    return dt && fmt ? dt.toFormat(fmt) : "";
  }

  return "";
}

const AC_DEVICE_CACHE_MS = 60_000;
let acDeviceContextCache = null;
let acDeviceContextCachedAt = 0;

function normalizeDeviceHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?([^:/]+)/);
  return match ? match[1] : trimmed;
}

function collectDeviceIdsFromConfig(config) {
  const entry = [];
  const exit = [];
  const raw = config && typeof config === "object" ? config : {};
  for (const id of raw.entry_device_ids || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) entry.push(n);
  }
  for (const id of raw.exit_device_ids || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) exit.push(n);
  }
  return { entry, exit };
}

function collectCameraIdsFromConfig(config) {
  const entry = [];
  const exit = [];
  const raw = config && typeof config === "object" ? config : {};
  for (const id of raw.entry_camera_device_ids || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) entry.push(n);
  }
  for (const id of raw.exit_camera_device_ids || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) exit.push(n);
  }
  return { entry, exit };
}

async function loadAccessControlDeviceContext() {
  if (acDeviceContextCache && Date.now() - acDeviceContextCachedAt < AC_DEVICE_CACHE_MS) {
    return acDeviceContextCache;
  }

  const entryIps = new Set();
  const exitIps = new Set();
  const entryCameraIds = new Set();
  const exitCameraIds = new Set();
  const ipToDeviceName = new Map();
  const ipToDeviceId = new Map();
  const deviceIdToName = new Map();

  const rows = await db.query(
    `SELECT system_config FROM location_systems WHERE system_type = 'people_counting'`,
    [],
  );

  const allEntryIds = new Set();
  const allExitIds = new Set();
  for (const row of rows || []) {
    const { entry, exit } = collectDeviceIdsFromConfig(row.system_config);
    for (const id of entry) allEntryIds.add(id);
    for (const id of exit) allExitIds.add(id);
    const cams = collectCameraIdsFromConfig(row.system_config);
    for (const id of cams.entry) entryCameraIds.add(id);
    for (const id of cams.exit) exitCameraIds.add(id);
  }

  const addDevice = async (deviceId, role) => {
    try {
      const { device } = await deviceService.getDeviceById(deviceId);
      const ip = normalizeDeviceHost(device?.config?.host);
      const name = device?.name || ip || String(deviceId);
      deviceIdToName.set(deviceId, name);
      if (ip) {
        ipToDeviceName.set(ip, name);
        ipToDeviceId.set(ip, deviceId);
        if (role === "entry") entryIps.add(ip);
        else if (role === "exit") exitIps.add(ip);
      }
    } catch (err) {
      logger.warn("取得門禁／攝影機設備失敗，略過", {
        deviceId,
        error: err?.message || String(err),
      });
    }
  };

  for (const id of allEntryIds) await addDevice(id, "entry");
  for (const id of allExitIds) {
    if (!allEntryIds.has(id)) await addDevice(id, "exit");
  }
  for (const id of entryCameraIds) await addDevice(id, "entry");
  for (const id of exitCameraIds) {
    if (!entryCameraIds.has(id)) await addDevice(id, "exit");
  }

  acDeviceContextCache = {
    entryIps,
    exitIps,
    entryCameraIds,
    exitCameraIds,
    ipToDeviceName,
    ipToDeviceId,
    deviceIdToName,
  };
  acDeviceContextCachedAt = Date.now();
  return acDeviceContextCache;
}

const ACCESS_CONTROL_EVENT_SELECT = `
  SELECT
    e.id,
    e.device_ip,
    e.event_time,
    e.payload,
    e.picture_path,
    p.id AS person_id,
    p.employee_no,
    p.full_name,
    pg.name AS unit_name,
    plc.ladder_card_no
  FROM isapi_access_events e
  LEFT JOIN persons p
    ON p.employee_no = COALESCE((e.payload->>'employeeNoString'), (e.payload->>'employeeNo'))
  LEFT JOIN person_groups pg ON p.person_group_id = pg.id
  LEFT JOIN LATERAL (
    SELECT card_no AS ladder_card_no
    FROM person_ladder_cards
    WHERE person_id = p.id
    ORDER BY id ASC
    LIMIT 1
  ) plc ON TRUE
`;

const FACE_CONTRAST_EVENT_SELECT = `
  SELECT
    e.id,
    e.device_id,
    e.device_ip,
    e.event_time,
    e.payload,
    e.picture_path,
    e.employee_no AS event_employee_no,
    e.person_name AS event_person_name,
    e.matched,
    p.id AS person_id,
    p.employee_no,
    p.full_name,
    pg.name AS unit_name,
    d.name AS device_name
  FROM isapi_face_contrast_events e
  LEFT JOIN persons p
    ON p.employee_no IS NOT NULL
   AND e.employee_no IS NOT NULL
   AND TRIM(p.employee_no) = TRIM(e.employee_no)
  LEFT JOIN person_groups pg ON p.person_group_id = pg.id
  LEFT JOIN devices d ON d.id = e.device_id
`;

function buildAccessControlEventDto(row, ctx) {
  const payload =
    row.payload != null && typeof row.payload === "object" ? row.payload : {};
  const employeeId = normalizeEmployeeNo(
    row.employee_no || payload.employeeNoString || payload.employeeNo || "",
  );
  const personNameRaw = (row.full_name ?? payload.personName ?? "").toString().trim();
  const devicePersonName =
    payload.personName != null ? String(payload.personName).trim() : "";
  const personName = personNameRaw || devicePersonName || "—";

  const sub = extractSubEventType(payload);
  const { eventType } = resolveAccessControlEvent(
    sub,
    ctx.entryIps,
    ctx.exitIps,
    row.device_ip,
  );
  const verifyMethod = resolveVerifyMethodLabel(payload) ?? "";
  const cardFromPayload = payload.cardNo != null ? String(payload.cardNo).trim() : "";
  const cardFromLadder =
    row.ladder_card_no != null ? String(row.ladder_card_no).trim() : "";
  const cardNo = cardFromLadder || cardFromPayload;

  const deviceIp = row.device_ip != null ? String(row.device_ip) : "";
  const deviceName = ctx.ipToDeviceName.get(deviceIp) || deviceIp;
  const mappedDeviceId = ctx.ipToDeviceId?.get(deviceIp);

  return {
    id: row.id,
    sourceKind: "door",
    employeeId: employeeId || null,
    personName,
    unitName: row.unit_name != null ? String(row.unit_name).trim() : "",
    timestamp: row.event_time,
    eventType,
    verifyMethod,
    cardNo,
    deviceId: mappedDeviceId != null ? mappedDeviceId : null,
    deviceName,
    deviceScreenshotUrl: shouldDisplayAccessEventPicture(
      payload,
      row.picture_path,
    )
      ? String(row.picture_path)
      : "",
  };
}

function resolveFaceDirection(row, ctx) {
  const payload =
    row.payload != null && typeof row.payload === "object" ? row.payload : {};
  if (payload.direction === "entry" || payload.direction === "exit") {
    return payload.direction;
  }
  const deviceId = Number(row.device_id);
  if (Number.isFinite(deviceId) && deviceId > 0) {
    if (ctx.entryCameraIds?.has(deviceId)) return "entry";
    if (ctx.exitCameraIds?.has(deviceId)) return "exit";
  }
  const ip = row.device_ip != null ? String(row.device_ip) : "";
  if (ip && ctx.entryIps?.has(ip)) return "entry";
  if (ip && ctx.exitIps?.has(ip)) return "exit";
  return row.matched === false ? "failed" : "entry";
}

function buildFaceContrastEventDto(row, ctx) {
  const employeeId = normalizeEmployeeNo(
    row.employee_no || row.event_employee_no || "",
  );
  const personName =
    (row.full_name != null && String(row.full_name).trim()) ||
    (row.event_person_name != null && String(row.event_person_name).trim()) ||
    "—";
  const deviceId = Number(row.device_id);
  const deviceName =
    (row.device_name != null && String(row.device_name).trim()) ||
    (Number.isFinite(deviceId) ? ctx.deviceIdToName?.get(deviceId) : "") ||
    (row.device_ip != null ? String(row.device_ip) : "") ||
    "";

  return {
    id: row.id,
    sourceKind: "face",
    employeeId: employeeId || null,
    personName,
    unitName: row.unit_name != null ? String(row.unit_name).trim() : "",
    timestamp: row.event_time,
    eventType: resolveFaceDirection(row, ctx),
    verifyMethod: "人臉",
    cardNo: "",
    deviceId: Number.isFinite(deviceId) && deviceId > 0 ? deviceId : null,
    deviceName,
    deviceScreenshotUrl: row.picture_path != null ? String(row.picture_path) : "",
  };
}

async function resolveGroupIdsWithChildren(groupIds) {
  const ids = [...new Set(groupIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(",");
  const children = await db.query(
    `SELECT id FROM person_groups WHERE parent_id IN (${placeholders})`,
    ids,
  );
  const all = new Set(ids);
  for (const row of children || []) {
    if (row?.id) all.add(Number(row.id));
  }
  return [...all];
}

/** 多表合併時僅用時間下界，避免門禁／人臉 id 空間衝突 */
function buildAccessTimeWindow({ cursorTsText, startTime, endTime }) {
  const endIso =
    endTime != null
      ? new Date(endTime).toISOString()
      : new Date().toISOString();
  if (startTime != null && endTime != null) {
    return {
      whereSql: `event_time_col >= ?::timestamptz AND event_time_col < ?::timestamptz`,
      params: [new Date(startTime).toISOString(), endIso],
    };
  }
  const cursor = String(cursorTsText ?? "").trim() || null;
  if (!cursor) {
    return {
      whereSql: `event_time_col > ?::timestamptz AND event_time_col <= ?::timestamptz`,
      params: [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), endIso],
    };
  }
  return {
    whereSql: `event_time_col > ?::timestamptz AND event_time_col <= ?::timestamptz`,
    params: [cursor, endIso],
  };
}

function replaceEventTimeCol(sql, columnExpr) {
  return sql.replaceAll("event_time_col", columnExpr);
}

async function fetchMergedAccessEvents({
  cursorTsText,
  startTime,
  endTime,
  limit,
  groupIds = [],
}) {
  const ctx = await loadAccessControlDeviceContext();
  const lim = clampLimit(limit);
  const { whereSql, params } = buildAccessTimeWindow({
    cursorTsText,
    startTime,
    endTime,
  });

  const groupIdsAll =
    groupIds.length > 0 ? await resolveGroupIdsWithChildren(groupIds) : [];
  const groupSql =
    groupIdsAll.length > 0
      ? ` AND p.person_group_id IN (${groupIdsAll.map(() => "?").join(",")})`
      : "";
  const groupParams = groupIdsAll;
  const timeWhere = `${replaceEventTimeCol(whereSql, "e.event_time")}${groupSql}`;

  const [doorRows, faceRows] = await Promise.all([
    db.query(
      `${ACCESS_CONTROL_EVENT_SELECT}
       WHERE ${timeWhere}
       ORDER BY e.event_time ASC, e.id ASC
       LIMIT ?`,
      [...params, ...groupParams, lim],
    ),
    db.query(
      `${FACE_CONTRAST_EVENT_SELECT}
       WHERE ${timeWhere}
       ORDER BY e.event_time ASC, e.id ASC
       LIMIT ?`,
      [...params, ...groupParams, lim],
    ),
  ]);

  const merged = [
    ...(doorRows || []).map((row) => buildAccessControlEventDto(row, ctx)),
    ...(faceRows || []).map((row) => buildFaceContrastEventDto(row, ctx)),
  ];
  merged.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (ta !== tb) return ta - tb;
    const sa = a.sourceKind === "door" ? 0 : 1;
    const sb = b.sourceKind === "door" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return Number(a.id) - Number(b.id);
  });
  const events = merged.slice(0, lim);
  const last = events.length ? events[events.length - 1] : null;
  return {
    events,
    lastFetchedEventId: last?.id != null ? Number(last.id) : null,
  };
}

const accessControlAdapter = {
  eventType: "access_control",
  label: "門禁管理／進出",
  sourceTable: "isapi_access_events",
  timeColumn: "event_time",
  catalog: ACCESS_CONTROL_FIELD_CATALOG,
  filterSchema: {
    kind: "person_groups",
    required: false,
    fields: [
      {
        key: "groupIds",
        type: "number[]",
        label: "人員群組（選填，空白=全部）",
        required: false,
      },
      ACCESS_GRAIN_FILTER_FIELD,
    ],
  },
  getFieldByKey: getAccessControlFieldByKey,
  mapValue: mapAccessControlEventToFieldValue,
  async fetchForSync({ cursorTsText, limit, options }) {
    const grain = readAccessGrain(options);
    const result = await fetchMergedAccessEvents({ cursorTsText, limit });
    if (grain !== "daily_first_last") {
      return {
        events: result.events,
        lastFetchedEventId: result.lastFetchedEventId,
        cursorEvent: result.events[result.events.length - 1] ?? null,
      };
    }
    const { events, cursorEvent } = reduceDailyFirstLastForSync(
      result.events,
      limit,
    );
    return {
      events,
      lastFetchedEventId:
        cursorEvent?.id != null ? Number(cursorEvent.id) : null,
      cursorEvent,
    };
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const groupIds = parseIdList(filter?.groupIds);
    const grain = readAccessGrain(filter);
    const lim = clampLimit(limit);
    // 考勤彙整需整段日窗再裁切（上限＝clampLimit 上界）
    const fetchLimit = grain === "daily_first_last" ? 50000 : lim;
    const { events: raw } = await fetchMergedAccessEvents({
      startTime,
      endTime,
      limit: fetchLimit,
      groupIds,
    });
    const events =
      grain === "daily_first_last" ? reduceDailyFirstLast(raw) : raw;
    return events.slice(0, lim);
  },
  validateFilter(filter) {
    return {
      groupIds: parseIdList(filter?.groupIds),
      grain: readAccessGrain(filter),
    };
  },
};

// --- 能源（energy）---

const ENERGY_SELECT = `
  SELECT er.id, er.device_id, er.recorded_at, er.data, d.name AS device_name
  FROM energy_readings er
  INNER JOIN devices d ON d.id = er.device_id
`;

const ENERGY_HOURLY_SELECT = `
  SELECT a.id, a.device_id, a.bucket_at AS recorded_at,
         jsonb_build_object(
           'delta_energy_kwh', a.delta_energy_kwh,
           'delta_water_m3', a.delta_water_m3,
           'tou_peak_kwh', a.tou_peak_kwh,
           'tou_semi_peak_kwh', a.tou_semi_peak_kwh,
           'tou_off_peak_kwh', a.tou_off_peak_kwh,
           'max_power_kw', a.max_power_kw,
           'max_demand_kw', a.max_demand_kw,
           'bucket_type', a.bucket_type,
           'data', COALESCE(a.data, '{}'::jsonb)
         ) AS data,
         d.name AS device_name
  FROM energy_usage_aggregated a
  INNER JOIN devices d ON d.id = a.device_id
`;

const ENERGY_CATALOG = [
  { key: "deviceId", label: "設備 ID", required: true },
  { key: "deviceName", label: "設備名稱" },
  ...timeSplitFields({
    dateTimeKey: "recordedAt",
    dateKey: "recordedDate",
    timeKey: "recordedTime",
    labelStem: "記錄",
  }),
  { key: "dataJson", label: "讀數 JSON" },
];

const getEnergyFieldByKey = (key) => ENERGY_CATALOG.find((f) => f.key === key) ?? null;

function mapEnergyValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "deviceId") return evt.deviceId != null ? String(evt.deviceId) : "";
  if (fieldKey === "deviceName") return evt.deviceName ?? "";
  if (isTimeSplitKey(fieldKey, "recordedAt", "recordedDate", "recordedTime")) {
    return formatTs(evt.timestamp, fieldConfig?.format);
  }
  if (fieldKey === "dataJson") return toJsonText(evt.data);
  return "";
}

function energyRowToEvent(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name ?? "",
    timestamp: row.recorded_at,
    data: typeof row.data === "object" ? row.data : {},
  };
}

function energyDeviceFilterSql(deviceIds, column = "er.device_id") {
  if (!deviceIds.length) return { extraWhere: "", extraParams: [] };
  const placeholders = deviceIds.map(() => "?").join(",");
  return {
    extraWhere: `${column} IN (${placeholders})`,
    extraParams: deviceIds,
  };
}

async function fetchEnergyEvents({
  grain,
  cursorTsText,
  cursorEventId,
  limit,
  deviceIds = [],
  startTime,
  endTime,
}) {
  const useHourly = grain !== "raw";
  const selectSql = useHourly ? ENERGY_HOURLY_SELECT : ENERGY_SELECT;
  const timeColumn = useHourly ? "a.bucket_at" : "er.recorded_at";
  const idColumn = useHourly ? "a.id" : "er.id";
  const deviceCol = useHourly ? "a.device_id" : "er.device_id";
  const { extraWhere: deviceWhere, extraParams } = energyDeviceFilterSql(
    deviceIds,
    deviceCol,
  );
  const hourWhere = useHourly
    ? deviceWhere
      ? `${deviceWhere} AND a.bucket_type = 'hour'`
      : `a.bucket_type = 'hour'`
    : deviceWhere;
  const hourParams = extraParams;

  if (startTime != null && endTime != null) {
    const rows = await fetchRowsInWindow({
      selectSql,
      timeColumn,
      idColumn,
      startTime,
      endTime,
      limit,
      extraWhere: hourWhere,
      extraParams: hourParams,
    });
    return rows.map(energyRowToEvent);
  }

  const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
    selectSql,
    timeColumn,
    idColumn,
    cursorTsText,
    cursorEventId,
    limit,
    extraWhere: hourWhere,
    extraParams: hourParams,
  });
  return {
    events: rows.map(energyRowToEvent),
    lastFetchedEventId,
  };
}

const energyAdapter = {
  eventType: "energy",
  label: "能源讀數",
  sourceTable: "energy_readings",
  timeColumn: "recorded_at",
  catalog: ENERGY_CATALOG,
  filterSchema: {
    kind: "devices",
    required: false,
    fields: [
      { key: "deviceIds", type: "number[]", label: "設備（空白=全部）" },
      GRAIN_FILTER_FIELD,
    ],
  },
  getFieldByKey: getEnergyFieldByKey,
  mapValue: mapEnergyValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit, options }) {
    const grain = parseGrain(options?.grain);
    return fetchEnergyEvents({
      grain,
      cursorTsText,
      cursorEventId,
      limit,
    });
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const deviceIds = parseIdList(filter?.deviceIds);
    const grain = parseGrain(filter?.grain);
    return fetchEnergyEvents({
      grain,
      deviceIds,
      startTime,
      endTime,
      limit,
    });
  },
  validateFilter(filter) {
    return {
      deviceIds: parseIdList(filter?.deviceIds),
      grain: parseGrain(filter?.grain),
    };
  },
};

// --- 營運事件（operational）---

const OPERATIONAL_SELECT = `
  SELECT e.id, e.created_at, e.source, e.event_kind, e.message,
         e.device_id, e.bit_key, e.address, e.old_value, e.new_value,
         e.payload, e.location_id,
         d.name AS device_name, l.name AS location_name, z.name AS zone_name
  FROM operational_events e
  LEFT JOIN devices d ON d.id = e.device_id
  LEFT JOIN locations l ON l.id = e.location_id
  LEFT JOIN zones z ON z.id = l.zone_id
`;

const OPERATIONAL_CATALOG = [
  ...timeSplitFields({
    dateTimeKey: "occurredAt",
    dateKey: "occurredDate",
    timeKey: "occurredTime",
    labelStem: "發生",
    required: true,
  }),
  { key: "source", label: "來源" },
  { key: "eventKind", label: "事件類型" },
  { key: "summary", label: "摘要" },
  { key: "zoneName", label: "區域" },
  { key: "locationName", label: "地點" },
  { key: "deviceId", label: "設備 ID" },
  { key: "deviceName", label: "設備" },
  { key: "payloadJson", label: "酬載 JSON" },
];

const getOperationalFieldByKey = (key) => OPERATIONAL_CATALOG.find((f) => f.key === key) ?? null;

function mapOperationalValue(evt, fieldKey, fieldConfig) {
  if (isTimeSplitKey(fieldKey, "occurredAt", "occurredDate", "occurredTime")) {
    return formatTs(evt.timestamp, fieldConfig?.format);
  }
  if (fieldKey === "source") return labelSystemSource(evt.source);
  if (fieldKey === "eventKind") return labelOperationalKind(evt.eventKind);
  if (fieldKey === "summary") return evt.summary ?? "";
  if (fieldKey === "zoneName") return evt.zoneName ?? "";
  if (fieldKey === "locationName") return evt.locationName ?? "";
  if (fieldKey === "deviceName") return evt.deviceName ?? "";
  if (fieldKey === "deviceId") return evt.deviceId != null ? String(evt.deviceId) : "";
  if (fieldKey === "payloadJson") return toJsonText(evt.payload);
  return "";
}

function operationalRowToEvent(row) {
  return {
    id: row.id,
    timestamp: row.created_at,
    source: row.source ?? "",
    eventKind: row.event_kind ?? "",
    summary: row.message ?? "",
    zoneName: row.zone_name ?? "",
    locationName: row.location_name ?? "",
    deviceName: row.device_name ?? "",
    deviceId: row.device_id,
    payload: row.payload,
  };
}

function operationalBuildExtra(filter) {
  const kinds = parseStringList(filter?.eventKinds);
  const sources = parseStringList(filter?.sources);
  const parts = [];
  const params = [];
  if (kinds.length) {
    parts.push(`e.event_kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (sources.length) {
    parts.push(`e.source IN (${sources.map(() => "?").join(",")})`);
    params.push(...sources);
  }
  return {
    extraWhere: parts.join(" AND "),
    extraParams: params,
  };
}

const operationalAdapter = {
  eventType: "operational",
  label: "營運事件",
  sourceTable: "operational_events",
  timeColumn: "created_at",
  catalog: OPERATIONAL_CATALOG,
  filterSchema: {
    kind: "operational",
    required: false,
    fields: [
      { key: "eventKinds", type: "string[]", label: "事件類型" },
      { key: "sources", type: "string[]", label: "來源" },
    ],
  },
  getFieldByKey: getOperationalFieldByKey,
  mapValue: mapOperationalValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit }) {
    const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
      selectSql: OPERATIONAL_SELECT,
      timeColumn: "e.created_at",
      idColumn: "e.id",
      cursorTsText,
      cursorEventId,
      limit,
    });
    return { events: rows.map(operationalRowToEvent), lastFetchedEventId };
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const { extraWhere, extraParams } = operationalBuildExtra(filter || {});
    const rows = await fetchRowsInWindow({
      selectSql: OPERATIONAL_SELECT,
      timeColumn: "e.created_at",
      idColumn: "e.id",
      startTime,
      endTime,
      limit,
      extraWhere,
      extraParams,
    });
    return rows.map(operationalRowToEvent);
  },
  validateFilter(filter) {
    return {
      eventKinds: parseStringList(filter?.eventKinds),
      sources: parseStringList(filter?.sources),
    };
  },
};

// --- 車輛（vehicle）---

const VEHICLE_SELECT = `
  SELECT v.id, v.trigger_time, v.license_plate, v.lane_name, v.lane_type,
         v.data_source, v.anpr_line, v.picture_path, v.device_id,
         v.location_id, v.owner_name,
         COALESCE(v.location_name, l.name) AS location_name,
         COALESCE(v.zone_name, z.name) AS zone_name,
         d.name AS device_name
  FROM vehicle_passageway_logs v
  LEFT JOIN locations l ON l.id = v.location_id
  LEFT JOIN zones z ON z.id = l.zone_id
  LEFT JOIN devices d ON d.id = v.device_id
`;

const VEHICLE_CATALOG = [
  { key: "licensePlate", label: "車牌", required: true },
  ...timeSplitFields({
    dateTimeKey: "triggerTime",
    dateKey: "triggerDate",
    timeKey: "triggerClock",
    labelStem: "通行",
  }),
  { key: "laneName", label: "車道" },
  { key: "dataSource", label: "資料來源" },
  { key: "zoneName", label: "區域" },
  { key: "locationName", label: "地點" },
  { key: "deviceName", label: "設備" },
  { key: "ownerName", label: "車主" },
  { key: "picturePath", label: "截圖路徑" },
];

const getVehicleFieldByKey = (key) => VEHICLE_CATALOG.find((f) => f.key === key) ?? null;

function mapVehicleValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "licensePlate") return evt.licensePlate ?? "";
  if (isTimeSplitKey(fieldKey, "triggerTime", "triggerDate", "triggerClock")) {
    return formatTs(evt.timestamp, fieldConfig?.format);
  }
  if (fieldKey === "laneName") return evt.laneName ?? "";
  if (fieldKey === "dataSource") return labelVehicleDataSource(evt.dataSource);
  if (fieldKey === "zoneName") return evt.zoneName ?? "";
  if (fieldKey === "locationName") return evt.locationName ?? "";
  if (fieldKey === "deviceName") return evt.deviceName ?? "";
  if (fieldKey === "ownerName") return evt.ownerName ?? "";
  if (fieldKey === "picturePath") return evt.picturePath ?? "";
  return "";
}

function vehicleRowToEvent(row) {
  return {
    id: row.id,
    timestamp: row.trigger_time,
    licensePlate: row.license_plate ?? "",
    laneName: row.lane_name ?? "",
    dataSource: row.data_source ?? "",
    zoneName: row.zone_name ?? "",
    locationName: row.location_name ?? "",
    deviceName: row.device_name ?? "",
    ownerName: row.owner_name ?? "",
    picturePath: row.picture_path ?? "",
  };
}

const vehicleAdapter = {
  eventType: "vehicle",
  label: "車輛進出",
  sourceTable: "vehicle_passageway_logs",
  timeColumn: "trigger_time",
  catalog: VEHICLE_CATALOG,
  filterSchema: {
    kind: "locations",
    required: false,
    fields: [{ key: "locationIds", type: "number[]", label: "地點（空白=全部）" }],
  },
  getFieldByKey: getVehicleFieldByKey,
  mapValue: mapVehicleValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit }) {
    const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
      selectSql: VEHICLE_SELECT,
      timeColumn: "v.trigger_time",
      idColumn: "v.id",
      cursorTsText,
      cursorEventId,
      limit,
    });
    return { events: rows.map(vehicleRowToEvent), lastFetchedEventId };
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const locationIds = parseIdList(filter?.locationIds);
    const extraWhere = locationIds.length
      ? `v.location_id IN (${locationIds.map(() => "?").join(",")})`
      : "";
    const rows = await fetchRowsInWindow({
      selectSql: VEHICLE_SELECT,
      timeColumn: "v.trigger_time",
      idColumn: "v.id",
      startTime,
      endTime,
      limit,
      extraWhere,
      extraParams: locationIds,
    });
    return rows.map(vehicleRowToEvent);
  },
  validateFilter(filter) {
    return { locationIds: parseIdList(filter?.locationIds) };
  },
};

// --- 警報（alerts）---

const ALERTS_SELECT = `
  SELECT a.id, a.created_at, a.updated_at, a.status, a.source, a.severity,
         a.alert_type, a.message, a.source_id, a.dimension_key
  FROM alerts a
`;

const ALERTS_CATALOG = [
  { key: "alertId", label: "警報 ID", required: true },
  ...timeSplitFields({
    dateTimeKey: "createdAt",
    dateKey: "createdDate",
    timeKey: "createdTime",
    labelStem: "建立",
  }),
  ...timeSplitFields({
    dateTimeKey: "updatedAt",
    dateKey: "updatedDate",
    timeKey: "updatedTime",
    labelStem: "更新",
  }),
  { key: "status", label: "狀態" },
  { key: "source", label: "來源" },
  { key: "severity", label: "嚴重度" },
  { key: "alertType", label: "警報類型" },
  { key: "message", label: "訊息" },
  { key: "sourceId", label: "來源 ID" },
  { key: "dimensionKey", label: "維度鍵" },
];

const getAlertsFieldByKey = (key) => ALERTS_CATALOG.find((f) => f.key === key) ?? null;

function mapAlertsValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "alertId") return evt.alertId != null ? String(evt.alertId) : "";
  if (isTimeSplitKey(fieldKey, "createdAt", "createdDate", "createdTime")) {
    return formatTs(evt.createdAt, fieldConfig?.format);
  }
  if (isTimeSplitKey(fieldKey, "updatedAt", "updatedDate", "updatedTime")) {
    return formatTs(evt.updatedAt, fieldConfig?.format);
  }
  if (fieldKey === "status") return labelAlertStatus(evt.status);
  if (fieldKey === "source") return labelSystemSource(evt.source);
  if (fieldKey === "severity") return labelAlertSeverity(evt.severity);
  if (fieldKey === "alertType") return labelAlertType(evt.alertType);
  if (fieldKey === "message") return evt.message ?? "";
  if (fieldKey === "sourceId") return evt.sourceId != null ? String(evt.sourceId) : "";
  if (fieldKey === "dimensionKey") return labelDimensionKey(evt.dimensionKey);
  return "";
}

function alertsRowToEvent(row) {
  return {
    id: row.id,
    alertId: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timestamp: row.updated_at || row.created_at,
    status: row.status ?? "",
    source: row.source ?? "",
    severity: row.severity ?? "",
    alertType: row.alert_type ?? "",
    message: row.message ?? "",
    sourceId: row.source_id,
    dimensionKey: row.dimension_key ?? "",
  };
}

function alertsBuildExtra(filter) {
  const sources = parseStringList(filter?.sources);
  const statuses = parseStringList(filter?.statuses);
  const parts = [];
  const params = [];
  if (sources.length) {
    parts.push(`a.source::text IN (${sources.map(() => "?").join(",")})`);
    params.push(...sources);
  }
  if (statuses.length) {
    parts.push(`a.status::text IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  return { extraWhere: parts.join(" AND "), extraParams: params };
}

const alertsAdapter = {
  eventType: "alerts",
  label: "警報事件",
  sourceTable: "alerts",
  timeColumn: "updated_at",
  catalog: ALERTS_CATALOG,
  filterSchema: {
    kind: "alerts",
    required: false,
    fields: [
      { key: "sources", type: "string[]", label: "來源" },
      { key: "statuses", type: "string[]", label: "狀態（空白=全部）" },
    ],
  },
  getFieldByKey: getAlertsFieldByKey,
  mapValue: mapAlertsValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit }) {
    const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
      selectSql: ALERTS_SELECT,
      timeColumn: "a.updated_at",
      cursorTsText,
      cursorEventId,
      limit,
    });
    return { events: rows.map(alertsRowToEvent), lastFetchedEventId };
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const { extraWhere, extraParams } = alertsBuildExtra(filter || {});
    const rows = await fetchRowsInWindow({
      selectSql: ALERTS_SELECT,
      timeColumn: "a.updated_at",
      startTime,
      endTime,
      limit,
      extraWhere,
      extraParams,
    });
    return rows.map(alertsRowToEvent);
  },
  validateFilter(filter) {
    return {
      sources: parseStringList(filter?.sources),
      statuses: parseStringList(filter?.statuses),
    };
  },
};

// --- 環境（environment）---

const ENVIRONMENT_SELECT = `
  SELECT er.id, er.location_id, er.recorded_at, er.data,
         l.name AS location_name, z.name AS zone_name
  FROM environment_readings er
  INNER JOIN locations l ON er.location_id = l.id
  INNER JOIN zones z ON l.zone_id = z.id
`;

const ENVIRONMENT_HOURLY_SELECT = `
  SELECT a.id, a.location_id, a.bucket_at AS recorded_at, a.data,
         l.name AS location_name, z.name AS zone_name
  FROM environment_readings_aggregated a
  INNER JOIN locations l ON a.location_id = l.id
  INNER JOIN zones z ON l.zone_id = z.id
`;

const ENVIRONMENT_CATALOG = [
  { key: "locationId", label: "地點 ID", required: true },
  { key: "zoneName", label: "區域" },
  { key: "locationName", label: "地點" },
  ...timeSplitFields({
    dateTimeKey: "recordedAt",
    dateKey: "recordedDate",
    timeKey: "recordedTime",
    labelStem: "記錄",
  }),
  { key: "dataJson", label: "讀數 JSON" },
];

const getEnvironmentFieldByKey = (key) => ENVIRONMENT_CATALOG.find((f) => f.key === key) ?? null;

function mapEnvironmentValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "locationId") return evt.locationId != null ? String(evt.locationId) : "";
  if (fieldKey === "zoneName") return evt.zoneName ?? "";
  if (fieldKey === "locationName") return evt.locationName ?? "";
  if (isTimeSplitKey(fieldKey, "recordedAt", "recordedDate", "recordedTime")) {
    return formatTs(evt.timestamp, fieldConfig?.format);
  }
  if (fieldKey === "dataJson") return toJsonText(evt.data);
  return "";
}

function environmentRowToEvent(row) {
  return {
    id: row.id,
    locationId: row.location_id,
    zoneName: row.zone_name ?? "",
    locationName: row.location_name ?? "",
    timestamp: row.recorded_at,
    data: typeof row.data === "object" ? row.data : {},
  };
}

async function fetchEnvironmentEvents({
  grain,
  cursorTsText,
  cursorEventId,
  limit,
  locationIds = [],
  startTime,
  endTime,
}) {
  const useHourly = grain !== "raw";
  const selectSql = useHourly ? ENVIRONMENT_HOURLY_SELECT : ENVIRONMENT_SELECT;
  const timeColumn = useHourly ? "a.bucket_at" : "er.recorded_at";
  const idColumn = useHourly ? "a.id" : "er.id";
  const locCol = useHourly ? "a.location_id" : "er.location_id";
  const locWhere = locationIds.length
    ? `${locCol} IN (${locationIds.map(() => "?").join(",")})`
    : "";
  const hourWhere = useHourly
    ? locWhere
      ? `${locWhere} AND a.bucket_type = 'hour'`
      : `a.bucket_type = 'hour'`
    : locWhere;
  const locParams = locationIds;

  if (startTime != null && endTime != null) {
    const rows = await fetchRowsInWindow({
      selectSql,
      timeColumn,
      idColumn,
      startTime,
      endTime,
      limit,
      extraWhere: hourWhere,
      extraParams: locParams,
    });
    return rows.map(environmentRowToEvent);
  }

  const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
    selectSql,
    timeColumn,
    idColumn,
    cursorTsText,
    cursorEventId,
    limit,
    extraWhere: hourWhere,
    extraParams: locParams,
  });
  return {
    events: rows.map(environmentRowToEvent),
    lastFetchedEventId,
  };
}

const environmentAdapter = {
  eventType: "environment",
  label: "環境數值",
  sourceTable: "environment_readings",
  timeColumn: "recorded_at",
  catalog: ENVIRONMENT_CATALOG,
  filterSchema: {
    kind: "locations",
    required: false,
    fields: [
      { key: "locationIds", type: "number[]", label: "地點（空白=全部）" },
      GRAIN_FILTER_FIELD,
    ],
  },
  getFieldByKey: getEnvironmentFieldByKey,
  mapValue: mapEnvironmentValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit, options }) {
    const grain = parseGrain(options?.grain);
    return fetchEnvironmentEvents({
      grain,
      cursorTsText,
      cursorEventId,
      limit,
    });
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const locationIds = parseIdList(filter?.locationIds);
    const grain = parseGrain(filter?.grain);
    return fetchEnvironmentEvents({
      grain,
      locationIds,
      startTime,
      endTime,
      limit,
    });
  },
  validateFilter(filter) {
    return {
      locationIds: parseIdList(filter?.locationIds),
      grain: parseGrain(filter?.grain),
    };
  },
};

/** 各事件類型共用：客戶 ERP／導入模板預留空白欄（表頭／第三方欄名自訂） */
const BLANK_FIELD_COUNT = 3;

/** 在 catalog 末端附加空白欄，並讓 mapValue 對 constantEmpty 固定回傳 "" */
function withBlankFields(adapter, count = BLANK_FIELD_COUNT) {
  const blanks = Array.from({ length: count }, (_, i) => ({
    key: `blank${i + 1}`,
    label: `空白欄 ${i + 1}`,
    constantEmpty: true,
  }));
  const catalog = [...(adapter.catalog || []), ...blanks];
  const getFieldByKey = (key) => catalog.find((f) => f.key === key) ?? null;
  const origMap = adapter.mapValue;
  return {
    ...adapter,
    catalog,
    getFieldByKey,
    mapValue(evt, fieldKey, fieldConfig) {
      if (getFieldByKey(fieldKey)?.constantEmpty) return "";
      return origMap(evt, fieldKey, fieldConfig);
    },
  };
}

const ADAPTERS = {
  access_control: withBlankFields(accessControlAdapter),
  energy: withBlankFields(energyAdapter),
  operational: withBlankFields(operationalAdapter),
  vehicle: withBlankFields(vehicleAdapter),
  alerts: withBlankFields(alertsAdapter),
  environment: withBlankFields(environmentAdapter),
};

module.exports = {
  ADAPTERS,
  parseGrain,
  normalizeOptionsGrain,
};
