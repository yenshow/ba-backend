/**
 * 車牌攝影機 ISAPI 代理：設備端名單 CRUD、柵欄機狀態／控制
 */
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { createApiError, throwApiError } = require("../../utils/apiErrorMeta");
const { parseConfig } = require("./vehicleAccessValidation");
const { ensureIntArray } = require("../location/locationShared");
const {
  parseLicensePlateSearchResult,
  parseBarrierGateStatus,
  normalizeListTypeToApi,
  normalizeListTypeToDevice,
} = require("./isapiVehicleTrafficXmlParser");

const VALID_CTRL_MODES = new Set(["open", "close", "lock", "unlock"]);
const VALID_OPERATION_TYPES = new Set(["add", "modify"]);

function formatIsapiTime(date = new Date()) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "");
}

function resolveChannelId(channelId) {
  const n = Number(channelId);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

function buildTrafficPath(channelId, suffix) {
  const ch = resolveChannelId(channelId);
  return `/ISAPI/Traffic/channels/${ch}${suffix}`;
}

function buildParkingPath(channelId, suffix) {
  const ch = resolveChannelId(channelId);
  return `/ISAPI/Parking/channels/${ch}${suffix}`;
}

function responseBodyToString(data) {
  if (data == null) return "";
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

async function getCameraDeviceAndClient(deviceId) {
  const { device } = await deviceService.getDeviceById(deviceId);
  if (String(device?.type_code || "").toLowerCase() !== "camera") {
    throw createApiError(C.VEHICLE_ACCESS_NOT_CAMERA, "該設備不是攝影機");
  }
  if (
    !device?.config?.host ||
    !device?.config?.username ||
    !device?.config?.password
  ) {
    throw createApiError(
      C.VEHICLE_ACCESS_CONFIG_INCOMPLETE,
      "攝影機連線設定不完整",
    );
  }
  return { device, client: createIsapiClient(device.config) };
}

/**
 * 可選：驗證 deviceId 屬於 ISAPI 車輛地點的入口／出口攝影機
 * @param {number} deviceId
 * @param {number|null|undefined} siteId - locations.id
 */
async function assertDeviceBelongsToSite(deviceId, siteId) {
  if (siteId == null || siteId === "") return;
  const locationId = Number(siteId);
  if (!Number.isFinite(locationId)) {
    throwApiError(C.BAD_REQUEST, "siteId 無效");
  }
  const rows = await db.query(
    `
      SELECT system_config
      FROM location_systems
      WHERE location_id = ? AND system_type = 'vehicle_access'
      LIMIT 1
    `,
    [locationId],
  );
  const cfg = parseConfig(rows?.[0]?.system_config);
  if (cfg.dataSource !== "isapi_camera") {
    throw createApiError(
      C.VEHICLE_ACCESS_DEVICE_NOT_IN_SITE,
      "該地點不是 ISAPI 車牌攝影機資料來源",
    );
  }
  const allowed = new Set([
    ...ensureIntArray(cfg.entryCameraDeviceIds),
    ...ensureIntArray(cfg.exitCameraDeviceIds),
  ]);
  if (!allowed.has(Number(deviceId))) {
    throw createApiError(
      C.VEHICLE_ACCESS_DEVICE_NOT_IN_SITE,
      "設備不屬於此地點的入口或出口攝影機",
    );
  }
}

function buildSearchXml(searchResultPosition, maxResults) {
  const pos = Math.max(0, Number(searchResultPosition) || 0);
  const max = Math.min(500, Math.max(1, Number(maxResults) || 100));
  return `<?xml version="1.0" encoding="UTF-8"?>
<LPListAuditSearchDescription version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <searchID>2371AE29-A821-4F7D-827D-E84B6A029EFB</searchID>
    <searchResultPosition>${pos}</searchResultPosition>
    <maxResults>${max}</maxResults>
</LPListAuditSearchDescription>`;
}

function buildBarrierControlXml(ctrlMode) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<BarrierGate xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <ctrlMode>${ctrlMode}</ctrlMode>
</BarrierGate>`;
}

/**
 * @param {number} deviceId
 * @param {object} options
 */
async function searchLicensePlates(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const { client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildTrafficPath(channelId, "/searchLPListAudit");
  const xml = buildSearchXml(options.searchResultPosition, options.maxResults);
  const res = await client.request({
    method: "POST",
    path,
    data: xml,
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });
  const body = responseBodyToString(res.data);
  const parsed = parseLicensePlateSearchResult(body);
  return {
    channelId,
    ...parsed,
  };
}

/**
 * @param {number} deviceId
 * @param {object} options - { channelId, siteId, plates: Array }
 */
async function upsertLicensePlates(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const plates = Array.isArray(options.plates) ? options.plates : [];
  if (plates.length === 0) {
    throwApiError(C.BAD_REQUEST, "請提供 plates 陣列");
  }

  const { client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildTrafficPath(
    channelId,
    "/licensePlateAuditData/record?format=json",
  );

  const licensePlateInfoList = plates.map((p) => {
    const licensePlate = String(p.licensePlate || p.id || "").trim();
    if (!licensePlate) {
      throwApiError(C.BAD_REQUEST, "每筆車牌需提供 licensePlate 或 id");
    }
    const operationType = String(p.operationType || "add").toLowerCase();
    if (!VALID_OPERATION_TYPES.has(operationType)) {
      throwApiError(C.BAD_REQUEST, "operationType 須為 add 或 modify");
    }
    const listType = normalizeListTypeToDevice(p.listType || "allowList");
    const id = String(p.id || licensePlate).trim();
    const createTime = p.createTime || formatIsapiTime();
    const effectiveTime =
      p.effectiveTime ||
      formatIsapiTime(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));

    return {
      id,
      listType,
      LicensePlate: licensePlate,
      createTime,
      effectiveTime,
      operationType,
    };
  });

  await client.request({
    method: "PUT",
    path,
    data: { LicensePlateInfoList: licensePlateInfoList },
  });

  return { success: true, channelId, count: licensePlateInfoList.length };
}

/**
 * @param {number} deviceId
 * @param {object} options
 */
async function deleteLicensePlates(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const plates = Array.isArray(options.licensePlates)
    ? options.licensePlates
    : [];
  const normalized = plates.map((p) => String(p || "").trim()).filter(Boolean);
  if (normalized.length === 0) {
    throwApiError(C.BAD_REQUEST, "請提供 licensePlates 陣列");
  }

  const { client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildTrafficPath(
    channelId,
    "/DelLicensePlateAuditData?format=json",
  );

  await client.request({
    method: "PUT",
    path,
    data: { licensePlate: normalized },
  });

  return { success: true, channelId, count: normalized.length };
}

async function getBarrierGateStatus(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const { client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildParkingPath(channelId, "/barrierGate/barrierGateStatus");
  const res = await client.request({
    method: "GET",
    path,
    responseType: "text",
  });
  const body = responseBodyToString(res.data);
  const parsed = parseBarrierGateStatus(body);
  return { channelId, ...parsed };
}

async function controlBarrierGate(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const ctrlMode = String(options.ctrlMode || "")
    .trim()
    .toLowerCase();
  if (!VALID_CTRL_MODES.has(ctrlMode)) {
    throwApiError(C.BAD_REQUEST, "ctrlMode 須為 open、close、lock 或 unlock");
  }

  const { client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildParkingPath(channelId, "/barrierGate");
  await client.request({
    method: "PUT",
    path,
    data: buildBarrierControlXml(ctrlMode),
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });

  return { success: true, channelId, ctrlMode };
}

module.exports = {
  resolveChannelId,
  searchLicensePlates,
  upsertLicensePlates,
  deleteLicensePlates,
  getBarrierGateStatus,
  controlBarrierGate,
  normalizeListTypeToApi,
};
