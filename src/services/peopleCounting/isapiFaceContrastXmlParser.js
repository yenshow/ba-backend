/**
 * ISAPI 人臉比對解析（現場 DeepinView：eventType=alarmResult）
 * - 有 candidate：落地比對結果（matched=true，後續再依地點準確度門檻標失敗）
 * - 無 candidate：落地為陌生人（matched=false），與設備本機「臉部比對結果」對齊
 * - deviceEventId：facePicID／snapFacePicID／UUID（對齊 SDK）；皆無則 snapPicURL path；勿用人臉庫 pid／畫面內 faceId
 */
const { toIsapiUrlPath } = require("../isapi/isapiEventBackfillCommon");

function firstOf(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function asArray(v) {
  return Array.isArray(v) ? v : v != null ? [v] : [];
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 設備常回 0~1；平台用 0~100 */
function normalizeSimilarityPercent(v) {
  const n = toNum(v);
  if (n == null) return null;
  if (n >= 0 && n <= 1) return Math.round(n * 1000) / 10;
  if (n > 1 && n <= 100) return Math.round(n * 10) / 10;
  return n;
}

/**
 * 事件級唯一鍵（對齊 SDK dwFacePicID／dwSnapFacePicID；可選 UUID；後備圖 path）
 * 不用畫面內 faceId、也不用臉庫 PID。
 */
function extractFaceDeviceEventIdFromObject(root, obj) {
  const sources = [root, obj].filter(Boolean);
  for (const src of sources) {
    const id = firstOf(
      src.facePicID,
      src.facePicId,
      src.snapFacePicID,
      src.snapFacePicId,
      src.UUID,
      src.uuid,
      src.targetID,
      src.targetId,
    );
    if (id) return id;
  }
  for (const src of sources) {
    for (const block of asArray(src?.alarmResult)) {
      for (const face of asArray(block?.faces)) {
        const id = firstOf(
          face.facePicID,
          face.facePicId,
          face.snapFacePicID,
          face.snapFacePicId,
          face.UUID,
          face.uuid,
        );
        if (id) return id;
      }
    }
  }
  for (const src of sources) {
    const path = toIsapiUrlPath(
      firstOf(
        src.snapPicURL,
        src.snapPicUrl,
        src.facePicURL,
        src.facePicUrl,
        src.pictureURL,
        src.pictureUrl,
      ),
    );
    if (path) return path;
    for (const block of asArray(src?.alarmResult)) {
      for (const face of asArray(block?.faces)) {
        const facePath = toIsapiUrlPath(
          firstOf(
            face.snapPicURL,
            face.facePicURL,
            face.pictureURL,
            face.pImage,
          ),
        );
        if (facePath) return facePath;
      }
    }
  }
  return null;
}

/**
 * 從 alarmResult[].faces[].identify[].candidate[] 取最佳候選人
 */
function extractBestCandidate(root) {
  let best = null;
  let bestScore = -1;

  for (const block of asArray(root?.alarmResult)) {
    for (const face of asArray(block?.faces)) {
      for (const idBlock of asArray(face?.identify)) {
        const maxSim = toNum(idBlock?.maxsimilarity ?? idBlock?.maxSimilarity);
        for (const cand of asArray(idBlock?.candidate)) {
          const reserve = cand?.reserve_field || cand?.reserveField || {};
          const humanData = asArray(cand?.human_data)[0] || {};
          const score =
            toNum(cand?.similarity) ??
            toNum(humanData.similarity) ??
            maxSim ??
            -1;
          if (score < bestScore) continue;
          bestScore = score;
          best = {
            similarity: score,
            personName: firstOf(reserve.name, cand.name, cand.personName),
            // 勿把 human_id（庫內序號）當工號
            employeeNo: firstOf(
              cand.customHumanID,
              cand.employeeNo,
              humanData.customHumanID,
              humanData.employeeNo,
            ),
            pid: firstOf(
              cand.PID,
              cand.pid,
              humanData.face_id,
              face?.faceId != null ? String(face.faceId) : null,
            ),
            certificateNumber: firstOf(
              reserve.certificateNumber,
              cand.certificateNumber,
            ),
            faceLibName: firstOf(cand.FDLibName, cand.faceLibName),
          };
        }
      }
    }
  }
  return best;
}

/** 是否至少有一張臉（空比對／陌生人仍可落地） */
function hasAlarmFaces(root) {
  for (const block of asArray(root?.alarmResult)) {
    if (asArray(block?.faces).length > 0) return true;
  }
  return false;
}

function parseFaceContrastEventPayload(raw) {
  if (raw == null) return null;
  const text = String(raw)
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const root = obj.EventNotificationAlert || obj;
  const eventType = firstOf(root.eventType, obj.eventType, "");
  if (String(eventType).toLowerCase() !== "alarmresult") return null;
  if (!root.alarmResult && !obj.alarmResult) return null;

  const eventTime = firstOf(
    root.dateTime,
    root.eventTime,
    obj.dateTime,
    obj.eventTime,
  );
  if (!eventTime) return null;

  const deviceEventId = extractFaceDeviceEventIdFromObject(root, obj);

  const base = {
    eventType: "alarmResult",
    eventTime,
    channelId: root.channelID ?? root.channelId ?? obj.channelID ?? null,
    deviceIp: firstOf(root.ipAddress, obj.ipAddress),
    deviceEventId,
  };

  const best = extractBestCandidate(root) || extractBestCandidate(obj);
  if (best) {
    return {
      ...base,
      similarity: normalizeSimilarityPercent(best.similarity),
      employeeNo: best.employeeNo || null,
      personName: best.personName || null,
      pid: best.pid || null,
      certificateNumber: best.certificateNumber || null,
      faceLibName: best.faceLibName || null,
      matched: true,
    };
  }

  // 無候選人：陌生人（需有 faces，避免空 heartbeat 誤落）
  if (!hasAlarmFaces(root) && !hasAlarmFaces(obj)) return null;
  return {
    ...base,
    similarity: null,
    employeeNo: null,
    personName: null,
    pid: null,
    certificateNumber: null,
    faceLibName: null,
    matched: false,
  };
}

module.exports = {
  parseFaceContrastEventPayload,
  normalizeSimilarityPercent,
  extractBestCandidate,
  extractFaceDeviceEventIdFromObject,
};
