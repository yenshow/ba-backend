/**
 * 營運事件顯示名稱／摘要文案（後端 SSOT）
 * message 只給人看；業務判斷請用 event_kind + payload。
 */
const { formatAcsEventDisplayName } = require("../ladderSdk/acsEventLabels");

/** statusPoints／業務鍵 → 中文標籤 */
const POINT_KEY_LABELS = {
  setpointC: "設定溫度",
  fanSpeed: "風速",
  temperatureC: "偵測溫度",
  isOn: "電源",
  power: "電源",
  running: "運轉",
};

/** 警報連動 DO executionType → 中文（括號顯示；payload 仍留英文） */
const LINKAGE_EXECUTION_LABELS = {
  trigger: "觸發",
  auto_off: "自動關",
  manual_trigger: "手動觸發",
  manual_revert: "手動復歸",
  rollover_revert: "日界線復歸",
};

/** 柵欄機 RemoteControl 指令 */
const BARRIER_CMD_LABEL = {
  open: "遠端開閘",
  close: "遠端關閘",
  lock: "柵欄上鎖",
  unlock: "柵欄解鎖",
};

/**
 * 層 1 對講 SDK／ISAPI 事件名 → 中文（未知不露出英文）
 * 鍵為小寫比對
 */
const INTERCOM_EVENT_LABELS = {
  changedcallstatus: "通話狀態變更",
  callrecordsevent: "通話紀錄",
  doorbell_ringing: "門鈴",
  dismiss_incoming_call: "拒接",
  unlock_record: "開鎖紀錄",
  noticedata_receipt: "公告回執",
  auth_info: "認證資訊",
  upload_plate: "上傳車牌",
  invalid_card: "無效卡片",
  send_card: "發卡",
  mask_detect: "口罩偵測",
  magnetic_door_status: "門磁狀態",
  zone_alarm: "防區警報",
  tamper: "防拆",
  duress: "脅迫",
  password_over_times: "密碼錯誤次數過多",
  door_not_open: "門未開",
  door_not_closed: "門未關",
  panic: "緊急",
  intercom_alarm: "對講警報",
  intercom: "對講事件",
  intercom_event: "對講事件",
  isapi_alarm: "對講警報",
};

const onOff = (v) => (v ? "開啟" : "關閉");

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

const formatLinkageExecutionLabel = (executionType) => {
  if (executionType == null || String(executionType).trim() === "") return null;
  const key = String(executionType).trim();
  return LINKAGE_EXECUTION_LABELS[key] || key;
};

/** 警報連動寫入（落庫為 control_write；以 source／文案辨識） */
const summaryLinkageWrite = ({
  address,
  value,
  executionType,
  placeLabel = null,
}) => {
  const base = summaryControlWrite({
    address,
    bitKey: `do:${address}`,
    value,
    pointKey: "isOn",
    placeLabel,
  });
  const execLabel = formatLinkageExecutionLabel(executionType);
  return execLabel ? `${base}（${execLabel}）` : base;
};

/** 門禁／柵欄遠端控制共用摘要 */
const summaryRemoteControlWrite = ({
  cmdLabels,
  defaultDeviceName,
  unknownCmdLabel,
  deviceName,
  cmd,
  success = true,
  errorMessage = null,
  placeLabel = null,
}) => {
  const name = deviceName || defaultDeviceName;
  const semantic = cmdLabels[cmd] || `${unknownCmdLabel} ${cmd}`;
  if (success) {
    return formatBusinessSummary({ placeLabel, action: semantic, detail: name });
  }
  const reason = errorMessage ? `（${String(errorMessage).slice(0, 120)}）` : "";
  return formatBusinessSummary({
    placeLabel,
    action: `${semantic}失敗`,
    detail: `${name}${reason}`,
  });
};

/** 門禁 RemoteControlDoor 控制寫入摘要 */
const ACCESS_DOOR_CMD_LABEL = {
  open: "遠端開門",
  close: "遠端關門",
  alwaysOpen: "門禁常開",
  alwaysClose: "門禁常關",
};

const summaryAccessDoorControlWrite = (opts) =>
  summaryRemoteControlWrite({
    cmdLabels: ACCESS_DOOR_CMD_LABEL,
    defaultDeviceName: "門禁設備",
    unknownCmdLabel: "門禁指令",
    ...opts,
  });

const summaryBarrierControlWrite = (opts) =>
  summaryRemoteControlWrite({
    cmdLabels: BARRIER_CMD_LABEL,
    defaultDeviceName: "車牌設備",
    unknownCmdLabel: "柵欄指令",
    ...opts,
  });

/**
 * 門禁 ISAPI 刷卡／人臉等
 * 句尾身分：姓名 → 工號；不用卡號（卡號只放 payload）
 */
const summaryAccessEvent = ({
  personName,
  employeeNo = null,
  placeLabel = null,
  action = null,
}) => {
  const name = personName != null ? String(personName).trim() : "";
  const emp = employeeNo != null ? String(employeeNo).trim() : "";
  const who = name || emp || null;
  return formatBusinessSummary({
    placeLabel,
    action: action || "門禁事件",
    detail: who,
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

/**
 * 車輛過車
 * allowResult === 0 → 過車拒絕；1 → 過車；其餘維持過車
 */
const summaryVehicle = ({ plate, laneType, placeLabel = null, allowResult = null }) => {
  const dir =
    laneType === 1 ? "進場" : laneType === 2 ? "出場" : null;
  const plateText = plate != null ? String(plate).trim() : "";
  const detail = plateText
    ? dir
      ? `${plateText} ${dir}`
      : plateText
    : dir || null;
  const denied = allowResult === 0 || allowResult === "0";
  return formatBusinessSummary({
    placeLabel,
    action: denied ? "過車拒絕" : "過車",
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

/**
 * 從層 1 bridge message 解析事件鍵（小寫）
 * 順序：eventName → summary 的 eventType= → category → type
 */
const resolveIntercomEventKey = (message = {}) => {
  const direct =
    message.eventName ||
    message.event_name ||
    null;
  if (direct != null && String(direct).trim() !== "") {
    return String(direct).trim();
  }
  const summary = message.summary != null ? String(message.summary) : "";
  const m = summary.match(/eventType=([^\s,]+)/i);
  if (m?.[1]) return m[1].trim();
  if (message.category != null && String(message.category).trim() !== "") {
    return String(message.category).trim();
  }
  if (message.type != null && String(message.type).trim() !== "") {
    return String(message.type).trim();
  }
  return null;
};

/** @returns {string} 中文標籤；未知 → 對講事件 */
const resolveIntercomEventLabel = (message = {}) => {
  const raw = resolveIntercomEventKey(message);
  if (!raw) return "對講事件";
  const key = String(raw).trim().toLowerCase();
  if (INTERCOM_EVENT_LABELS[key]) return INTERCOM_EVENT_LABELS[key];
  // 允許傳入已是中文的 action
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;
  return "對講事件";
};

/**
 * 對講層 1／層 2 摘要
 * @param {{ placeLabel?: string|null, action?: string|null, detail?: string|null, message?: object }}
 */
const summaryIntercom = ({
  placeLabel = null,
  action = null,
  detail = null,
  message = null,
} = {}) => {
  const act =
    action != null && String(action).trim() !== ""
      ? String(action).trim()
      : resolveIntercomEventLabel(message || {});
  return formatBusinessSummary({
    placeLabel,
    action: act,
    detail,
  });
};

module.exports = {
  POINT_KEY_LABELS,
  resolvePointLabel,
  formatBusinessSummary,
  formatLinkageExecutionLabel,
  resolveIntercomEventLabel,
  summaryStateChange,
  summaryControlWrite,
  summaryLinkageWrite,
  summaryAccessDoorControlWrite,
  summaryBarrierControlWrite,
  summaryAccessEvent,
  summaryPeopleCounting,
  summaryVehicle,
  summaryElevator,
  summaryIntercom,
};
