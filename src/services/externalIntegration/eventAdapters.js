/**
 * 外部整合：共用查詢工具 + 七種 eventType adapter（對接／轉存）
 */
const { DateTime } = require("luxon");
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const logger = require("../../utils/logger").createLogger("eventAdapters");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveVerifyMethodLabel,
} = require("../peopleCounting/accessControlLogLabels");
const { normalizeEmployeeNo } = require("../peopleCounting/helpers/entryExitStats");

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
  let whereSql = `${timeColumn} >= ?::timestamptz AND ${timeColumn} <= ?::timestamptz`;
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

// --- 門禁（access_control）---

const ACCESS_CONTROL_FIELD_CATALOG = [
  { key: "employeeId", label: "員工/人員 ID", required: true },
  { key: "personName", label: "姓名" },
  { key: "personGroup", label: "人員群組" },
  { key: "deviceName", label: "出入口名稱" },
  { key: "deviceScreenshot", label: "設備截圖" },
  { key: "eventDateTime", label: "進出日期和時間", requiresFormat: true },
  { key: "eventDate", label: "進出日期", requiresFormat: true },
  { key: "eventTime", label: "進出時間", requiresFormat: true },
  { key: "cardNo", label: "卡號" },
];

const getAccessControlFieldByKey = (key) =>
  ACCESS_CONTROL_FIELD_CATALOG.find((f) => f.key === key) ?? null;

function mapAccessControlEventToFieldValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "employeeId") return evt.employeeId ?? "";
  if (fieldKey === "personName") return evt.personName ?? "";
  if (fieldKey === "personGroup") return evt.unitName ?? "";
  if (fieldKey === "deviceName") return evt.deviceName ?? "";
  if (fieldKey === "deviceScreenshot") return evt.deviceScreenshotUrl ?? "";
  if (fieldKey === "cardNo") return evt.cardNo ?? "";

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

async function loadAccessControlDeviceContext() {
  if (acDeviceContextCache && Date.now() - acDeviceContextCachedAt < AC_DEVICE_CACHE_MS) {
    return acDeviceContextCache;
  }

  const entryIps = new Set();
  const exitIps = new Set();
  const ipToDeviceName = new Map();

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
  }

  const addDevice = async (deviceId, isEntry) => {
    try {
      const { device } = await deviceService.getDeviceById(deviceId);
      const ip = normalizeDeviceHost(device?.config?.host);
      if (!ip) return;
      ipToDeviceName.set(ip, device?.name || ip);
      if (isEntry) entryIps.add(ip);
      else exitIps.add(ip);
    } catch (err) {
      logger.warn("取得門禁設備 IP 失敗，略過", {
        deviceId,
        error: err?.message || String(err),
      });
    }
  };

  for (const id of allEntryIds) await addDevice(id, true);
  for (const id of allExitIds) {
    if (!allEntryIds.has(id)) await addDevice(id, false);
  }

  acDeviceContextCache = { entryIps, exitIps, ipToDeviceName };
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

function buildAccessControlEventDto(row, ctx) {
  const payload = typeof row.payload === "object" ? row.payload : {};
  const employeeId = (row.employee_no ?? normalizeEmployeeNo(payload) ?? "").toString().trim();
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

  return {
    id: row.id,
    employeeId: employeeId || null,
    personName,
    unitName: row.unit_name != null ? String(row.unit_name).trim() : "",
    timestamp: row.event_time,
    eventType,
    verifyMethod,
    cardNo,
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

async function fetchAccessControlEventsAfterCursor(cursor = {}, limit = 5000) {
  const ctx = await loadAccessControlDeviceContext();
  const endIso = new Date().toISOString();
  const lim = clampLimit(limit);

  const cursorTsText = String(cursor?.cursorTsText ?? "").trim() || null;
  const cursorEventId = Number(cursor?.cursorEventId);
  const hasEventId = Number.isFinite(cursorEventId) && cursorEventId > 0;

  let whereSql;
  let params;
  if (!cursorTsText) {
    whereSql = `e.event_time > ?::timestamptz AND e.event_time <= ?::timestamptz`;
    params = [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), endIso];
  } else if (hasEventId) {
    whereSql = `(e.event_time > ?::timestamptz OR (e.event_time = ?::timestamptz AND e.id > ?))
       AND e.event_time <= ?::timestamptz`;
    params = [cursorTsText, cursorTsText, cursorEventId, endIso];
  } else {
    whereSql = `e.event_time > ?::timestamptz AND e.event_time <= ?::timestamptz`;
    params = [cursorTsText, endIso];
  }

  const rows = await db.query(
    `${ACCESS_CONTROL_EVENT_SELECT}
     WHERE ${whereSql}
     ORDER BY e.event_time ASC, e.id ASC
     LIMIT ?`,
    [...params, lim],
  );

  const events = (rows || []).map((row) => buildAccessControlEventDto(row, ctx));
  const last = rows?.length ? rows[rows.length - 1] : null;
  return {
    events,
    lastFetchedEventId: last?.id != null ? Number(last.id) : null,
  };
}

async function fetchAccessControlEventsForGroups({ groupIds, startTime, endTime, limit = 5000 }) {
  const groupIdsAll = await resolveGroupIdsWithChildren(groupIds);
  if (groupIdsAll.length === 0) return [];

  const ctx = await loadAccessControlDeviceContext();
  const placeholders = groupIdsAll.map(() => "?").join(",");
  const lim = clampLimit(limit);

  const rows = await db.query(
    `${ACCESS_CONTROL_EVENT_SELECT}
     WHERE p.person_group_id IN (${placeholders})
       AND e.event_time >= ? AND e.event_time <= ?
     ORDER BY e.event_time ASC, e.id ASC
     LIMIT ?`,
    [...groupIdsAll, startTime.toISOString(), endTime.toISOString(), lim],
  );

  return (rows || []).map((row) => buildAccessControlEventDto(row, ctx));
}

const accessControlAdapter = {
  eventType: "access_control",
  label: "門禁／刷卡",
  sourceTable: "isapi_access_events",
  timeColumn: "event_time",
  catalog: ACCESS_CONTROL_FIELD_CATALOG,
  filterSchema: {
    kind: "person_groups",
    required: true,
    fields: [{ key: "groupIds", type: "number[]", label: "人員群組", required: true }],
  },
  getFieldByKey: getAccessControlFieldByKey,
  mapValue: mapAccessControlEventToFieldValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit }) {
    return fetchAccessControlEventsAfterCursor(
      { cursorTsText, cursorEventId },
      limit,
    );
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const groupIds = parseIdList(filter?.groupIds);
    if (groupIds.length === 0) {
      throwApiError(C.VALIDATION_CUSTOM, "部門（人員群組）至少需選擇一項", {
        statusCode: 400,
      });
    }
    return fetchAccessControlEventsForGroups({
      groupIds,
      startTime,
      endTime,
      limit,
    });
  },
  validateFilter(filter) {
    const groupIds = parseIdList(filter?.groupIds);
    if (groupIds.length === 0) {
      throwApiError(C.VALIDATION_CUSTOM, "部門（人員群組）至少需選擇一項", {
        statusCode: 400,
      });
    }
    return { groupIds };
  },
};

// --- 能源（energy）---

const ENERGY_SELECT = `
  SELECT er.id, er.device_id, er.recorded_at, er.data, d.name AS device_name
  FROM energy_readings er
  INNER JOIN devices d ON d.id = er.device_id
`;

const ENERGY_CATALOG = [
  { key: "deviceId", label: "設備 ID", required: true },
  { key: "deviceName", label: "設備名稱" },
  { key: "recordedAt", label: "記錄時間", requiresFormat: true },
  { key: "dataJson", label: "讀數 JSON" },
];

const getEnergyFieldByKey = (key) => ENERGY_CATALOG.find((f) => f.key === key) ?? null;

function mapEnergyValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "deviceId") return evt.deviceId != null ? String(evt.deviceId) : "";
  if (fieldKey === "deviceName") return evt.deviceName ?? "";
  if (fieldKey === "recordedAt") return formatTs(evt.timestamp, fieldConfig?.format);
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

function energyDeviceFilterSql(deviceIds) {
  if (!deviceIds.length) return { extraWhere: "", extraParams: [] };
  const placeholders = deviceIds.map(() => "?").join(",");
  return {
    extraWhere: `er.device_id IN (${placeholders})`,
    extraParams: deviceIds,
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
    fields: [{ key: "deviceIds", type: "number[]", label: "設備（空白=全部）" }],
  },
  getFieldByKey: getEnergyFieldByKey,
  mapValue: mapEnergyValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit }) {
    const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
      selectSql: ENERGY_SELECT,
      timeColumn: "er.recorded_at",
      idColumn: "er.id",
      cursorTsText,
      cursorEventId,
      limit,
    });
    return { events: rows.map(energyRowToEvent), lastFetchedEventId };
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const deviceIds = parseIdList(filter?.deviceIds);
    const { extraWhere, extraParams } = energyDeviceFilterSql(deviceIds);
    const rows = await fetchRowsInWindow({
      selectSql: ENERGY_SELECT,
      timeColumn: "er.recorded_at",
      idColumn: "er.id",
      startTime,
      endTime,
      limit,
      extraWhere,
      extraParams,
    });
    return rows.map(energyRowToEvent);
  },
  validateFilter(filter) {
    return { deviceIds: parseIdList(filter?.deviceIds) };
  },
};

// --- 營運事件（operational）---

const OPERATIONAL_SELECT = `
  SELECT e.id, e.occurred_at, e.source, e.event_kind, e.summary,
         e.device_id, e.bit_key, e.address, e.old_value, e.new_value,
         e.payload, e.location_id,
         d.name AS device_name, l.name AS location_name, z.name AS zone_name
  FROM operational_events e
  LEFT JOIN devices d ON d.id = e.device_id
  LEFT JOIN locations l ON l.id = e.location_id
  LEFT JOIN zones z ON z.id = l.zone_id
`;

const OPERATIONAL_CATALOG = [
  { key: "occurredAt", label: "發生時間", requiresFormat: true, required: true },
  { key: "source", label: "來源" },
  { key: "eventKind", label: "事件類型" },
  { key: "summary", label: "摘要" },
  { key: "zoneName", label: "區域" },
  { key: "locationName", label: "地點" },
  { key: "deviceName", label: "設備" },
  { key: "deviceId", label: "設備 ID" },
  { key: "payloadJson", label: "Payload JSON" },
];

const getOperationalFieldByKey = (key) => OPERATIONAL_CATALOG.find((f) => f.key === key) ?? null;

function mapOperationalValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "occurredAt") return formatTs(evt.timestamp, fieldConfig?.format);
  if (fieldKey === "source") return evt.source ?? "";
  if (fieldKey === "eventKind") return evt.eventKind ?? "";
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
    timestamp: row.occurred_at,
    source: row.source ?? "",
    eventKind: row.event_kind ?? "",
    summary: row.summary ?? "",
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
  timeColumn: "occurred_at",
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
      timeColumn: "e.occurred_at",
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
      timeColumn: "e.occurred_at",
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
  { key: "triggerTime", label: "通行時間", requiresFormat: true },
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
  if (fieldKey === "triggerTime") return formatTs(evt.timestamp, fieldConfig?.format);
  if (fieldKey === "laneName") return evt.laneName ?? "";
  if (fieldKey === "dataSource") return evt.dataSource ?? "";
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

// --- 人流（people_counting）---

const PEOPLE_COUNTING_SELECT = `
  SELECT p.id,
         p.swip_card_rev_time AS event_time,
         'yscp'::text AS data_source,
         p.physical_id::text AS ref_key,
         p.person_name,
         p.unit_name,
         NULL::text AS device_ip,
         p.location_id
  FROM people_counting_logs p
`;

const PEOPLE_COUNTING_CATALOG = [
  { key: "eventTime", label: "事件時間", requiresFormat: true, required: true },
  { key: "dataSource", label: "資料來源" },
  { key: "personName", label: "姓名" },
  { key: "unitName", label: "單位" },
  { key: "deviceIp", label: "設備 IP" },
  { key: "refKey", label: "來源鍵" },
];

const getPeopleCountingFieldByKey = (key) =>
  PEOPLE_COUNTING_CATALOG.find((f) => f.key === key) ?? null;

function mapPeopleCountingValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "eventTime") return formatTs(evt.timestamp, fieldConfig?.format);
  if (fieldKey === "dataSource") return evt.dataSource ?? "";
  if (fieldKey === "personName") return evt.personName ?? "";
  if (fieldKey === "unitName") return evt.unitName ?? "";
  if (fieldKey === "deviceIp") return evt.deviceIp ?? "";
  if (fieldKey === "refKey") return evt.refKey ?? "";
  return "";
}

function peopleCountingRowToEvent(row) {
  return {
    id: row.id,
    timestamp: row.event_time,
    dataSource: row.data_source ?? "",
    personName: row.person_name ?? "",
    unitName: row.unit_name ?? "",
    deviceIp: row.device_ip ?? "",
    refKey: row.ref_key ?? "",
    locationId: row.location_id,
  };
}

function yscpLocationFilter(locationIds) {
  if (!locationIds.length) return { extraWhere: "", extraParams: [] };
  return {
    extraWhere: `p.location_id IN (${locationIds.map(() => "?").join(",")})`,
    extraParams: locationIds,
  };
}

async function fetchYscpRows({
  cursorTsText,
  cursorEventId,
  limit,
  startTime,
  endTime,
  locationIds = [],
}) {
  const { extraWhere, extraParams } = yscpLocationFilter(locationIds);
  if (startTime != null && endTime != null) {
    const rows = await fetchRowsInWindow({
      selectSql: PEOPLE_COUNTING_SELECT,
      timeColumn: "p.swip_card_rev_time",
      idColumn: "p.id",
      startTime,
      endTime,
      limit,
      extraWhere,
      extraParams,
    });
    return { events: rows.map(peopleCountingRowToEvent), lastFetchedEventId: null };
  }
  const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
    selectSql: PEOPLE_COUNTING_SELECT,
    timeColumn: "p.swip_card_rev_time",
    idColumn: "p.id",
    cursorTsText,
    cursorEventId,
    limit,
    extraWhere,
    extraParams,
  });
  return { events: rows.map(peopleCountingRowToEvent), lastFetchedEventId };
}

const peopleCountingAdapter = {
  eventType: "people_counting",
  label: "人流紀錄",
  sourceTable: "people_counting_logs",
  timeColumn: "swip_card_rev_time",
  catalog: PEOPLE_COUNTING_CATALOG,
  filterSchema: {
    kind: "locations",
    required: false,
    fields: [{ key: "locationIds", type: "number[]", label: "地點（選填，空白=全部）" }],
  },
  getFieldByKey: getPeopleCountingFieldByKey,
  mapValue: mapPeopleCountingValue,
  async fetchForSync(opts) {
    return fetchYscpRows(opts);
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const locationIds = parseIdList(filter?.locationIds);
    const { events } = await fetchYscpRows({
      startTime,
      endTime,
      limit,
      locationIds,
    });
    return events;
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
  { key: "createdAt", label: "建立時間", requiresFormat: true },
  { key: "updatedAt", label: "更新時間", requiresFormat: true },
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
  if (fieldKey === "createdAt") return formatTs(evt.createdAt, fieldConfig?.format);
  if (fieldKey === "updatedAt") return formatTs(evt.updatedAt, fieldConfig?.format);
  if (fieldKey === "status") return evt.status ?? "";
  if (fieldKey === "source") return evt.source ?? "";
  if (fieldKey === "severity") return evt.severity ?? "";
  if (fieldKey === "alertType") return evt.alertType ?? "";
  if (fieldKey === "message") return evt.message ?? "";
  if (fieldKey === "sourceId") return evt.sourceId != null ? String(evt.sourceId) : "";
  if (fieldKey === "dimensionKey") return evt.dimensionKey ?? "";
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

const ENVIRONMENT_CATALOG = [
  { key: "locationId", label: "地點 ID", required: true },
  { key: "zoneName", label: "區域" },
  { key: "locationName", label: "地點" },
  { key: "recordedAt", label: "記錄時間", requiresFormat: true },
  { key: "dataJson", label: "讀數 JSON" },
];

const getEnvironmentFieldByKey = (key) => ENVIRONMENT_CATALOG.find((f) => f.key === key) ?? null;

function mapEnvironmentValue(evt, fieldKey, fieldConfig) {
  if (fieldKey === "locationId") return evt.locationId != null ? String(evt.locationId) : "";
  if (fieldKey === "zoneName") return evt.zoneName ?? "";
  if (fieldKey === "locationName") return evt.locationName ?? "";
  if (fieldKey === "recordedAt") return formatTs(evt.timestamp, fieldConfig?.format);
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

const environmentAdapter = {
  eventType: "environment",
  label: "環境數值",
  sourceTable: "environment_readings",
  timeColumn: "recorded_at",
  catalog: ENVIRONMENT_CATALOG,
  filterSchema: {
    kind: "locations",
    required: false,
    fields: [{ key: "locationIds", type: "number[]", label: "地點（空白=全部）" }],
  },
  getFieldByKey: getEnvironmentFieldByKey,
  mapValue: mapEnvironmentValue,
  async fetchForSync({ cursorTsText, cursorEventId, limit }) {
    const { rows, lastFetchedEventId } = await fetchRowsAfterCursor({
      selectSql: ENVIRONMENT_SELECT,
      timeColumn: "er.recorded_at",
      idColumn: "er.id",
      cursorTsText,
      cursorEventId,
      limit,
    });
    return { events: rows.map(environmentRowToEvent), lastFetchedEventId };
  },
  async fetchForExport({ filter, startTime, endTime, limit }) {
    const locationIds = parseIdList(filter?.locationIds);
    const extraWhere = locationIds.length
      ? `er.location_id IN (${locationIds.map(() => "?").join(",")})`
      : "";
    const rows = await fetchRowsInWindow({
      selectSql: ENVIRONMENT_SELECT,
      timeColumn: "er.recorded_at",
      idColumn: "er.id",
      startTime,
      endTime,
      limit,
      extraWhere,
      extraParams: locationIds,
    });
    return rows.map(environmentRowToEvent);
  },
  validateFilter(filter) {
    return { locationIds: parseIdList(filter?.locationIds) };
  },
};

const ADAPTERS = {
  access_control: accessControlAdapter,
  energy: energyAdapter,
  operational: operationalAdapter,
  vehicle: vehicleAdapter,
  people_counting: peopleCountingAdapter,
  alerts: alertsAdapter,
  environment: environmentAdapter,
};

module.exports = {
  ADAPTERS,
};
