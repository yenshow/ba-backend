/**
 * MediaMTX 管理服務（RTSP ingest + WebRTC 分發）
 * 依 deviceId 對應單一 path，呼叫 Control API 增刪 path，回傳 webrtcUrl 給前端
 */
const axios = require("axios");
const config = require("../../config");
const logger = require("../../utils/logger").createLogger("MediaMTX");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");

const API_BASE = (config.mediaMTX?.apiBaseUrl ?? "http://127.0.0.1:9997").replace(/\/$/, "");
const TIMEOUT_MS = config.mediaMTX?.timeoutMs ?? 10000;

/** @returns {{ webrtcUrl: string, webrtcPort: number }} */
function buildWebrtcPlayback(pathName) {
  const whepPath = `/${pathName}/whep`;
  return {
    webrtcUrl: whepPath,
    webrtcPort: config.mediaMTX?.webrtcPort ?? 8889,
  };
}

const api = axios.create({
  baseURL: API_BASE,
  timeout: TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

/**
 * MediaMTX 的 /v3/config 變更會觸發 reload。
 * 多視窗/多分割同時啟動多台時，若並發呼叫 add/remove path，
 * 會造成同一秒連續 reload，進而中斷剛建立的 WebRTC session。
 * 因此把 config 變更統一排隊（全域序列化）。
 */
let configMutationQueue = Promise.resolve();
const enqueueConfigMutation = (fn) => {
  const run = async () => await fn();
  const next = configMutationQueue.then(run, run);
  // 防止 rejected 讓 queue 中斷
  configMutationQueue = next.catch(() => {});
  return next;
};

/**
 * 由 deviceId 產生 MediaMTX path 名稱（唯一、URL 安全）
 * @param {number} deviceId
 * @returns {string}
 */
function pathNameFromDeviceId(deviceId) {
  return `device-${deviceId}`;
}

/**
 * 新增 path（MediaMTX 向攝影機拉 RTSP）
 * @param {string} pathName - path 名稱（例：device-14）
 * @param {string} rtspUrl - 完整 RTSP URL（H.264 建議）
 * @returns {Promise<{ webrtcUrl: string }>}
 */
async function addPath(pathName, rtspUrl) {
  const url = `/v3/config/paths/add/${encodeURIComponent(pathName)}`;
  const body = {
    source: rtspUrl,
    sourceOnDemand: true,
  };
  const doAdd = async () => {
    await api.post(url, body);
    logger.info("MediaMTX path 已新增", { pathName, rtspUrl: rtspUrl.replace(/:[^:@]+@/, ":***@") });
  };

  await enqueueConfigMutation(async () => {
    try {
      await doAdd();
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const msg = data?.message ?? data?.error ?? err.message;
      const detail = typeof data === "object" ? JSON.stringify(data) : String(data);
      logger.error("MediaMTX 新增 path 失敗", {
        pathName,
        status,
        message: msg,
        responseBody: detail,
      });
      if (status === 400) {
        try {
          await api.delete(`/v3/config/paths/delete/${encodeURIComponent(pathName)}`);
          logger.info("MediaMTX 已移除既有 path，重試新增", { pathName });
          await doAdd();
        } catch (retryErr) {
          const retryMsg =
            retryErr.response?.data?.message ?? retryErr.response?.data?.error ?? retryErr.message;
          throwApiError(
            C.MEDIAMTX_ADD_PATH_REJECTED,
            `MediaMTX 拒絕此設定 (400)。請檢查 RTSP URL 是否正確、路徑是否完整（海康威視常見：/Streaming/Channels/101 或 /102），以及帳密是否正確。詳情: ${retryMsg}`,
          );
        }
      } else {
        throwApiError(C.MEDIAMTX_ADD_PATH_FAILED, `MediaMTX 新增 path 失敗: ${msg}`);
      }
    }
  });
  return buildWebrtcPlayback(pathName);
}

/**
 * 移除 path
 * @param {string} pathName
 */
async function removePath(pathName) {
  const url = `/v3/config/paths/delete/${encodeURIComponent(pathName)}`;
  await enqueueConfigMutation(async () => {
    try {
      await api.delete(url);
      logger.info("MediaMTX path 已移除", { pathName });
    } catch (err) {
      if (err.response?.status === 404) {
        logger.debug("MediaMTX path 不存在，略過移除", { pathName });
        return;
      }
      const msg = err.response?.data?.message ?? err.message;
      logger.error("MediaMTX 移除 path 失敗", { pathName, error: msg });
      throwApiError(C.MEDIAMTX_REMOVE_PATH_FAILED, `MediaMTX 移除 path 失敗: ${msg}`);
    }
  });
}

/**
 * 列出目前 path（用於查詢是否在播）
 * @returns {Promise<Array<{ name: string }>>}
 */
async function listPaths() {
  try {
    const res = await api.get("/v3/paths/list");
    const items = res.data?.items ?? [];
    return items.map((p) => ({ name: p.name ?? p }));
  } catch (err) {
    const msg = err.response?.data?.message ?? err.message;
    logger.warn("MediaMTX 取得 path 列表失敗", { error: msg });
    return [];
  }
}

module.exports = {
  pathNameFromDeviceId,
  addPath,
  removePath,
  listPaths,
  buildWebrtcPlayback,
};
