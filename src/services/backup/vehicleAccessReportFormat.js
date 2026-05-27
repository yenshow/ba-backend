/**
 * 車輛進出備份 CSV 報表格式
 * 與前端完整報表一致：
 * 1. 進出統計：日期、區域-地點、進場車輛、出場車輛、在場車輛
 * 2. 群組統計：日期、區域-地點、群組名稱、進場車輛、出場車輛、在場車輛
 * 3. 過車紀錄：區域-地點、車牌、過車時間、車道名稱、車主名稱、車輛群組、放行結果、方向
 */

const { formatDateTimeZhTW, formatDateZhTW, formatZoneLocation } = require("./reportFormatUtils");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { computeTransitionStats } = require("../entryExit/stats");
const { normalizeVehicleDirection } = require("../vehicleAccess/normalizeVehicleDirection");

const sep = "\x00";

function groupByDayLocation(rows) {
  const groups = new Map();
  for (const r of rows) {
    const dateStr = formatDateZhTW(r.trigger_time);
    const zoneLoc = formatZoneLocation(r.zone_name, r.location_name);
    const key = `${dateStr}${sep}${zoneLoc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/** 進場/出場/在場：transition（車牌為主體） */
function countEntryExit(recs) {
  const sorted = [...recs].sort(
    (a, b) => new Date(a.trigger_time) - new Date(b.trigger_time),
  );
  const { entryCount, exitCount, currentCount } = computeTransitionStats(
    sorted,
    {
      getKey: (r) => normalizePlate(r.license_plate),
      getDirection: normalizeVehicleDirection,
      getTime: (r) => r.trigger_time,
      sortByTime: false,
    },
  );
  return { entry: entryCount, exit: exitCount, current: currentCount };
}

/** 進出統計：每日每區一列，5 欄 */
function buildStatsSection(rows) {
  const groups = groupByDayLocation(rows);
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [dA, zA] = a.split(sep);
    const [dB, zB] = b.split(sep);
    return dA.localeCompare(dB) || zA.localeCompare(zB);
  });
  const sectionRows = [];
  for (const key of sortedKeys) {
    const idx = key.indexOf(sep);
    const dateStr = key.slice(0, idx);
    const zoneLoc = key.slice(idx + sep.length);
    const recs = groups.get(key);
    const { entry, exit, current } = countEntryExit(recs);
    sectionRows.push({
      日期: dateStr,
      "區域-地點": zoneLoc,
      進場車輛: String(entry),
      出場車輛: String(exit),
      在場車輛: String(current),
    });
  }
  return sectionRows;
}

/** 群組統計：依日期+區域+車輛群組分組（不含空群組名稱） */
function buildGroupStatsSection(rows) {
  const groups = groupByDayLocation(rows);
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [dA, zA] = a.split(sep);
    const [dB, zB] = b.split(sep);
    return dA.localeCompare(dB) || zA.localeCompare(zB);
  });
  const sectionRows = [];
  for (const key of sortedKeys) {
    const idx = key.indexOf(sep);
    const dateStr = key.slice(0, idx);
    const zoneLoc = key.slice(idx + sep.length);
    const recs = groups.get(key);
    const byGroup = new Map();
    for (const r of recs) {
      const name = (r.vehicle_list_name ?? "").trim();
      if (!name) continue;
      if (!byGroup.has(name)) byGroup.set(name, []);
      byGroup.get(name).push(r);
    }
    const groupNames = [...byGroup.keys()].sort();
    for (const groupName of groupNames) {
      const unitRecs = byGroup.get(groupName);
      const { entry, exit, current } = countEntryExit(unitRecs);
      sectionRows.push({
        日期: dateStr,
        "區域-地點": zoneLoc,
        群組名稱: groupName,
        進場車輛: String(entry),
        出場車輛: String(exit),
        在場車輛: String(current),
      });
    }
  }
  return sectionRows;
}

/** 過車紀錄：每筆一列，放行結果與方向依 allow_result、lane_type */
function buildDetailSection(rows) {
  const groups = groupByDayLocation(rows);
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [dA, zA] = a.split(sep);
    const [dB, zB] = b.split(sep);
    return dA.localeCompare(dB) || zA.localeCompare(zB);
  });
  const result = [];
  for (const key of sortedKeys) {
    const zoneLoc = key.slice(key.indexOf(sep) + sep.length);
    const recs = groups.get(key);
    const sorted = [...recs].sort(
      (a, b) => new Date(a.trigger_time) - new Date(b.trigger_time)
    );
    for (const r of sorted) {
      const allowLabel = r.allow_result === 1 ? "放行" : "未放行";
      const directionLabel =
        r.lane_type === 1 ? "進場" : r.lane_type === 2 ? "出場" : "－";
      result.push({
        "區域-地點": zoneLoc,
        車牌: (r.license_plate ?? "").trim() || "－",
        過車時間: formatDateTimeZhTW(r.trigger_time),
        車道名稱: (r.lane_name ?? "").trim() || "－",
        車主名稱: (r.owner_name ?? "").trim() || "－",
        車輛群組: (r.vehicle_list_name ?? "").trim() || "－",
        放行結果: allowLabel,
        方向: directionLabel,
      });
    }
  }
  return result.sort((a, b) =>
    (b.過車時間 || "").localeCompare(a.過車時間 || "")
  );
}

const SECTION_HEADERS = {
  stats: ["日期", "區域-地點", "進場車輛", "出場車輛", "在場車輛"],
  group: ["日期", "區域-地點", "群組名稱", "進場車輛", "出場車輛", "在場車輛"],
  detail: ["區域-地點", "車牌", "過車時間", "車道名稱", "車主名稱", "車輛群組", "放行結果", "方向"],
};

function emptySections() {
  return {
    sections: [
      { title: "進出統計", headers: SECTION_HEADERS.stats, rows: [] },
      { title: "群組統計", headers: SECTION_HEADERS.group, rows: [] },
      { title: "過車紀錄", headers: SECTION_HEADERS.detail, rows: [] },
    ],
  };
}

function transformVehicleAccessToReportFormat(rows) {
  if (!rows || rows.length === 0) return emptySections();

  return {
    sections: [
      { title: "進出統計", headers: SECTION_HEADERS.stats, rows: buildStatsSection(rows) },
      { title: "群組統計", headers: SECTION_HEADERS.group, rows: buildGroupStatsSection(rows) },
      { title: "過車紀錄", headers: SECTION_HEADERS.detail, rows: buildDetailSection(rows) },
    ],
  };
}

module.exports = {
  transformVehicleAccessToReportFormat,
};
