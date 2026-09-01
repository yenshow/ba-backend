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

module.exports = {
  FACE_MODELING_ERROR_MESSAGE,
  normalizeIsapiErrorMessage,
};
