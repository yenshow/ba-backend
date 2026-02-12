/**
 * 人流統計備份 CSV 報表格式
 * 與頁面一致：1. 進出統計（日期/區域-地點/進場人數/出場人數/人員ID/人員姓名/單位名稱/最後進場時間）
 *            2. 進出紀錄（區域-地點/人員ID/刷卡時間/出入口設備名稱/人員姓名/單位ID/單位名稱/方向）
 */

const {
  formatDateTimeZhTW,
  formatDateZhTW,
  formatZoneLocation,
} = require("./reportFormatUtils");
const { countEntryExitFromSorted } = require("../systems/peopleCountingService");

const sep = "\x00";

/** 依日期+區域分組 */
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

/** 當日依時間排序後，最後一筆為進場的人員（進場未出場），回傳其最後一筆的顯示列 */
function getEntryOnlyFromSorted(sortedRows, getDirection, dateStr, zoneLoc) {
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
  const result = [];
  for (const [personId, r] of lastLogByPerson) {
    if (lastByPerson.get(personId) !== "entry") continue;
    result.push({
      日期: dateStr,
      "區域-地點": zoneLoc,
      人員ID: String(r.person_id ?? ""),
      人員姓名: r.person_name ?? "",
      單位名稱: r.unit_name ?? "",
      最後進場時間: formatDateTimeZhTW(r.swip_card_rev_time),
    });
  }
  return result;
}

/** 進出統計區塊：每日每區一列統計 + 該日該區進場未出場人員列（8 欄） */
function buildSummarySection(rows, directionMap) {
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
    const { entryCount, exitCount } = countEntryExitFromSorted(sorted, getDirection);
    sectionRows.push({
      日期: dateStr,
      "區域-地點": zoneLoc,
      進場人數: String(entryCount),
      出場人數: String(exitCount),
      人員ID: "",
      人員姓名: "",
      單位名稱: "",
      最後進場時間: "",
    });
    const entryOnly = getEntryOnlyFromSorted(sorted, getDirection, dateStr, zoneLoc);
    sectionRows.push(...entryOnly);
  }
  return sectionRows;
}

/** 進出紀錄區塊：僅 8 欄（無日期、進場人數、出場人數） */
function buildDetailSection(rows, doorNameMap, directionMap) {
  return rows.map((r) => {
    const physicalId = r.physical_id != null ? Number(r.physical_id) : null;
    const doorName =
      physicalId != null
        ? (doorNameMap.get(physicalId) ?? String(r.physical_id ?? ""))
        : "";
    const dir = directionMap.get(physicalId);
    const directionLabel =
      dir === "entry" ? "進場" : dir === "exit" ? "出場" : "";
    return {
      "區域-地點": formatZoneLocation(r.zone_name, r.location_name),
      人員ID: String(r.person_id ?? ""),
      刷卡時間: formatDateTimeZhTW(r.swip_card_rev_time),
      出入口設備名稱: doorName,
      人員姓名: r.person_name ?? "",
      單位ID: String(r.unit_id ?? ""),
      單位名稱: r.unit_name ?? "",
      方向: directionLabel,
    };
  });
}

/**
 * 轉換為與頁面一致的兩段報表
 * @returns {{ sections: Array<{ title: string, headers: string[], rows: Object[] }> }}
 */
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
          headers: [
            "日期",
            "區域-地點",
            "進場人數",
            "出場人數",
            "人員ID",
            "人員姓名",
            "單位名稱",
            "最後進場時間",
          ],
          rows: [],
        },
        {
          title: "進出紀錄",
          headers: [
            "區域-地點",
            "人員ID",
            "刷卡時間",
            "出入口設備名稱",
            "人員姓名",
            "單位ID",
            "單位名稱",
            "方向",
          ],
          rows: [],
        },
      ],
    };
  }

  const summaryHeaders = [
    "日期",
    "區域-地點",
    "進場人數",
    "出場人數",
    "人員ID",
    "人員姓名",
    "單位名稱",
    "最後進場時間",
  ];
  const detailHeaders = [
    "區域-地點",
    "人員ID",
    "刷卡時間",
    "出入口設備名稱",
    "人員姓名",
    "單位ID",
    "單位名稱",
    "方向",
  ];

  return {
    sections: [
      {
        title: "進出統計",
        headers: summaryHeaders,
        rows: buildSummarySection(rows, directionMap),
      },
      {
        title: "進出紀錄",
        headers: detailHeaders,
        rows: buildDetailSection(rows, doorNameMap, directionMap),
      },
    ],
  };
}

module.exports = {
  transformPeopleCountingToReportFormat,
};
