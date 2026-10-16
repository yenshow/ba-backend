/**
 * ISAPI 門禁／人臉／攝影機人流備份 CSV：與 UI 完整報表同三區塊／欄位（含圖片路徑）
 */
const {
  buildPeopleCountingReportSections,
} = require("./peopleCountingBackupSections");
const {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveAccessStrangerDisplay,
  resolveVerifyMethodLabel,
  shouldDisplayAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");

function parsePayload(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function getEmployeeNo(payload) {
  const v = payload.employeeNoString ?? payload.employeeNo;
  return v != null ? String(v).trim() : "";
}

function picturePathOf(r) {
  const p = r.backup_picture_path ?? r.picture_path ?? "";
  return p != null ? String(p).trim() : "";
}

/** 供 scheduler 預載人員主檔 */
function collectAccessEmployeeNos(rows) {
  const nos = [];
  for (const row of rows || []) {
    const no = getEmployeeNo(parsePayload(row.payload));
    if (no) nos.push(no);
  }
  return nos;
}

/**
 * @param {object[]} rows
 * @param {{
 *   accessByDeviceId?: Map<number, object>,
 *   personByEmployeeNo?: Map<string, object>,
 * }} [ctx]
 */
function transformIsapiAccessEventsToReportFormat(rows, ctx = {}) {
  const accessByDeviceId = ctx.accessByDeviceId || new Map();
  const personByEmployeeNo = ctx.personByEmployeeNo || new Map();

  const entryIdSet = new Set();
  const exitIdSet = new Set();
  for (const [id, info] of accessByDeviceId) {
    if (info.direction === "entry") entryIdSet.add(id);
    if (info.direction === "exit") exitIdSet.add(id);
  }

  const normalized = [];
  for (const r of rows || []) {
    const payload = parsePayload(r.payload);
    const sub = extractSubEventType(payload);
    const deviceId =
      r.device_id != null && Number.isFinite(Number(r.device_id))
        ? Number(r.device_id)
        : null;
    const loc = deviceId != null ? accessByDeviceId.get(deviceId) : null;
    const { eventType, eventLabel } = resolveAccessControlEvent(sub, {
      deviceId,
      entryDeviceIds: entryIdSet,
      exitDeviceIds: exitIdSet,
    });
    const employeeId = getEmployeeNo(payload);
    const personInfo = employeeId ? personByEmployeeNo.get(employeeId) : null;
    const devicePersonName =
      payload.personName != null ? String(payload.personName).trim() : "";
    const stranger = resolveAccessStrangerDisplay({
      sub,
      eventLabel,
      personName: personInfo?.personName || devicePersonName || "",
      employeeId,
    });
    const showPic = shouldDisplayAccessEventPicture(payload, r.picture_path);
    normalized.push({
      eventTime: r.event_time,
      zoneName: loc?.zoneName || r.zone_name || "",
      locationName: loc?.locationName || r.location_name || "",
      groupName: personInfo?.groupName || "",
      personName: stranger.personName,
      doorName: loc?.deviceName || r.device_ip || "",
      verifyMethod: resolveVerifyMethodLabel(payload) || "",
      similarity: null,
      eventLabel: stranger.eventLabel,
      direction:
        eventType === "entry" || eventType === "exit" ? eventType : null,
      personKey: employeeId || null,
      picturePath: showPic ? picturePathOf(r) : "",
    });
  }

  return buildPeopleCountingReportSections(normalized, {
    statsMode: "transition",
  });
}

/**
 * @param {object[]} rows
 * @param {{ faceByDeviceId?: Map<number, object>, personByEmployeeNo?: Map<string, object> }} [ctx]
 */
function transformIsapiFaceContrastEventsToReportFormat(rows, ctx = {}) {
  const faceByDeviceId = ctx.faceByDeviceId || new Map();
  const personByEmployeeNo = ctx.personByEmployeeNo || new Map();

  const normalized = [];
  for (const r of rows || []) {
    const deviceId =
      r.device_id != null && Number.isFinite(Number(r.device_id))
        ? Number(r.device_id)
        : null;
    const loc = deviceId != null ? faceByDeviceId.get(deviceId) : null;
    const employeeId =
      r.employee_no != null && String(r.employee_no).trim()
        ? String(r.employee_no).trim()
        : "";
    const personInfo = employeeId ? personByEmployeeNo.get(employeeId) : null;
    const rawName =
      (personInfo?.personName || "") ||
      (r.person_name != null ? String(r.person_name).trim() : "") ||
      "";
    let matched = Boolean(r.matched);
    const similarity =
      r.similarity != null && Number.isFinite(Number(r.similarity))
        ? Number(r.similarity)
        : null;
    const threshold = loc?.faceSimilarityThreshold;
    if (
      matched &&
      threshold != null &&
      (similarity == null || similarity < threshold)
    ) {
      matched = false;
    }

    // 與 provider：未匹配不標方向；匹配優先設備歸屬，其次 payload.direction
    let direction = null;
    if (matched) {
      if (loc?.direction === "entry" || loc?.direction === "exit") {
        direction = loc.direction;
      } else {
        const p = parsePayload(r.payload);
        if (p.direction === "entry" || p.direction === "exit") {
          direction = p.direction;
        }
      }
    }

    const isStranger = !matched && !rawName && !employeeId;
    const eventType = !matched
      ? "failed"
      : direction === "exit"
        ? "exit"
        : direction === "entry"
          ? "entry"
          : "failed";
    const eventLabel =
      eventType === "entry"
        ? "進入"
        : eventType === "exit"
          ? "離開"
          : isStranger
            ? "陌生"
            : "失敗";

    normalized.push({
      eventTime: r.event_time,
      zoneName: r.zone_name || loc?.zoneName || "",
      locationName: r.location_name || loc?.locationName || "",
      groupName: personInfo?.groupName || "",
      personName: rawName || (isStranger ? "陌生" : "—"),
      doorName: loc?.deviceName || r.device_ip || "",
      verifyMethod: "人臉",
      similarity,
      eventLabel,
      direction:
        eventType === "entry" || eventType === "exit" ? eventType : null,
      personKey: employeeId || (rawName ? `name:${rawName}` : null),
      picturePath: picturePathOf(r),
    });
  }

  return buildPeopleCountingReportSections(normalized, {
    statsMode: "transition",
  });
}

/** 攝影機分區人流：統計用 delta；明細展開進／出列 */
function transformIsapiPeopleCountingToReportFormat(rows) {
  const forStats = [];
  const forDetail = [];
  for (const r of rows || []) {
    const regionName =
      (r.region_name != null ? String(r.region_name).trim() : "") ||
      "未命名區域";
    const enterDelta = Math.max(0, Number(r.enter_delta) || 0);
    const exitDelta = Math.max(0, Number(r.exit_delta) || 0);
    const base = {
      eventTime: r.event_time,
      zoneName: r.zone_name || "",
      locationName: r.location_name || "",
      groupName: regionName,
      personName: "",
      doorName: r.device_ip || "",
      verifyMethod: "",
      similarity: null,
      personKey: null,
      picturePath: "",
    };
    if (enterDelta > 0 || exitDelta > 0) {
      forStats.push({
        ...base,
        enterDelta,
        exitDelta,
        direction: null,
        eventLabel: "",
      });
    }
    if (enterDelta > 0) {
      forDetail.push({
        ...base,
        direction: "entry",
        eventLabel: "進入",
      });
    }
    if (exitDelta > 0) {
      forDetail.push({
        ...base,
        direction: "exit",
        eventLabel: "離開",
      });
    }
  }

  return buildPeopleCountingReportSections(null, {
    statsMode: "delta",
    statsRows: forStats,
    detailRows: forDetail,
  });
}

module.exports = {
  collectAccessEmployeeNos,
  transformIsapiAccessEventsToReportFormat,
  transformIsapiFaceContrastEventsToReportFormat,
  transformIsapiPeopleCountingToReportFormat,
};
