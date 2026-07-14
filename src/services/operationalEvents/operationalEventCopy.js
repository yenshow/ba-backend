/**
 * 營運事件顯示名稱／摘要文案（後端 SSOT）
 */
const { formatAcsEventDisplayName } = require("../ladderSdk/acsEventLabels");

const SOURCE_LABELS = {
  environment: "環境品質",
  lighting: "照明系統",
  hvac: "空調系統",
  drainage: "排水系統",
  air_circulation: "空氣循環",
  power: "電力系統",
  fire: "消防系統",
  smoke_alarm: "煙霧警報",
  emergency_rescue: "緊急求救",
  people_counting: "門禁管理",
  vehicle_access: "車輛進出",
  elevator: "電梯管理",
  alert_linkage: "警報連動",
};

const onOff = (v) => (v ? "開啟" : "關閉");

const sourceLabel = (source) => SOURCE_LABELS[source] || String(source || "系統");

const bitLabel = (bitKey, address) => {
  if (bitKey) return String(bitKey).toUpperCase();
  if (address != null) return `DO:${address}`;
  return "點位";
};

/** 狀態變化（DI/DO edge） */
const summaryStateChange = ({ source, bitKey, address, newValue }) =>
  `${sourceLabel(source)} ${bitLabel(bitKey, address)} → ${onOff(newValue)}`;

/** 人工／API 控制寫入 */
const summaryControlWrite = ({ source, bitKey, address, value, batchCount }) => {
  const label = sourceLabel(source);
  const point = bitLabel(bitKey ?? (address != null ? `do:${address}` : null), address);
  if (batchCount != null && batchCount > 1) {
    return `${label} 控制寫入 ${point} 起共 ${batchCount} 點`;
  }
  return `${label} 控制寫入 ${point} → ${onOff(value)}`;
};

/** 警報連動寫入（落庫為 control_write；以 source／文案辨識） */
const summaryLinkageWrite = ({ address, value, executionType }) => {
  const base = summaryControlWrite({
    source: "alert_linkage",
    address,
    bitKey: `do:${address}`,
    value,
  });
  return executionType ? `${base}（${executionType}）` : base;
};

/** 門禁 ISAPI */
const summaryAccessEvent = ({ personName }) => {
  const who = personName ? `：${personName}` : "";
  return `門禁事件${who}`;
};

/** 人流攝影機計數（呼叫端僅在 enter／exit delta > 0 時寫入） */
const summaryPeopleCounting = ({ regionName, enterDelta, exitDelta }) => {
  const region = regionName || "區域";
  if (enterDelta > 0) return `人流計數 ${region} 進場 +${enterDelta}`;
  return `人流計數 ${region} 出場 +${exitDelta}`;
};

/** 車輛過車 */
const summaryVehicle = ({ plate, laneType }) => {
  const dir =
    laneType === 1 ? " 進場" : laneType === 2 ? " 出場" : "";
  return plate ? `過車 ${plate}${dir}` : `過車事件${dir}`;
};

/** 電梯（顯示名與電梯頁 formatAcsEventDisplayName 對齊） */
const summaryElevator = ({ eventName, major, minor, floor }) => {
  const label =
    formatAcsEventDisplayName(eventName, major, minor) ||
    (eventName ? String(eventName) : null) ||
    `${major}/${minor}`;
  const floorHint =
    floor != null && floor !== "" ? `（${floor}）` : "";
  return `電梯：${label}${floorHint}`;
};

module.exports = {
  summaryStateChange,
  summaryControlWrite,
  summaryLinkageWrite,
  summaryAccessEvent,
  summaryPeopleCounting,
  summaryVehicle,
  summaryElevator,
};
