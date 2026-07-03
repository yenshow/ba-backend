const { DateTime } = require("luxon");
const db = require("../../database/db");
const deviceService = require("../devices/deviceService");
const logger = require("../../utils/logger").createLogger("accessControlFields");
const {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveVerifyMethodLabel,
} = require("../peopleCounting/accessControlLogLabels");
const { normalizeEmployeeNo } = require("../peopleCounting/helpers/entryExitStats");

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

const CACHE_MS = 60_000;
let deviceContextCache = null;
let deviceContextCachedAt = 0;

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
  if (deviceContextCache && Date.now() - deviceContextCachedAt < CACHE_MS) {
    return deviceContextCache;
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

  deviceContextCache = { entryIps, exitIps, ipToDeviceName };
  deviceContextCachedAt = Date.now();
  return deviceContextCache;
}

const BASE_EVENT_SELECT = `
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
    plc.card_no AS ladder_card_no
  FROM isapi_access_events e
  LEFT JOIN persons p
    ON p.employee_no = COALESCE((e.payload->>'employeeNoString'), (e.payload->>'employeeNo'))
  LEFT JOIN person_groups pg ON p.person_group_id = pg.id
  LEFT JOIN person_ladder_cards plc ON plc.person_id = p.id
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

async function fetchAccessControlEventsAfterCursor(cursorTs, limit = 5000) {
  const ctx = await loadAccessControlDeviceContext();
  const start = cursorTs ? new Date(cursorTs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = new Date();
  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 50000);

  const rows = await db.query(
    `${BASE_EVENT_SELECT}
     WHERE e.event_time > ? AND e.event_time <= ?
     ORDER BY e.event_time ASC
     LIMIT ?`,
    [start.toISOString(), end.toISOString(), lim],
  );

  const events = (rows || []).map((row) => buildAccessControlEventDto(row, ctx));
  const lastFetchedEventTime = rows?.length ? rows[rows.length - 1].event_time : null;
  return { events, lastFetchedEventTime };
}

async function fetchAccessControlEventsForGroups({ groupIds, startTime, endTime, limit = 5000 }) {
  const groupIdsAll = await resolveGroupIdsWithChildren(groupIds);
  if (groupIdsAll.length === 0) return [];

  const ctx = await loadAccessControlDeviceContext();
  const placeholders = groupIdsAll.map(() => "?").join(",");
  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 50000);

  const rows = await db.query(
    `${BASE_EVENT_SELECT}
     WHERE p.person_group_id IN (${placeholders})
       AND e.event_time >= ? AND e.event_time <= ?
     ORDER BY e.event_time ASC
     LIMIT ?`,
    [...groupIdsAll, startTime.toISOString(), endTime.toISOString(), lim],
  );

  return (rows || []).map((row) => buildAccessControlEventDto(row, ctx));
}

module.exports = {
  ACCESS_CONTROL_FIELD_CATALOG,
  getAccessControlFieldByKey,
  mapAccessControlEventToFieldValue,
  fetchAccessControlEventsAfterCursor,
  fetchAccessControlEventsForGroups,
};
