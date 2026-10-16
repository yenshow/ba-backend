/**
 * 車輛進出備份 CSV：與前端完整報表同三區塊／欄位（含圖片路徑）
 */

const {
  formatDateTimeZhTW,
  formatDateZhTW,
  formatZoneLocation,
} = require("./reportFormatUtils");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { computeTransitionStats } = require("../entryExit/stats");
const {
  normalizeVehicleDirection,
} = require("../vehicleAccess/vehicleAccessHelpers");

const sep = "\x00";

const STATS_HEADERS = ["日期", "區域-地點", "進場車輛", "出場車輛", "在場車輛"];
const GROUP_STATS_HEADERS = [
  "日期",
  "區域-地點",
  "群組",
  "進場車輛",
  "出場車輛",
  "在場車輛",
];
/** 與 UI 完整報表匯出一致（固定欄＋預設顯示欄＋圖片路徑） */
const DETAIL_HEADERS = [
  "區域-地點",
  "群組",
  "車牌",
  "車道",
  "車主名稱",
  "放行結果",
  "時間",
  "圖片路徑",
];

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
    for (const groupName of [...byGroup.keys()].sort()) {
      const unitRecs = byGroup.get(groupName);
      const { entry, exit, current } = countEntryExit(unitRecs);
      sectionRows.push({
        日期: dateStr,
        "區域-地點": zoneLoc,
        群組: groupName,
        進場車輛: String(entry),
        出場車輛: String(exit),
        在場車輛: String(current),
      });
    }
  }
  return sectionRows;
}

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
      (a, b) => new Date(a.trigger_time) - new Date(b.trigger_time),
    );
    for (const r of sorted) {
      const allowLabel =
        r.allow_result === 1
          ? r.lane_type === 1
            ? "進入"
            : r.lane_type === 2
              ? "離開"
              : "放行"
          : r.allow_result === 0
            ? "拒絕"
            : "陌生";
      const pic =
        r.backup_picture_path ?? r.picture_path ?? "";
      result.push({
        "區域-地點": zoneLoc || "—",
        群組: (r.vehicle_list_name ?? "").trim() || "—",
        車牌: (r.license_plate ?? "").trim() || "—",
        車道: (r.lane_name ?? "").trim() || "—",
        車主名稱: (r.owner_name ?? "").trim() || "—",
        放行結果: allowLabel,
        時間: formatDateTimeZhTW(r.trigger_time),
        圖片路徑: (pic && String(pic).trim()) || "—",
      });
    }
  }
  return result.sort((a, b) => (b.時間 || "").localeCompare(a.時間 || ""));
}

function emptySections() {
  return {
    sections: [
      { title: "進出統計", headers: [...STATS_HEADERS], rows: [] },
      { title: "群組統計", headers: [...GROUP_STATS_HEADERS], rows: [] },
      { title: "過車紀錄", headers: [...DETAIL_HEADERS], rows: [] },
    ],
  };
}

function transformVehicleAccessToReportFormat(rows) {
  if (!rows || rows.length === 0) return emptySections();

  return {
    sections: [
      {
        title: "進出統計",
        headers: [...STATS_HEADERS],
        rows: buildStatsSection(rows),
      },
      {
        title: "群組統計",
        headers: [...GROUP_STATS_HEADERS],
        rows: buildGroupStatsSection(rows),
      },
      {
        title: "過車紀錄",
        headers: [...DETAIL_HEADERS],
        rows: buildDetailSection(rows),
      },
    ],
  };
}

module.exports = {
  transformVehicleAccessToReportFormat,
};
