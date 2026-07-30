/**
 * 門禁 ISAPI（major=5）：依 subEventType／InfoList.minor 解析事件與驗證方式
 */

const EVENT_LABEL_BY_SUB = {
  2077: "酒精檢測正常",
  2078: "飲酒",
  2079: "醉酒",
};

const VERIFY_KEY_BY_SUB = {
  1: "card",
  9: "card",
  38: "fingerprint",
  39: "fingerprint",
  75: "face",
  76: "face",
};

const VERIFY_LABEL = { face: "人臉", card: "卡片", fingerprint: "指紋" };

const FAIL_SUBS = new Set([9, 39, 76]);

function extractSubEventType(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.subEventType;
  if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
  const list = payload.InfoList ?? payload.infoList;
  if (list == null) return null;
  const items = Array.isArray(list) ? list : [list];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const minor = item.minor ?? item.Minor;
    if (minor != null && Number.isFinite(Number(minor))) return Number(minor);
  }
  return null;
}

function resolveAccessControlEvent(sub, entryIps, exitIps, deviceIp) {
  if (sub != null && EVENT_LABEL_BY_SUB[sub]) {
    return { eventType: "failed", eventLabel: EVENT_LABEL_BY_SUB[sub] };
  }
  if (sub != null && FAIL_SUBS.has(sub)) {
    return { eventType: "failed", eventLabel: "失敗" };
  }
  const ip = deviceIp != null ? String(deviceIp) : "";
  const eventType = entryIps.has(ip) ? "entry" : exitIps.has(ip) ? "exit" : "entry";
  return {
    eventType,
    eventLabel: eventType === "entry" ? "進入" : "離開",
  };
}

function resolveVerifyMethodLabel(payload) {
  const sub = extractSubEventType(payload);
  if (sub == null) return null;
  const key = VERIFY_KEY_BY_SUB[sub];
  return key ? VERIFY_LABEL[key] : null;
}

function yscpEventLabel(eventType) {
  if (eventType === "entry") return "進入";
  if (eventType === "exit") return "離開";
  return "失敗";
}

/** 營運事件摘要用語意（subEventType + 進／出場設備角色） */
function resolveOperationalAccessSemantics(payload, { deviceRole } = {}) {
  const sub = extractSubEventType(payload);
  if (sub != null && EVENT_LABEL_BY_SUB[sub]) {
    return EVENT_LABEL_BY_SUB[sub];
  }
  const verify = resolveVerifyMethodLabel(payload);
  if (sub != null && FAIL_SUBS.has(sub)) {
    return verify ? `${verify}驗證失敗` : "驗證失敗";
  }
  const role =
    deviceRole === "entry" ? "進場" : deviceRole === "exit" ? "出場" : null;
  if (verify) {
    return role ? `${verify}通過（${role}）` : `${verify}通過`;
  }
  if (role) return role;
  return "門禁事件";
}

module.exports = {
  extractSubEventType,
  resolveAccessControlEvent,
  resolveVerifyMethodLabel,
  resolveOperationalAccessSemantics,
  yscpEventLabel,
};
