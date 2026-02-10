/**
 * 人流統計備份 CSV 報表格式
 * 含當日進場/出場人數統計，區域-地點、出入口設備名稱
 */

const { formatDateTimeZhTW, formatDateZhTW, formatZoneLocation } = require("./reportFormatUtils");

/** 依 physical_id + directionMap 計算進出場人數（同人連續同向只計一次，首筆為出場不計） */
function countEntryExitByDayLocation(rows, directionMap) {
  const sep = "\x00";
  const groups = new Map();
  for (const r of rows) {
    const dateStr = formatDateZhTW(r.swip_card_rev_time);
    const zoneLoc = formatZoneLocation(r.zone_name, r.location_name);
    const key = `${dateStr}${sep}${zoneLoc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const result = [];
  for (const [key, recs] of groups) {
    const idx = key.indexOf(sep);
    const dateStr = key.slice(0, idx);
    const zoneLoc = key.slice(idx + sep.length);
    const sorted = [...recs].sort((a, b) => new Date(a.swip_card_rev_time) - new Date(b.swip_card_rev_time));
    const lastByPerson = new Map();
    let entryCount = 0;
    let exitCount = 0;

    for (const rec of sorted) {
      const dir = directionMap.get(Number(rec.physical_id));
      if (dir !== "entry" && dir !== "exit") continue;
      const prev = lastByPerson.get(rec.person_id);
      if (prev === undefined && dir === "exit") continue;
      if (prev !== dir) {
        if (dir === "entry") entryCount++;
        else exitCount++;
        lastByPerson.set(rec.person_id, dir);
      }
    }

    result.push({
      日期: dateStr,
      "區域-地點": zoneLoc,
      進場人數: String(entryCount),
      出場人數: String(exitCount),
      人員ID: "",
      刷卡時間: "",
      出入口設備名稱: "",
      人員姓名: "",
      單位ID: "",
      單位名稱: "",
      方向: "",
    });
  }
  return result.sort((a, b) => a.日期.localeCompare(b.日期) || a["區域-地點"].localeCompare(b["區域-地點"]));
}

function transformPeopleCountingToReportFormat(rows, doorNameMap = new Map(), directionMap = new Map()) {
  const summaryRows = countEntryExitByDayLocation(rows, directionMap);
  const detailRows = rows.map((r) => {
    const physicalId = r.physical_id != null ? Number(r.physical_id) : null;
    const doorName = physicalId != null ? (doorNameMap.get(physicalId) ?? String(r.physical_id ?? "")) : "";
    const dir = directionMap.get(physicalId);
    const directionLabel = dir === "entry" ? "進場" : dir === "exit" ? "出場" : "";

    return {
      日期: "",
      "區域-地點": formatZoneLocation(r.zone_name, r.location_name),
      進場人數: "",
      出場人數: "",
      人員ID: String(r.person_id ?? ""),
      刷卡時間: formatDateTimeZhTW(r.swip_card_rev_time),
      出入口設備名稱: doorName,
      人員姓名: r.person_name ?? "",
      單位ID: String(r.unit_id ?? ""),
      單位名稱: r.unit_name ?? "",
      方向: directionLabel,
    };
  });

  return [...summaryRows, ...detailRows];
}

module.exports = {
  transformPeopleCountingToReportFormat,
};
