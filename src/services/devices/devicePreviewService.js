/**
 * 設備 MJPEG 預覽 URL 服務
 * 依設備 config（host / isapi_preview_path）組出 ISAPI MJPEG 預覽 URL
 */
const deviceService = require("./deviceService");
const logger = require("../../utils/logger").createLogger("Device Preview");

const STREAM_TYPE_MJPEG = "mjpeg";

/**
 * 依設備 ID 取得 MJPEG 預覽 URL
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<{ url: string, streamType: string, deviceId: number, deviceName: string }>}
 * @throws 設備不存在或非攝影機或 config 不完整時拋錯
 */
async function getPreviewUrl(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId); // 不存在時 getDeviceById 會拋 404

  const typeCode = (device.type_code || "").toLowerCase();
  if (typeCode !== "camera") {
    const err = new Error("此設備並非攝影機類型，無法取得預覽 URL");
    err.statusCode = 400;
    throw err;
  }

  const config = device.config || {};
  const host = (config.host || config.ip_address || "").trim();
  const path = (config.isapi_preview_path || "").trim();

  if (!host) {
    const err = new Error("設備設定缺少 host 或 ip_address");
    err.statusCode = 400;
    throw err;
  }

  if (!path || !path.startsWith("/")) {
    const err = new Error("設備設定缺少有效的 isapi_preview_path（需以 / 開頭）");
    err.statusCode = 400;
    throw err;
  }

  // ISAPI 預覽使用 HTTP 預設 port 80，不組入 port
  const url = `http://${host}${path}`;

  logger.debug("取得預覽 URL", { deviceId, deviceName: device.name, url: url.replace(/:[^:@]+@/, ":***@") });

  return {
    url,
    streamType: STREAM_TYPE_MJPEG,
    deviceId: device.id,
    deviceName: device.name || "",
  };
}

module.exports = {
  getPreviewUrl,
  STREAM_TYPE_MJPEG,
};
