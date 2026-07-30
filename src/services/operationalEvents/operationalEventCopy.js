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
  /** @deprecated 歷史列；新寫入已改 people_counting */
  access_control: "門禁管理",
  vehicle_access: "車輛進出",
  elevator: "電梯管理",
  alert_linkage: "警報連動",
};

/** statusPoints／業務鍵 → 中文標籤 */
const POINT_KEY_LABELS = {
  setpointC: "設定溫度",
  fanSpeed: "風速",
  temperatureC: "偵測溫度",
  isOn: "電源",
  power: "電源",
  running: "運轉",
};

const onOff = (v) => (v ? "開啟" : "關閉");

const sourceLabel = (source) => SOURCE_LABELS[source] || String(source || "系統");

const bitLabel = (bitKey, address) => {
  if (bitKey) return String(bitKey).toUpperCase();
  if (address != null) return `DO:${address}`;
  return "點位";
};

/**
 * @param {string|null|undefined} pointKey
 * @param {string|null|undefined} bitKey
 * @param {number|null|undefined} address
 * @param {'coil'|'holding'|string} [registerType]
 */
const resolvePointLabel = (pointKey, bitKey, address, registerType = "coil") => {
  if (pointKey && POINT_KEY_LABELS[pointKey]) return POINT_KEY_LABELS[pointKey];
  if (pointKey) return String(pointKey);
  const bk = bitKey != null ? String(bitKey).toLowerCase() : "";
  if (bk === "do" || bk.startsWith("do:")) return "電源";
  if (bk === "di" || bk.startsWith("di:")) return bitLabel(bitKey, address);
  if (registerType === "holding") {
    return address != null ? `AO:${address}` : "AO";
  }
  return bitLabel(bitKey, address);
};

const formatPlacePrefix = (placeLabel) => {
  const p = placeLabel != null ? String(placeLabel).trim() : "";
  return p ? `${p}：` : "";
};

/** `{區域} - {地點}：{語意} → {細節}`（系統名由 UI badge 顯示，摘要不含） */
const formatBusinessSummary = ({ placeLabel, action, detail = null }) => {
  const place = formatPlacePrefix(placeLabel);
  const act = action != null ? String(action).trim() : "";
  if (!act) return place ? `${place}事件` : "事件";
  const tail = detail != null && String(detail).trim() !== "" ? ` → ${detail}` : "";
  return `${place}${act}${tail}`;
};

/** 狀態變化（DI/DO edge） */
const summaryStateChange = ({
  source,
  bitKey,
  address,
  newValue,
  placeLabel = null,
  pointKey = null,
  pointLabel = null,
}) => {
  const point =
    pointLabel ||
    resolvePointLabel(pointKey, bitKey, address, "coil");
  return `${formatPlacePrefix(placeLabel)}${point} → ${onOff(newValue)}`;
};

/**
 * 人工／API 控制寫入
 * - coil／DO：value 為 boolean → 開啟／關閉
 * - holding／AO：value 為數值 → 顯示寫入值（可已套 scale）
 * 格式：`{區域} - {地點}：{語意點} → {值}`（系統名由 UI badge 顯示）
 */
const summaryControlWrite = ({
  source,
  bitKey,
  address,
  value,
  batchCount,
  registerType = "coil",
  placeLabel = null,
  pointKey = null,
  pointLabel = null,
}) => {
  const isHolding = registerType === "holding";
  const point =
    pointLabel ||
    resolvePointLabel(pointKey, bitKey, address, registerType);
  const place = formatPlacePrefix(placeLabel);

  if (batchCount != null && batchCount > 1) {
    return `${place}${point} 起共 ${batchCount} 點`;
  }
  if (isHolding) {
    return `${place}${point} → ${value}`;
  }
  return `${place}${point} → ${onOff(value)}`;
};

/** 警報連動寫入（落庫為 control_write；以 source／文案辨識） */
const summaryLinkageWrite = ({ address, value, executionType }) => {
  const base = summaryControlWrite({
    source: "alert_linkage",
    address,
    bitKey: `do:${address}`,
    value,
    pointKey: "isOn",
  });
  return executionType ? `${base}（${executionType}）` : base;
};

/** 門禁 RemoteControlDoor 控制寫入摘要 */
const ACCESS_DOOR_CMD_LABEL = {
  open: "遠端開門",
  close: "遠端關門",
  alwaysOpen: "門禁常開",
  alwaysClose: "門禁常關",
};

const summaryAccessDoorControlWrite = ({
  deviceName,
  cmd,
  success = true,
  errorMessage = null,
  fromAlertLinkage = false,
  placeLabel = null,
}) => {
  const name = deviceName || "門禁設備";
  const semantic = ACCESS_DOOR_CMD_LABEL[cmd] || `門禁指令 ${cmd}`;
  if (success) {
    return formatBusinessSummary({
      placeLabel,
      action: semantic,
      detail: name,
    });
  }
  const reason = errorMessage ? `（${String(errorMessage).slice(0, 120)}）` : "";
  return formatBusinessSummary({
    placeLabel,
    action: `${semantic}失敗`,
    detail: `${name}${reason}`,
  });
};

/** 門禁 ISAPI 刷卡／人臉等 */
const summaryAccessEvent = ({ personName, placeLabel = null, action = null }) => {
  const who = personName != null ? String(personName).trim() : "";
  return formatBusinessSummary({
    placeLabel,
    action: action || "門禁事件",
    detail: who || null,
  });
};

/** 人流攝影機計數（呼叫端僅在 enter／exit delta > 0 時寫入） */
const summaryPeopleCounting = ({
  regionName,
  enterDelta,
  exitDelta,
  placeLabel = null,
}) => {
  const region = regionName || "區域";
  if (enterDelta > 0) {
    return formatBusinessSummary({
      placeLabel,
      action: `人流計數 ${region}`,
      detail: `進場 +${enterDelta}`,
    });
  }
  return formatBusinessSummary({
    placeLabel,
    action: `人流計數 ${region}`,
    detail: `出場 +${exitDelta}`,
  });
};

/** 車輛過車 */
const summaryVehicle = ({ plate, laneType, placeLabel = null }) => {
  const dir =
    laneType === 1 ? "進場" : laneType === 2 ? "出場" : null;
  const plateText = plate != null ? String(plate).trim() : "";
  const detail = plateText
    ? dir
      ? `${plateText} ${dir}`
      : plateText
    : dir || null;
  return formatBusinessSummary({
    placeLabel,
    action: "過車",
    detail,
  });
};

/** 電梯（顯示名與電梯頁 formatAcsEventDisplayName 對齊） */
const summaryElevator = ({
  eventName,
  major,
  minor,
  floor,
  placeLabel = null,
}) => {
  const label =
    formatAcsEventDisplayName(eventName, major, minor) ||
    (eventName ? String(eventName) : null) ||
    `${major}/${minor}`;
  const floorHint =
    floor != null && floor !== "" ? String(floor).trim() : null;
  return formatBusinessSummary({
    placeLabel,
    action: label,
    detail: floorHint,
  });
};

module.exports = {
  POINT_KEY_LABELS,
  resolvePointLabel,
  formatBusinessSummary,
  summaryStateChange,
  summaryControlWrite,
  summaryLinkageWrite,
  summaryAccessDoorControlWrite,
  summaryAccessEvent,
  summaryPeopleCounting,
  summaryVehicle,
  summaryElevator,
};
