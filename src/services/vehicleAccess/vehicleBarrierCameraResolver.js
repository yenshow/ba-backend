/**
 * 車輛進出／手動開閘 → 跳圖攝影機（車牌機本身為 WebRTC 來源）
 */
const websocketService = require("../websocket/websocketService");

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

/**
 * @param {'entry'|'exit'|null|undefined} deviceRole
 * @returns {string}
 */
function resolveVehicleBarrierPopupLabel(deviceRole) {
  return String(deviceRole || "").trim() === "exit" ? "離開" : "進入";
}

/**
 * @param {object} placeCtx - loadPlaceContextByVehicleCameraDeviceId 回傳
 * @param {{
 *   source?: 'isapi_camera'|'manual',
 *   deviceId?: number|null,
 *   eventLabel?: string|null,
 *   locationIds?: number[]|null,
 *   eventTime?: string|null,
 * }} [options]
 */
function emitVehicleBarrierCameraEventFromPlaceContext(placeCtx, options = {}) {
  const source = options.source === "manual" ? "manual" : "isapi_camera";
  const deviceId = toPositiveInt(options.deviceId);
  let eventLabel = options.eventLabel;
  if (eventLabel == null || String(eventLabel).trim() === "") {
    eventLabel =
      source === "manual"
        ? "手動開閘"
        : resolveVehicleBarrierPopupLabel(placeCtx?.deviceRole);
  }

  const payload = {
    source,
    locationId: placeCtx?.locationId ?? null,
    deviceId,
    deviceRole: placeCtx?.deviceRole ?? null,
    eventCameraDeviceId: deviceId,
    zoneName: placeCtx?.zoneName,
    locationName: placeCtx?.locationName,
    eventLabel,
  };

  if (Array.isArray(options.locationIds) && options.locationIds.length > 0) {
    payload.locationIds = options.locationIds;
  }
  if (options.eventTime != null && String(options.eventTime).trim() !== "") {
    payload.eventTime = options.eventTime;
  }

  websocketService.emitVehicleAccessIsapiEvent(payload);
}

module.exports = {
  emitVehicleBarrierCameraEventFromPlaceContext,
};
