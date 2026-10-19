/**
 * 人流／門禁完整報表與備份（三區塊 → xlsx）
 * - 共用 sections 組裝
 * - YSCP people_counting_logs
 * - ISAPI 門禁／人臉／攝影機人流
 */
const {
  formatDateTimeZhTW,
  formatDateZhTW,
  formatZoneLocation,
} = require("./reportFormatUtils");
const { computeTransitionStats } = require("../entryExit/stats");
const {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveAccessStrangerDisplay,
  resolveVerifyMethodLabel,
  shouldDisplayAccessEventPicture,
} = require("../peopleCounting/accessControlLogLabels");

const {
  DEFAULT_PEOPLE_COUNTING_STAT_LABELS,
  normalizePeopleCountingStatLabels,
  resolveSharedPeopleCountingStatLabels,
  entryExitReportHeaders,
  mapEntryExitStatsRow,
} = require("../entryExit/statLabels");

const sep = "\x00";

const DETAIL_HEADERS = [
  "區域-地點",
  "群組",
  "出入口名稱",
  "姓名",
  "方式",
  "準確度",
  "事件",
  "時間",
  "圖片路徑",
];

function resolvePeopleCountingLabels(opts = {}) {
  if (opts.statLabels) {
    return normalizePeopleCountingStatLabels(opts.statLabels);
  }
  if (Array.isArray(opts.statLabelsList) && opts.statLabelsList.length > 0) {
    return resolveSharedPeopleCountingStatLabels(
      opts.statLabelsList.map((x) => normalizePeopleCountingStatLabels(x)),
    );
  }
  return { ...DEFAULT_PEOPLE_COUNTING_STAT_LABELS };
}

const dash = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s || "—";
};

const formatSimilarity = (v) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n}%`;
};

function emptyPeopleCountingSections(labels = DEFAULT_PEOPLE_COUNTING_STAT_LABELS) {
  const { statsHeaders, groupStatsHeaders } = entryExitReportHeaders(labels);
  return {
    sections: [
      { title: "進出統計", headers: [...statsHeaders], rows: [] },
      { title: "群組統計", headers: [...groupStatsHeaders], rows: [] },
      { title: "進出紀錄", headers: [...DETAIL_HEADERS], rows: [] },
    ],
  };
}

function groupByDayLocation(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const dateStr = formatDateZhTW(r.eventTime);
    const zoneLoc = formatZoneLocation(r.zoneName, r.locationName);
    const key = `${dateStr}${sep}${zoneLoc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

function sortedDayLocationKeys(groups) {
  return [...groups.keys()].sort((a, b) => {
    const [dA, zA] = a.split(sep);
    const [dB, zB] = b.split(sep);
    return dA.localeCompare(dB) || zA.localeCompare(zB);
  });
}

function countTransition(recs) {
  const sorted = [...recs].sort(
    (a, b) => new Date(a.eventTime) - new Date(b.eventTime),
  );
  return computeTransitionStats(sorted, {
    getKey: (r) => {
      const k = r.personKey;
      if (k == null || k === "" || k === -1) return null;
      return k;
    },
    getDirection: (r) =>
      r.direction === "entry" || r.direction === "exit" ? r.direction : null,
    getTime: (r) => r.eventTime,
    sortByTime: false,
  });
}

function countDelta(recs) {
  let entry = 0;
  let exit = 0;
  for (const r of recs) {
    entry += Math.max(0, Number(r.enterDelta) || 0);
    exit += Math.max(0, Number(r.exitDelta) || 0);
  }
  return {
    entryCount: entry,
    exitCount: exit,
    currentCount: Math.max(0, entry - exit),
  };
}

function buildStatsSection(rows, statsMode, labels) {
  const groups = groupByDayLocation(rows);
  const sectionRows = [];
  for (const key of sortedDayLocationKeys(groups)) {
    const idx = key.indexOf(sep);
    const dateStr = key.slice(0, idx);
    const zoneLoc = key.slice(idx + sep.length);
    const recs = groups.get(key);
    const { entryCount, exitCount, currentCount } =
      statsMode === "delta" ? countDelta(recs) : countTransition(recs);
    sectionRows.push(
      mapEntryExitStatsRow(
        {
          date: dateStr,
          zoneLocation: zoneLoc,
          entryCount,
          exitCount,
          currentCount,
        },
        labels,
      ),
    );
  }
  return sectionRows;
}

function buildGroupStatsSection(rows, statsMode, labels) {
  const groups = groupByDayLocation(rows);
  const sectionRows = [];
  for (const key of sortedDayLocationKeys(groups)) {
    const idx = key.indexOf(sep);
    const dateStr = key.slice(0, idx);
    const zoneLoc = key.slice(idx + sep.length);
    const recs = groups.get(key);
    const byGroup = new Map();
    for (const r of recs) {
      const name = (r.groupName ?? "").trim();
      if (!name) continue;
      if (!byGroup.has(name)) byGroup.set(name, []);
      byGroup.get(name).push(r);
    }
    for (const groupName of [...byGroup.keys()].sort()) {
      const groupRecs = byGroup.get(groupName);
      const { entryCount, exitCount, currentCount } =
        statsMode === "delta"
          ? countDelta(groupRecs)
          : countTransition(groupRecs);
      sectionRows.push(
        mapEntryExitStatsRow(
          {
            date: dateStr,
            zoneLocation: zoneLoc,
            groupName,
            entryCount,
            exitCount,
            currentCount,
          },
          labels,
        ),
      );
    }
  }
  return sectionRows;
}

function buildDetailSection(rows) {
  const groups = groupByDayLocation(rows);
  const result = [];
  for (const key of sortedDayLocationKeys(groups)) {
    const zoneLoc = key.slice(key.indexOf(sep) + sep.length);
    const recs = groups.get(key);
    const sorted = [...recs].sort(
      (a, b) => new Date(a.eventTime) - new Date(b.eventTime),
    );
    for (const r of sorted) {
      result.push({
        "區域-地點": zoneLoc || "—",
        群組: dash(r.groupName),
        出入口名稱: dash(r.doorName),
        姓名: dash(r.personName),
        方式: dash(r.verifyMethod),
        準確度: formatSimilarity(r.similarity),
        事件: dash(r.eventLabel),
        時間: formatDateTimeZhTW(r.eventTime),
        圖片路徑: dash(r.picturePath),
      });
    }
  }
  return result.sort((a, b) => (b.時間 || "").localeCompare(a.時間 || ""));
}

/**
 * @param {object[]} [normalizedRows]
 * @param {{
 *   statsMode?: 'transition'|'delta',
 *   statsRows?: object[],
 *   detailRows?: object[],
 *   statLabels?: object,
 *   statLabelsList?: object[],
 * }} [opts]
 */
function buildPeopleCountingReportSections(normalizedRows, opts = {}) {
  const statsMode = opts.statsMode === "delta" ? "delta" : "transition";
  const labels = resolvePeopleCountingLabels(opts);
  const { statsHeaders, groupStatsHeaders } = entryExitReportHeaders(labels);
  const statsSource = opts.statsRows ?? normalizedRows ?? [];
  const detailSource = opts.detailRows ?? normalizedRows ?? [];
  if (statsSource.length === 0 && detailSource.length === 0) {
    return emptyPeopleCountingSections(labels);
  }
  return {
    sections: [
      {
        title: "進出統計",
        headers: [...statsHeaders],
        rows: buildStatsSection(statsSource, statsMode, labels),
      },
      {
        title: "群組統計",
        headers: [...groupStatsHeaders],
        rows: buildGroupStatsSection(statsSource, statsMode, labels),
      },
      {
        title: "進出紀錄",
        headers: [...DETAIL_HEADERS],
        rows: buildDetailSection(detailSource),
      },
    ],
  };
}

// --- YSCP ---

function eventLabelFromDirection(dir) {
  if (dir === "entry") return "進入";
  if (dir === "exit") return "離開";
  return "失敗";
}

function transformPeopleCountingToReportFormat(
  rows,
  doorNameMap = new Map(),
  directionMap = new Map(),
  reportOpts = {},
) {
  const normalized = (rows || []).map((r) => {
    const physicalId = r.physical_id != null ? Number(r.physical_id) : null;
    const dir = directionMap.get(physicalId);
    const doorName =
      physicalId != null ? doorNameMap.get(physicalId) || "" : "";
    return {
      eventTime: r.swip_card_rev_time,
      zoneName: r.zone_name,
      locationName: r.location_name,
      groupName: (r.unit_name ?? "").trim(),
      personName: r.person_name ?? "",
      doorName,
      verifyMethod: "",
      similarity: null,
      eventLabel: eventLabelFromDirection(dir),
      direction: dir === "entry" || dir === "exit" ? dir : null,
      personKey: r.person_id === -1 ? null : r.person_id,
      picturePath: r.backup_picture_path ?? r.picture_path ?? "",
    };
  });
  return buildPeopleCountingReportSections(normalized, {
    statsMode: "transition",
    ...reportOpts,
  });
}

// --- ISAPI ---

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

function collectAccessEmployeeNos(rows) {
  const nos = [];
  for (const row of rows || []) {
    const no = getEmployeeNo(parsePayload(row.payload));
    if (no) nos.push(no);
  }
  return nos;
}

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
    statLabels: ctx.statLabels,
    statLabelsList: ctx.statLabelsList,
  });
}

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
    statLabels: ctx.statLabels,
    statLabelsList: ctx.statLabelsList,
  });
}

function transformIsapiPeopleCountingToReportFormat(rows, reportOpts = {}) {
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
    ...reportOpts,
  });
}

module.exports = {
  buildPeopleCountingReportSections,
  transformPeopleCountingToReportFormat,
  collectAccessEmployeeNos,
  transformIsapiAccessEventsToReportFormat,
  transformIsapiFaceContrastEventsToReportFormat,
  transformIsapiPeopleCountingToReportFormat,
};
