/**
 * 門禁進出事件 → 調閱攝影機 ID（people_counting access_control 地點設定）
 */
const websocketService = require("../websocket/websocketService");
const {
  resolveAccessEventPopupLabel,
} = require("./accessControlLogLabels");

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

/**
 * @param {object|null|undefined} systemConfig - location_systems.system_config（snake 或 camel）
 * @param {'entry'|'exit'|null|undefined} deviceRole
 * @returns {number|null}
 */
function resolveEventCameraDeviceId(systemConfig, deviceRole) {
  const cfg =
    systemConfig && typeof systemConfig === "object" ? systemConfig : {};
  const dataSource = String(cfg.data_source ?? cfg.dataSource ?? "").trim();
  if (dataSource !== "access_control") return null;

  const role = String(deviceRole || "").trim();
  if (role === "entry") {
    return toPositiveInt(
      cfg.entry_event_camera_device_id ?? cfg.entryEventCameraDeviceId,
    );
  }
  if (role === "exit") {
    return toPositiveInt(
      cfg.exit_event_camera_device_id ?? cfg.exitEventCameraDeviceId,
    );
  }
  return null;
}

/**
 * @param {object} placeCtx - loadPlaceContextByAccessDeviceId 回傳
 * @returns {number|null}
 */
function resolveEventCameraFromPlaceContext(placeCtx) {
  if (!placeCtx) return null;
  return resolveEventCameraDeviceId(placeCtx.systemConfig, placeCtx.deviceRole);
}

/**
 * @param {object} placeCtx
 * @param {{ source?: 'isapi'|'manual', deviceId?: number|null, isapiPayload?: object|null, eventLabel?: string|null }} [options]
 */
function emitAccessControlEventFromPlaceContext(placeCtx, options = {}) {
  const source = options.source === "manual" ? "manual" : "isapi";
  let eventLabel = options.eventLabel;
  if (eventLabel == null || String(eventLabel).trim() === "") {
    if (source === "manual") {
      eventLabel = "手動開門";
    } else if (options.isapiPayload) {
      eventLabel = resolveAccessEventPopupLabel(options.isapiPayload, {
        deviceRole: placeCtx?.deviceRole,
      });
    }
  }

  websocketService.emitIsapiAccessEvent({
    source,
    locationId: placeCtx?.locationId ?? null,
    deviceId: options.deviceId ?? null,
    deviceRole: placeCtx?.deviceRole ?? null,
    eventCameraDeviceId: resolveEventCameraFromPlaceContext(placeCtx),
    zoneName: placeCtx?.zoneName,
    locationName: placeCtx?.locationName,
    eventLabel,
  });
}

module.exports = {
  resolveEventCameraDeviceId,
  resolveEventCameraFromPlaceContext,
  emitAccessControlEventFromPlaceContext,
};
