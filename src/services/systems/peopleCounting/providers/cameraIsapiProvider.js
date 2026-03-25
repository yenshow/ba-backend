/**
 * 攝影機（camera_isapi）人流統計 Provider
 * 事件來源：isapi_people_counting_events（enter/exit 為累積值）
 * UI 需求：以 enter/exit 增量推導 entry/exit 記錄；單位/人員欄位先留空
 */
const db = require("../../../../database/db");
const deviceService = require("../../../devices/deviceService");
const { getTodayTimeRange } = require("../../../../utils/dateRangeUtils");
const logger = require("../../../../utils/logger");

function normalizeDeviceHost(host) {
  if (!host || typeof host !== "string") return "";
  const trimmed = host.trim();
  const m = trimmed.match(/^(?:https?:\/\/)?([^:/]+)/);
  return m ? m[1] : trimmed;
}

async function getDeviceIpByDeviceId(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  const host = device?.config?.host || "";
  const ip = normalizeDeviceHost(host);
  if (!ip) {
    const err = new Error("攝影機設備缺少有效 host");
    err.statusCode = 400;
    throw err;
  }
  return { ip, deviceName: device?.name || ip };
}

async function getLatestEvent(deviceIp, channelId, startTime, endTime) {
  const rows = await db.query(
    `SELECT event_time, enter_total, exit_total
     FROM isapi_people_counting_events
     WHERE device_ip = $1 AND channel_id = $2 AND event_time >= $3 AND event_time <= $4
     ORDER BY event_time DESC
     LIMIT 1`,
    [deviceIp, Number(channelId) || 1, startTime, endTime],
  );
  return rows?.[0] || null;
}

async function getEventsAsc(deviceIp, channelId, startTime, endTime) {
  const rows = await db.query(
    `SELECT event_time, enter_total, exit_total
     FROM isapi_people_counting_events
     WHERE device_ip = $1 AND channel_id = $2 AND event_time >= $3 AND event_time <= $4
     ORDER BY event_time ASC`,
    [deviceIp, Number(channelId) || 1, startTime, endTime],
  );
  return rows || [];
}

function asIntOrNull(v) {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildLogsFromTotals(events, deviceName, deviceIdForLog) {
  if (!events || events.length === 0) return [];
  const logs = [];
  // 為了在「只有 1 筆事件」時也能顯示紀錄，預設以 0 作為基準值。
  // 注意：若設備的 enter/exit 非「每日歸零」而是長期累積，第一筆會顯示較大的增量；目前 UI 只需要顯示事件類型，先接受此折衷。
  let prevEnter = 0;
  let prevExit = 0;

  for (const ev of events) {
    const enter = asIntOrNull(ev.enter_total);
    const exit = asIntOrNull(ev.exit_total);
    const ts = ev.event_time;

    const enterDelta =
      enter != null ? Math.max(0, enter - prevEnter) : 0;
    const exitDelta =
      exit != null ? Math.max(0, exit - prevExit) : 0;

    // 依需求：判斷哪個數字增加了，來顯示 entry/exit
    if (enterDelta > 0) {
      logs.push({
        id: `isapi-camera-enter-${ts}-${enter}`,
        personId: null,
        personName: "",
        unitId: null,
        unitName: "",
        employeeId: null,
        eventType: "entry",
        timestamp: ts,
        deviceScreenshotUrl: "",
        deviceName,
        deviceId: deviceIdForLog,
      });
    }
    if (exitDelta > 0) {
      logs.push({
        id: `isapi-camera-exit-${ts}-${exit}`,
        personId: null,
        personName: "",
        unitId: null,
        unitName: "",
        employeeId: null,
        eventType: "exit",
        timestamp: ts,
        deviceScreenshotUrl: "",
        deviceName,
        deviceId: deviceIdForLog,
      });
    }

    prevEnter = enter;
    prevExit = exit;
  }

  // UI 目前預期 logs 為 DESC（和 yscp/access_control 對齊），provider 這裡先轉成 DESC
  return logs.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

async function getSiteData(siteId, config) {
  const cameraDeviceId = config.cameraDeviceId ?? null;
  const cameraChannelId = config.cameraChannelId ?? 1;
  if (!cameraDeviceId) {
    return { entryCount: 0, exitCount: 0, currentCount: 0, units: [] };
  }

  const { ip: deviceIp } = await getDeviceIpByDeviceId(cameraDeviceId);
  const { start, end } = getTodayTimeRange();
  const latest = await getLatestEvent(
    deviceIp,
    cameraChannelId,
    start.toISOString(),
    end.toISOString(),
  );

  const entryCount =
    latest?.enter_total != null ? Number(latest.enter_total) : 0;
  const exitCount = latest?.exit_total != null ? Number(latest.exit_total) : 0;
  const currentCount = Math.max(entryCount - exitCount, 0);

  return { entryCount, exitCount, currentCount, units: [] };
}

async function getSiteLogs(siteId, config, options = {}) {
  const cameraDeviceId = config.cameraDeviceId ?? null;
  const cameraChannelId = config.cameraChannelId ?? 1;
  if (!cameraDeviceId) return { logs: [] };

  const { ip: deviceIp, deviceName } =
    await getDeviceIpByDeviceId(cameraDeviceId);

  const start = options.startTime
    ? new Date(options.startTime)
    : getTodayTimeRange().start;
  const end = options.endTime
    ? new Date(options.endTime)
    : getTodayTimeRange().end;

  let events = [];
  try {
    events = await getEventsAsc(
      deviceIp,
      cameraChannelId,
      start.toISOString(),
      end.toISOString(),
    );
  } catch (err) {
    logger.warn("讀取攝影機人流事件失敗", {
      locationId: siteId,
      deviceIp,
      channelId: cameraChannelId,
      error: err.message,
    });
    events = [];
  }

  const logsAll = buildLogsFromTotals(events, deviceName, cameraDeviceId);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const logs = logsAll.slice(offset, offset + limit);

  return { logs };
}

async function getUnitPersonnel() {
  return { personnel: [], entryCount: 0, exitCount: 0 };
}

module.exports = {
  getSiteData,
  getSiteLogs,
  getUnitPersonnel,
};
