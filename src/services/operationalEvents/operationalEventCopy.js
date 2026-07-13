/**
 * 營運事件顯示名稱／摘要文案（後端 SSOT）
 */
const SOURCE_LABELS = {
  device: "設備",
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

/** 警報連動寫入 */
const summaryLinkageWrite = ({ address, value, executionType }) => {
  const typeHint = executionType ? `（${executionType}）` : "";
  return `警報連動寫入 DO:${address} → ${onOff(value)}${typeHint}`;
};

/** 門禁 ISAPI */
const summaryAccessEvent = ({ eventType, personName }) => {
  const who = personName ? `：${personName}` : "";
  return `門禁事件${who}`;
};

/** 人流攝影機計數 */
const summaryPeopleCounting = ({ regionName, enterDelta, exitDelta }) => {
  const region = regionName || "區域";
  if (enterDelta > 0) return `人流計數 ${region} 進場 +${enterDelta}`;
  if (exitDelta > 0) return `人流計數 ${region} 出場 +${exitDelta}`;
  return `人流計數 ${region} 讀數更新`;
};

/** 車輛過車 */
const summaryVehicle = ({ plate, laneType }) => {
  const dir =
    laneType === 1 ? " 進場" : laneType === 2 ? " 出場" : "";
  return plate ? `過車 ${plate}${dir}` : `過車事件${dir}`;
};

/** 電梯 */
const summaryElevator = ({ eventName, major, minor }) =>
  eventName
    ? `電梯：${eventName}`
    : `電梯事件 ${major}/${minor}`;

module.exports = {
  SOURCE_LABELS,
  sourceLabel,
  summaryStateChange,
  summaryControlWrite,
  summaryLinkageWrite,
  summaryAccessEvent,
  summaryPeopleCounting,
  summaryVehicle,
  summaryElevator,
};
