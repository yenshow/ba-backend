/**
 * 設備串流服務（以 deviceId 驅動，透過 MediaMTX 提供 WebRTC）
 */
const deviceService = require("./deviceService");
const mediaMTXService = require("../communication/mediaMTXService");
const logger = require("../../utils/logger").createLogger("Device Stream");

/**
 * 取得攝影機設備（非 camera 類型拋錯）
 * @param {number} deviceId
 * @returns {Promise<{ device: object }>}
 */
async function getCameraDevice(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  const typeCode = (device.type_code || "").toLowerCase();
  if (typeCode !== "camera") {
    const err = new Error("此設備並非攝影機類型");
    err.statusCode = 400;
    throw err;
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
    const err = new Error("此攝影機未設定 rtsp_url，無法啟動 WebRTC 串流");
    err.statusCode = 400;
    throw err;
  }
  return { device, rtspUrl };
}

/**
 * 啟動攝影機串流（MediaMTX add path）
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<{ streamId: string, pathName: string, webrtcUrl: string, status: string }>}
 */
async function startStream(deviceId) {
  const { device, rtspUrl } = await getCameraRtspUrl(deviceId);
  const pathName = mediaMTXService.pathNameFromDeviceId(deviceId);
  const { webrtcUrl } = await mediaMTXService.addPath(pathName, rtspUrl);
  logger.info("攝影機串流已啟動", { deviceId, deviceName: device.name, pathName });
  return {
    streamId: pathName,
    pathName,
    webrtcUrl,
    status: "running",
  };
}

/**
 * 停止攝影機串流（MediaMTX remove path）
 * @param {number} deviceId - 設備 ID
 */
async function stopStream(deviceId) {
  await getCameraDevice(deviceId);
  const pathName = mediaMTXService.pathNameFromDeviceId(deviceId);
  await mediaMTXService.removePath(pathName);
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
