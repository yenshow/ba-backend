/**
 * ISAPI 人臉比對解析（現場 DeepinView：eventType=alarmResult）
 * 僅認有 candidate 的比對結果。
 */

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

  const best = extractBestCandidate(root) || extractBestCandidate(obj);
  // 無比對候選人：不落地（略過空 alarm／純抓拍）
  if (!best) return null;

  return {
    eventType: "alarmResult",
    eventTime: firstOf(
      root.dateTime,
      root.eventTime,
      obj.dateTime,
      obj.eventTime,
    ),
    channelId: root.channelID ?? root.channelId ?? obj.channelID ?? null,
    deviceIp: firstOf(root.ipAddress, obj.ipAddress),
    similarity: normalizeSimilarityPercent(best.similarity),
    employeeNo: best.employeeNo || null,
    personName: best.personName || null,
    pid: best.pid || null,
    certificateNumber: best.certificateNumber || null,
    faceLibName: best.faceLibName || null,
    matched: true,
  };
}

module.exports = {
  parseFaceContrastEventPayload,
  normalizeSimilarityPercent,
};
