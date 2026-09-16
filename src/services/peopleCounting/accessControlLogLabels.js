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

/** 設備 multipart「JSON 後接圖」僅人臉驗證事件帶抓拍；指紋／卡片等多為純 JSON */
const SUB_TYPES_WITH_SNAPSHOT = new Set([75, 76]);

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

/**
 * 解析門禁事件方向／標籤（僅依 device_id ∈ entry／exit）。
 * @param {number|null} sub
 * @param {{ deviceId?: number|null, entryDeviceIds?: Set<number>, exitDeviceIds?: Set<number> }} [opts]
 */
function resolveAccessControlEvent(sub, opts = {}) {
  if (sub != null && EVENT_LABEL_BY_SUB[sub]) {
    return { eventType: "failed", eventLabel: EVENT_LABEL_BY_SUB[sub] };
  }
  if (sub != null && FAIL_SUBS.has(sub)) {
    return { eventType: "failed", eventLabel: "失敗" };
  }

  const deviceId =
    opts.deviceId != null && Number.isFinite(Number(opts.deviceId))
      ? Number(opts.deviceId)
      : null;
  if (deviceId != null && deviceId > 0) {
    if (opts.entryDeviceIds instanceof Set && opts.entryDeviceIds.has(deviceId)) {
      return { eventType: "entry", eventLabel: "進入" };
    }
    if (opts.exitDeviceIds instanceof Set && opts.exitDeviceIds.has(deviceId)) {
      return { eventType: "exit", eventLabel: "離開" };
    }
  }
  // 無可靠歸屬時預設進場（與 transition 首筆 exit 忽略搭配）
  return { eventType: "entry", eventLabel: "進入" };
}

function resolveVerifyMethodKey(payload) {
  const sub = extractSubEventType(payload);
  if (sub == null) return null;
  if (sub === 2077 || sub === 2078 || sub === 2079) return "alcohol";
  return VERIFY_KEY_BY_SUB[sub] || null;
}

function resolveVerifyMethodLabel(payload) {
  const key = resolveVerifyMethodKey(payload);
  if (!key || key === "alcohol") return key === "alcohol" ? "酒精" : null;
  return VERIFY_LABEL[key] || null;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** 營運事件 payload.result：pass／fail */
function resolveOperationalAccessResult(payload) {
  const sub = extractSubEventType(payload);
  if (sub != null && FAIL_SUBS.has(sub)) return "fail";
  // 2078 飲酒、2079 醉酒；2077 酒精檢測正常仍為 pass
  if (sub === 2078 || sub === 2079) return "fail";
  return "pass";
}

/** 門禁 ISAPI payload 身分欄（message 與 payload 共用） */
function extractAccessEventIdentity(payload) {
  const ac = payload || {};
  return {
    personName: trimOrNull(ac.personName ?? ac.name),
    employeeNo: trimOrNull(ac.employeeNoString ?? ac.employeeNo),
    cardNo: trimOrNull(ac.cardNo),
  };
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

/** 門禁事件調閱跳窗文案（進入／離開／失敗） */
function resolveAccessEventPopupLabel(payload, { deviceRole } = {}) {
  const sub = extractSubEventType(payload);
  if (sub != null && (FAIL_SUBS.has(sub) || sub === 2078 || sub === 2079)) {
    return "失敗";
  }
  if (deviceRole === "exit") return "離開";
  return "進入";
}

/** 人臉驗證事件才帶抓拍（佔附圖單槽／顯示縮圖） */
function shouldQueueAccessEventPicture(payload) {
  const sub = extractSubEventType(payload);
  return sub != null && SUB_TYPES_WITH_SNAPSHOT.has(sub);
}

/** 顯示前：人臉事件且有 path 才回傳縮圖 URL */
function shouldDisplayAccessEventPicture(payload, picturePath) {
  const path = picturePath != null ? String(picturePath).trim() : "";
  if (!path) return false;
  return shouldQueueAccessEventPicture(payload);
}

module.exports = {
  extractSubEventType,
  extractAccessEventIdentity,
  resolveAccessControlEvent,
  resolveVerifyMethodKey,
  resolveVerifyMethodLabel,
  resolveOperationalAccessResult,
  resolveOperationalAccessSemantics,
  resolveAccessEventPopupLabel,
  shouldQueueAccessEventPicture,
  shouldDisplayAccessEventPicture,
  yscpEventLabel,
};
