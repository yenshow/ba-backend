const FACE_MODELING_ERROR_MESSAGE =
  "設備無法從大頭照建立人臉模型，請改用清晰正臉單人照（320×320 方形 ≤200KB），或使用設備擷取人臉後重試";

function normalizeIsapiErrorMessage(raw) {
  const msg = raw != null ? String(raw) : "";
  if (!msg) return msg;
  if (
    /Unauthorized/i.test(msg) &&
    (/<statusValue>\s*401\s*<\/statusValue>/i.test(msg) || /\b401\b/.test(msg))
  ) {
    return "設備驗證失敗（401 Unauthorized），請確認帳密/權限";
  }
  if (/deviceBusy|Device Busy/i.test(msg)) {
    return "設備忙碌中（Device Busy），請稍後重試";
  }
  if (
    /SubpicAnalysisModelingError/i.test(msg) ||
    /saveFacePic/i.test(msg)
  ) {
    return FACE_MODELING_ERROR_MESSAGE;
  }
  return msg;
}

function isPermanentFaceModelingError(message) {
  const msg = message != null ? String(message) : "";
  if (!msg) return false;
  return (
    msg === FACE_MODELING_ERROR_MESSAGE ||
    /SubpicAnalysisModelingError/i.test(msg) ||
    /saveFacePic/i.test(msg)
  );
}

function isPermanentCardEmployeeNoError(message) {
  const msg = message != null ? String(message) : "";
  return /badJsonContent/i.test(msg) && /checkEmployeeNo/i.test(msg);
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "ERR_NETWORK",
  "ESOCKETTIMEDOUT",
]);

/**
 * 是否為設備／網路暫態錯誤（可重試）。業務永久錯（建模失敗、工號格式、401）不重試。
 * @param {unknown} errOrMessage
 */
function isTransientIsapiNetworkError(errOrMessage) {
  const err =
    errOrMessage && typeof errOrMessage === "object" ? errOrMessage : null;
  const msg =
    err?.message != null
      ? String(err.message)
      : errOrMessage != null
        ? String(errOrMessage)
        : "";
  if (!msg && !err?.code) return false;
  if (isPermanentFaceModelingError(msg) || isPermanentCardEmployeeNoError(msg)) {
    return false;
  }
  if (
    /Unauthorized/i.test(msg) &&
    (/<statusValue>\s*401\s*<\/statusValue>/i.test(msg) || /\b401\b/.test(msg))
  ) {
    return false;
  }
  const code = err?.code != null ? String(err.code) : "";
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/deviceBusy|Device Busy/i.test(msg)) return true;
  if (/timed?\s*out/i.test(msg)) return true;
  if (/network\s*error/i.test(msg)) return true;
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

function parseErrorBag(raw) {
  if (raw == null || raw === "") return {};
  const text = String(raw);
  if (!text.startsWith("{")) return { legacy: text };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return { legacy: text };
  }
  return { legacy: text };
}

/** 各步驟錯誤分開存，避免後續步驟覆寫前人臉／卡片的永久失敗原因。 */
function readStepErrorMessage(raw, step) {
  const bag = parseErrorBag(raw);
  if (typeof bag[step] === "string" && bag[step]) return bag[step];
  if (typeof bag.legacy === "string") return bag.legacy;
  return "";
}

function mergeStepErrorMessage(raw, step, message) {
  const bag = parseErrorBag(raw);
  delete bag.legacy;
  if (message) bag[step] = String(message);
  else delete bag[step];
  const keys = Object.keys(bag).filter((key) => bag[key]);
  if (!keys.length) return null;
  return JSON.stringify(bag);
}

module.exports = {
  FACE_MODELING_ERROR_MESSAGE,
  normalizeIsapiErrorMessage,
  isPermanentFaceModelingError,
  isPermanentCardEmployeeNoError,
  isTransientIsapiNetworkError,
  readStepErrorMessage,
  mergeStepErrorMessage,
};
