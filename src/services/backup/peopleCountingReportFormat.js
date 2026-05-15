/**
 * 人流統計備份 CSV 報表格式
 * 與頁面一致：
 * 1. 進出統計：日期、區域-地點、進場人數、出場人數、在場人數
 * 2. 單位統計：日期、區域-地點、單位名稱、進場人數、出場人數、在場人數
 * 3. 進出紀錄：設備截圖、進場單位、工號、姓名、事件、方式、時間（與主表欄位一致；YSCP 備份無工號/方式時填 —）
 */
const DETAIL_LOG_HEADERS = [
  "設備截圖",
  "進場單位",
  "工號",
  "姓名",
  "事件",
  "方式",
  "時間",
];

const {
  formatDateTimeZhTW,
  formatDateZhTW,
  formatZoneLocation,
} = require("./reportFormatUtils");
const {
  countEntryExitFromSorted,
} = require("../systems/peopleCountingService");

const sep = "\x00";

function groupByDayLocation(rows) {
  const groups = new Map();
  for (const r of rows) {
    const dateStr = formatDateZhTW(r.swip_card_rev_time);
    const zoneLoc = formatZoneLocation(r.zone_name, r.location_name);
    const key = `${dateStr}${sep}${zoneLoc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/** 進出統計：每日每區一列，5 欄（日期、區域-地點、進場人數、出場人數、在場人數） */
function buildStatsSection(rows, directionMap) {
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
    const sorted = [...recs].sort(
      (a, b) => new Date(a.swip_card_rev_time) - new Date(b.swip_card_rev_time),
    );
    const getDirection = (r) => directionMap.get(Number(r.physical_id));
    const { entryCount, exitCount } = countEntryExitFromSorted(
      sorted,
      getDirection,
    );
    const current = Math.max(0, entryCount - exitCount);
    sectionRows.push({
      日期: dateStr,
      "區域-地點": zoneLoc,
      進場人數: String(entryCount),
      出場人數: String(exitCount),
      在場人數: String(current),
    });
  }
  return sectionRows;
}

/** 單位統計：依日期+區域+單位分組，每組進場/出場/在場人數 */
function buildUnitStatsSection(rows, directionMap) {
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
    const byUnit = new Map();
    for (const r of recs) {
      const raw = (r.unit_name ?? "").trim();
      if (!raw) continue;
      if (!byUnit.has(raw)) byUnit.set(raw, []);
      byUnit.get(raw).push(r);
    }
    const unitNames = [...byUnit.keys()].sort();
    for (const unitName of unitNames) {
      const unitRecs = byUnit.get(unitName);
      const sorted = [...unitRecs].sort(
        (a, b) =>
          new Date(a.swip_card_rev_time) - new Date(b.swip_card_rev_time),
      );
      const getDirection = (r) => directionMap.get(Number(r.physical_id));
      const { entryCount, exitCount } = countEntryExitFromSorted(
        sorted,
        getDirection,
      );
      const current = Math.max(0, entryCount - exitCount);
      sectionRows.push({
        日期: dateStr,
        "區域-地點": zoneLoc,
        單位名稱: unitName,
        進場人數: String(entryCount),
        出場人數: String(exitCount),
        在場人數: String(current),
      });
    }
  }
  return sectionRows;
}

/** 進場未出場者：僅最新一筆進場的 record（用於進出紀錄篩選） */
function getEntryOnlyLastLogMap(sortedRows, getDirection) {
  const lastByPerson = new Map();
  const lastLogByPerson = new Map();
  for (const r of sortedRows) {
    const dir = getDirection(r);
    if (dir !== "entry" && dir !== "exit") continue;
    const personId = r.person_id;
    const prev = lastByPerson.get(personId);
    if (prev === undefined && dir === "exit") continue;
    if (prev !== dir) {
      lastByPerson.set(personId, dir);
      lastLogByPerson.set(personId, r);
    }
  }
  const out = new Map();
  for (const [personId, r] of lastLogByPerson) {
    if (lastByPerson.get(personId) === "entry") out.set(personId, r);
  }
  return out;
}

function eventLabelFromDirection(dir) {
  if (dir === "entry") return "進入";
  if (dir === "exit") return "離開";
  return "失敗";
}

/** 進出紀錄：7 欄（與主表一致） */
function buildDetailSection(rows, doorNameMap, directionMap) {
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
      (a, b) => new Date(a.swip_card_rev_time) - new Date(b.swip_card_rev_time),
    );
    const getDirection = (r) => directionMap.get(Number(r.physical_id));
    const entryOnlyLast = getEntryOnlyLastLogMap(sorted, getDirection);
    for (const r of sorted) {
      const personId = r.person_id;
      const isEntryOnly = entryOnlyLast.has(personId);
      const lastEntryR = entryOnlyLast.get(personId);
      const physicalId = r.physical_id != null ? Number(r.physical_id) : null;
      const dir = directionMap.get(physicalId);
      result.push({
        設備截圖: r.snap_pic_url?.trim() ? "有" : "—",
        進場單位: (r.unit_name ?? "").trim() || "—",
        工號: "—",
        姓名: r.person_name ?? "—",
        事件: eventLabelFromDirection(dir),
        方式: "—",
        時間: formatDateTimeZhTW(r.swip_card_rev_time),
      });
    }
  }
  return result.sort((a, b) => (b.時間 || "").localeCompare(a.時間 || ""));
}

function transformPeopleCountingToReportFormat(
  rows,
  doorNameMap = new Map(),
  directionMap = new Map(),
) {
  if (!rows || rows.length === 0) {
    return {
      sections: [
        {
          title: "進出統計",
          headers: ["日期", "區域-地點", "進場人數", "出場人數", "在場人數"],
          rows: [],
        },
        {
          title: "單位統計",
          headers: [
            "日期",
            "區域-地點",
            "單位名稱",
            "進場人數",
            "出場人數",
            "在場人數",
          ],
          rows: [],
        },
        {
          title: "進出紀錄",
          headers: [...DETAIL_LOG_HEADERS],
          rows: [],
        },
      ],
    };
  }

  return {
    sections: [
      {
        title: "進出統計",
        headers: ["日期", "區域-地點", "進場人數", "出場人數", "在場人數"],
        rows: buildStatsSection(rows, directionMap),
      },
      {
        title: "單位統計",
        headers: [
          "日期",
          "區域-地點",
          "單位名稱",
          "進場人數",
          "出場人數",
          "在場人數",
        ],
        rows: buildUnitStatsSection(rows, directionMap),
      },
      {
        title: "進出紀錄",
        headers: [...DETAIL_LOG_HEADERS],
        rows: buildDetailSection(rows, doorNameMap, directionMap),
      },
    ],
  };
}

module.exports = {
  transformPeopleCountingToReportFormat,
};
