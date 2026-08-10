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

/** 與 mediamtx.yml pathDefaults 對齊（API replace 需顯式帶上） */
const PATH_DEFAULTS = {
  sourceOnDemand: true,
  rtspTransport: "tcp",
};

/** @returns {{ webrtcUrl: string, webrtcPort: number }} */
function buildWebrtcPlayback(pathName) {
  return {
    webrtcUrl: `/${pathName}/whep`,
    webrtcPort: config.mediaMTX?.webrtcPort ?? 8889,
  };
}

const api = axios.create({
  baseURL: API_BASE,
  timeout: TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

/** /v3/config 變更會 reload；序列化避免並發打斷 WebRTC */
let configMutationQueue = Promise.resolve();
const enqueueConfigMutation = (fn) => {
  const next = configMutationQueue.then(fn, fn);
  configMutationQueue = next.catch(() => {});
  return next;
};

const maskRtsp = (rtspUrl) => String(rtspUrl || "").replace(/:[^:@]+@/, ":***@");

const apiErrMsg = (err) =>
  err?.response?.data?.message ?? err?.response?.data?.error ?? err?.message ?? String(err);

/**
 * @param {number} deviceId
 * @returns {string}
 */
function pathNameFromDeviceId(deviceId) {
  return `device-${deviceId}`;
}

/**
 * 新增或更新 path（已存在則 replace）
 * @param {string} pathName
 * @param {string} rtspUrl
 * @returns {Promise<{ webrtcUrl: string, webrtcPort: number }>}
 */
async function addPath(pathName, rtspUrl) {
  const enc = encodeURIComponent(pathName);
  const body = { source: rtspUrl, ...PATH_DEFAULTS };
  const masked = maskRtsp(rtspUrl);

  await enqueueConfigMutation(async () => {
    try {
      await api.post(`/v3/config/paths/add/${enc}`, body);
      logger.info("MediaMTX path 已新增", { pathName, rtspUrl: masked });
      return;
    } catch (err) {
      const status = err.response?.status;
      const msg = apiErrMsg(err);
      const alreadyExists = status === 400 && /already exists/i.test(String(msg));

      if (alreadyExists) {
        try {
          await api.post(`/v3/config/paths/replace/${enc}`, body);
          logger.info("MediaMTX path 已更新", { pathName, rtspUrl: masked });
          return;
        } catch (replaceErr) {
          logger.error("MediaMTX replace path 失敗", { pathName, error: apiErrMsg(replaceErr) });
          throwApiError(
            C.MEDIAMTX_ADD_PATH_REJECTED,
            `MediaMTX 更新既有 path 失敗。詳情: ${apiErrMsg(replaceErr)}`,
          );
        }
      }

      logger.error("MediaMTX 新增 path 失敗", {
        pathName,
        status,
        message: msg,
        responseBody:
          typeof err.response?.data === "object"
            ? JSON.stringify(err.response.data)
            : String(err.response?.data ?? ""),
      });
      throwApiError(
        status === 400 ? C.MEDIAMTX_ADD_PATH_REJECTED : C.MEDIAMTX_ADD_PATH_FAILED,
        status === 400
          ? `MediaMTX 拒絕此設定 (400)。請檢查 RTSP URL（監看建議子碼流，海康常為 /Streaming/Channels/102）與帳密。詳情: ${msg}`
          : `MediaMTX 新增 path 失敗: ${msg}`,
      );
    }
  });

  return buildWebrtcPlayback(pathName);
}

/**
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
      const msg = apiErrMsg(err);
      logger.error("MediaMTX 移除 path 失敗", { pathName, error: msg });
      throwApiError(C.MEDIAMTX_REMOVE_PATH_FAILED, `MediaMTX 移除 path 失敗: ${msg}`);
    }
  });
}

/**
 * @returns {Promise<Array<{ name: string }>>}
 */
async function listPaths() {
  try {
    const res = await api.get("/v3/paths/list");
    const items = res.data?.items ?? [];
    return items.map((p) => ({ name: p.name ?? p }));
  } catch (err) {
    logger.warn("MediaMTX 取得 path 列表失敗", { error: apiErrMsg(err) });
    return [];
  }
}

module.exports = {
  PATH_DEFAULTS,
  pathNameFromDeviceId,
  addPath,
  removePath,
  listPaths,
  buildWebrtcPlayback,
};
