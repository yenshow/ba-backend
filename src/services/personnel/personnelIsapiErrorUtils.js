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
  readStepErrorMessage,
  mergeStepErrorMessage,
};
