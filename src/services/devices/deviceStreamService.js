/**
 * 設備串流服務（以 deviceId 驅動，透過 MediaMTX 提供 WebRTC）
 */
const deviceService = require("./deviceService");
const mediaMTXService = require("../communication/mediaMTXService");
const logger = require("../../utils/logger").createLogger("Device Stream");
const mediaMTXConfigSyncService = require("../communication/mediaMTXConfigSyncService");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrorMeta");

// 同一台攝影機同時被多視窗/多分割要求 start 時，合併成單次啟動，避免並發 addPath 造成連續 reload
const startInFlightByDeviceId = new Map();

/**
 * 取得攝影機設備（非 camera 類型拋錯）
 * @param {number} deviceId
 * @returns {Promise<{ device: object }>}
 */
async function getCameraDevice(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  const typeCode = (device.type_code || "").toLowerCase();
  if (typeCode !== "camera") {
    throw createApiError(C.DEVICE_NOT_CAMERA, "此設備並非攝影機類型");
  }
  return { device };
}

/**
 * 取得攝影機的 rtsp_url（供 startStream 使用）
 * @param {number} deviceId
 * @returns {Promise<{ device: object, rtspUrl: string }>}
 */
async function getCameraRtspUrl(deviceId) {
  const { device } = await getCameraDevice(deviceId);
  const raw = (device.config?.rtsp_url || "").trim();
  const rtspUrl = raw.replace(/\r?\n/g, "").trim();
  if (!rtspUrl || !rtspUrl.toLowerCase().startsWith("rtsp://")) {
    throw createApiError(C.DEVICE_RTSP_URL_MISSING, "此攝影機未設定 rtsp_url，無法啟動 WebRTC 串流");
  }
  return { device, rtspUrl };
}

/**
 * 啟動攝影機串流（MediaMTX add path）
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<{ streamId: string, pathName: string, webrtcUrl: string, status: string }>}
 */
async function startStream(deviceId) {
  if (startInFlightByDeviceId.has(deviceId)) {
    return await startInFlightByDeviceId.get(deviceId);
  }

  const task = (async () => {
  const { device, rtspUrl } = await getCameraRtspUrl(deviceId);
  const pathName = mediaMTXService.pathNameFromDeviceId(deviceId);
  // 若 path 已存在，直接回覆 running，避免重複 addPath 造成 MediaMTX 多次 reload
  const webrtcUrl = `${mediaMTXService.WEBRTC_BASE}/${pathName}/whep`;

  const items = await mediaMTXService.listPaths();
  if (items.some((p) => p.name === pathName)) {
    logger.debug("攝影機串流已在運行中，略過重啟", { deviceId, deviceName: device.name, pathName });
    return {
      streamId: pathName,
      pathName,
      webrtcUrl,
      status: "running",
    };
  }

  // 理論上 paths 會在「新增/更新攝影機」時即同步到 MediaMTX；
  // 這裡保留容錯：若 path 不存在則補一次（避免現場因漏同步而 WHEP 400）
  await mediaMTXConfigSyncService.syncSingleCameraPath(deviceId, rtspUrl);
  logger.info("攝影機串流已同步（fallback）", { deviceId, deviceName: device.name, pathName });
  return {
    streamId: pathName,
    pathName,
    webrtcUrl,
    status: "running",
  };
  })();

  startInFlightByDeviceId.set(deviceId, task);
  try {
    return await task;
  } finally {
    startInFlightByDeviceId.delete(deviceId);
  }
}

/**
 * 停止攝影機串流（MediaMTX remove path）
 * @param {number} deviceId - 設備 ID
 */
async function stopStream(deviceId) {
  await getCameraDevice(deviceId);
  const pathName = mediaMTXService.pathNameFromDeviceId(deviceId);
  // 統一作法：停止不移除 path，避免頻繁 config 變更造成 reload。
  // sourceOnDemand 會在無人觀看後自動停止拉流；path 留著以支援多視窗穩定觀看。
  logger.debug("停止串流：略過 removePath（保留 path）", { deviceId, pathName });
  logger.info("攝影機串流已停止", { deviceId, pathName });
}

/**
 * 取得攝影機串流狀態（是否在 MediaMTX 中運行）
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<{ streamId: string, webrtcUrl: string, status: 'running'|'stopped' }>}
 */
async function getStreamStatus(deviceId) {
  await getCameraDevice(deviceId);
  const pathName = mediaMTXService.pathNameFromDeviceId(deviceId);
  const webrtcUrl = `${mediaMTXService.WEBRTC_BASE}/${pathName}/whep`;
  const items = await mediaMTXService.listPaths();
  const found = items.some((p) => p.name === pathName);
  return {
    streamId: pathName,
    webrtcUrl,
    status: found ? "running" : "stopped",
  };
}

module.exports = {
  startStream,
  stopStream,
  getStreamStatus,
  getCameraRtspUrl,
};
