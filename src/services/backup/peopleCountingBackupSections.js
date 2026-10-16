/**
 * 人流／門禁備份與完整報表共用的三區塊 CSV 結構
 * 進出統計／群組統計／進出紀錄（含圖片路徑）
 */
const {
  formatDateTimeZhTW,
  formatDateZhTW,
  formatZoneLocation,
} = require("./reportFormatUtils");
const { computeTransitionStats } = require("../entryExit/stats");

const sep = "\x00";

const STATS_HEADERS = ["日期", "區域-地點", "進場人數", "出場人數", "在場人數"];
const GROUP_STATS_HEADERS = [
  "日期",
  "區域-地點",
  "群組",
  "進場人數",
  "出場人數",
  "在場人數",
];
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

const dash = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s || "—";
};

/** 與 UI formatLogSimilarity 一致 */
const formatSimilarity = (v) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n}%`;
};

function emptyPeopleCountingSections() {
  return {
    sections: [
      { title: "進出統計", headers: [...STATS_HEADERS], rows: [] },
      { title: "群組統計", headers: [...GROUP_STATS_HEADERS], rows: [] },
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

function buildStatsSection(rows, statsMode) {
  const groups = groupByDayLocation(rows);
  const sectionRows = [];
  for (const key of sortedDayLocationKeys(groups)) {
    const idx = key.indexOf(sep);
    const dateStr = key.slice(0, idx);
    const zoneLoc = key.slice(idx + sep.length);
    const recs = groups.get(key);
    const { entryCount, exitCount, currentCount } =
      statsMode === "delta" ? countDelta(recs) : countTransition(recs);
    sectionRows.push({
      日期: dateStr,
      "區域-地點": zoneLoc,
      進場人數: String(entryCount),
      出場人數: String(exitCount),
      在場人數: String(currentCount),
    });
  }
  return sectionRows;
}

function buildGroupStatsSection(rows, statsMode) {
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
      sectionRows.push({
        日期: dateStr,
        "區域-地點": zoneLoc,
        群組: groupName,
        進場人數: String(entryCount),
        出場人數: String(exitCount),
        在場人數: String(currentCount),
      });
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
 * @param {object[]} [normalizedRows] 統計與明細同源時傳此參數
 * @param {{
 *   statsMode?: 'transition'|'delta',
 *   statsRows?: object[],
 *   detailRows?: object[],
 * }} [opts] 攝影機人流可拆 statsRows／detailRows
 */
function buildPeopleCountingReportSections(normalizedRows, opts = {}) {
  const statsMode = opts.statsMode === "delta" ? "delta" : "transition";
  const statsSource = opts.statsRows ?? normalizedRows ?? [];
  const detailSource = opts.detailRows ?? normalizedRows ?? [];
  if (statsSource.length === 0 && detailSource.length === 0) {
    return emptyPeopleCountingSections();
  }
  return {
    sections: [
      {
        title: "進出統計",
        headers: [...STATS_HEADERS],
        rows: buildStatsSection(statsSource, statsMode),
      },
      {
        title: "群組統計",
        headers: [...GROUP_STATS_HEADERS],
        rows: buildGroupStatsSection(statsSource, statsMode),
      },
      {
        title: "進出紀錄",
        headers: [...DETAIL_HEADERS],
        rows: buildDetailSection(detailSource),
      },
    ],
  };
}

module.exports = {
  buildPeopleCountingReportSections,
};
