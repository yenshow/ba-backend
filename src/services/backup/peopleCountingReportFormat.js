/**
 * YSCP 人流統計備份 CSV：與 UI 完整報表同三區塊／欄位（含圖片路徑）
 */
const {
  buildPeopleCountingReportSections,
} = require("./peopleCountingBackupSections");

function eventLabelFromDirection(dir) {
  if (dir === "entry") return "進入";
  if (dir === "exit") return "離開";
  return "失敗";
}

function transformPeopleCountingToReportFormat(
  rows,
  doorNameMap = new Map(),
  directionMap = new Map(),
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
  });
}

module.exports = {
  transformPeopleCountingToReportFormat,
};
