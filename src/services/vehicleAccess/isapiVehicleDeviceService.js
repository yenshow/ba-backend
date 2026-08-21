/**
 * 車牌攝影機 ISAPI 代理：設備端名單 CRUD、柵欄機控制
 */
const deviceService = require("../devices/deviceService");
const { createIsapiClient } = require("../accessControl/isapiClient");
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { createApiError, throwApiError } = require("../../utils/apiErrors");
const { parseConfig } = require("./vehicleAccessConfig");
const { ensureIntArray } = require("../location/locationShared");
const {
  parseLicensePlateSearchResult,
  normalizeListTypeToApi,
  normalizeListTypeToDevice,
} = require("./isapiVehicleXmlParser");
const {
  loadPlaceContextByVehicleCameraDeviceId,
} = require("../operationalEvents/operationalEventPlaceContext");
const {
  emitVehicleBarrierCameraEventFromPlaceContext,
} = require("./vehicleBarrierCameraResolver");

const VALID_CTRL_MODES = new Set(["open", "close", "lock", "unlock"]);
const VALID_OPERATION_TYPES = new Set(["add", "modify"]);
const MODEL_46_G0 = "YS-46-G0";
const IO_TRIGGER_PATH = "/ISAPI/System/IO/outputs/1/trigger";
const IO_PULSE_MS = 3000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function responseBodyToString(data) {
  if (data == null) return "";
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

function isYs46G0Model(modelName) {
  return String(modelName || "")
    .trim()
    .toUpperCase()
    .includes(MODEL_46_G0);
}

function buildParkingBarrierPath(channelId) {
  return `/ISAPI/Parking/channels/${resolveChannelId(channelId)}/barrierGate`;
}

function buildBarrierControlXml(ctrlMode) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<BarrierGate xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <ctrlMode>${ctrlMode}</ctrlMode>
</BarrierGate>`;
}

function buildIoTriggerXml(outputState) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<IOPortData>
    <outputState>${outputState}</outputState>
</IOPortData>`;
}

async function putIoOutputState(client, outputState) {
  await client.request({
    method: "PUT",
    path: IO_TRIGGER_PATH,
    data: buildIoTriggerXml(outputState),
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });
}

/**
 * YS-46-G0：IO outputs/1/trigger（high=常開、low=常關；open/close 為脈衝）
 */
async function controlYs46G0Barrier(client, ctrlMode) {
  switch (ctrlMode) {
    case "open":
      await putIoOutputState(client, "high");
      await delay(IO_PULSE_MS);
      await putIoOutputState(client, "low");
      break;
    case "close":
      // 現場需求：關閉後維持常關（low），不可再回送 high 造成再次開啟
      await putIoOutputState(client, "low");
      break;
    case "lock":
      await putIoOutputState(client, "high");
      break;
    case "unlock":
      await putIoOutputState(client, "low");
      break;
    default:
      break;
  }
}

/**
 * YS-TCG405-E（預設）：Parking barrierGate
 */
async function controlYsTcg405EBarrier(client, channelId, ctrlMode) {
  await client.request({
    method: "PUT",
    path: buildParkingBarrierPath(channelId),
    data: buildBarrierControlXml(ctrlMode),
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });
}

async function executeBarrierGateControl({
  client,
  modelName,
  channelId,
  ctrlMode,
}) {
  if (isYs46G0Model(modelName)) {
    await controlYs46G0Barrier(client, ctrlMode);
    return;
  }
  await controlYsTcg405EBarrier(client, channelId, ctrlMode);
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

async function fetchLicensePlateIndex(client, channelId) {
  const path = buildTrafficPath(channelId, "/searchLPListAudit");
  const xml = buildSearchXml(0, 500);
  const res = await client.request({
    method: "POST",
    path,
    data: xml,
    headers: { "Content-Type": "application/xml" },
    responseType: "text",
  });
  const body = responseBodyToString(res.data);
  const parsed = parseLicensePlateSearchResult(body);

  const byPlateUpper = new Map();
  let maxNumericId = 0;
  for (const item of parsed?.items || []) {
    const plateKey = String(item.licensePlate || "").trim().toUpperCase();
    const rawId = String(item.id || "").trim();
    if (plateKey) byPlateUpper.set(plateKey, rawId);
    if (/^\d+$/.test(rawId)) {
      const n = Number.parseInt(rawId, 10);
      if (Number.isFinite(n) && n > maxNumericId) maxNumericId = n;
    }
  }

  return { parsed, byPlateUpper, maxNumericId };
}

function buildDeletePayloadForDeviceModel(params) {
  const { modelName, normalizedIds, normalizedPlates, idsToDelete } =
    params || {};

  if (isYs46G0Model(modelName)) {
    return { payload: { id: idsToDelete }, count: idsToDelete.length };
  }

  const licensePlate =
    Array.isArray(normalizedPlates) && normalizedPlates.length > 0
      ? normalizedPlates
      : normalizedIds;
  return { payload: { licensePlate }, count: licensePlate.length };
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

  const { device, client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildTrafficPath(
    channelId,
    "/licensePlateAuditData/record?format=json",
  );

  const modelName = String(device.model_name || device.model?.name || "").trim();
  const useNumericId = isYs46G0Model(modelName);

  // 需要設備現況來：
  // - 46-G0：分配/沿用數字 id
  // - 405-E：若名單已存在，避免用 add 造成設備拒絕
  const { byPlateUpper: existingByPlate, maxNumericId } =
    await fetchLicensePlateIndex(client, channelId);
  let nextNumericId = maxNumericId + 1;

  const licensePlateInfoList = plates.map((p) => {
    const licensePlate = String(p.licensePlate || p.id || "").trim();
    if (!licensePlate) {
      throwApiError(C.BAD_REQUEST, "每筆車牌需提供 licensePlate 或 id");
    }
    let operationType = String(p.operationType || "add").toLowerCase();
    if (!VALID_OPERATION_TYPES.has(operationType)) {
      throwApiError(C.BAD_REQUEST, "operationType 須為 add 或 modify");
    }
    const listType = normalizeListTypeToDevice(p.listType || "allowList");
    const plateKey = licensePlate.trim().toUpperCase();
    // 若設備端已存在該車牌，強制改為 modify（部分型號對重複 add 會回 badParameters）
    if (operationType === "add" && existingByPlate.has(plateKey)) {
      operationType = "modify";
    }
    const providedId = String(p.id || "").trim();
    let id = String(p.id || licensePlate).trim();
    if (useNumericId) {
      if (providedId && /^\d+$/.test(providedId)) {
        id = providedId;
      } else if (existingByPlate?.has(plateKey)) {
        const existingId = String(existingByPlate.get(plateKey) || "").trim();
        id =
          existingId && /^\d+$/.test(existingId)
            ? existingId
            : String(nextNumericId++);
      } else {
        id = String(nextNumericId++);
      }
    }
    const createTime = formatIsapiTime(p.createTime || new Date());
    const effectiveTime = formatIsapiTime(
      p.effectiveTime || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    );

    return {
      id,
      listType,
      LicensePlate: licensePlate,
      createTime,
      effectiveTime,
      operationType,
    };
  });

  const requestBody = { LicensePlateInfoList: licensePlateInfoList };
  await client.request({
    method: "PUT",
    path,
    data: requestBody,
  });

  return { success: true, channelId, count: licensePlateInfoList.length };
}

/**
 * @param {number} deviceId
 * @param {object} options
 */
async function deleteLicensePlates(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const ids = Array.isArray(options.ids) ? options.ids : [];
  const plates = Array.isArray(options.licensePlates)
    ? options.licensePlates
    : [];
  const normalizedIds = ids.map((p) => String(p || "").trim()).filter(Boolean);
  const normalizedPlates = plates
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  if (normalizedIds.length === 0 && normalizedPlates.length === 0) {
    throwApiError(C.BAD_REQUEST, "請提供 ids 或 licensePlates 陣列");
  }

  const { device, client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const path = buildTrafficPath(
    channelId,
    "/DelLicensePlateAuditData?format=json",
  );

  const modelName = String(device.model_name || device.model?.name || "").trim();
  let idsToDelete = normalizedIds;
  if (isYs46G0Model(modelName) && idsToDelete.length === 0) {
    // 前端不輸入 id：後端用車牌查詢對應的數字 id 再刪除
    const want = new Set(normalizedPlates.map((p) => p.toUpperCase()));
    const { parsed } = await fetchLicensePlateIndex(client, channelId);
    idsToDelete = (parsed?.items || [])
      .filter((i) =>
        want.has(String(i.licensePlate || "").trim().toUpperCase()),
      )
      .map((i) => String(i.id || "").trim())
      .filter(Boolean);
    if (idsToDelete.length === 0) {
      throwApiError(C.BAD_REQUEST, "找不到對應的車牌 id，無法刪除");
    }
  }

  const { payload, count } = buildDeletePayloadForDeviceModel({
    modelName,
    normalizedIds,
    normalizedPlates,
    idsToDelete,
  });

  await client.request({
    method: "PUT",
    path,
    data: payload,
  });

  return {
    success: true,
    channelId,
    count,
  };
}

async function controlBarrierGate(deviceId, options = {}) {
  await assertDeviceBelongsToSite(deviceId, options.siteId);
  const ctrlMode = String(options.ctrlMode || "")
    .trim()
    .toLowerCase();
  if (!VALID_CTRL_MODES.has(ctrlMode)) {
    throwApiError(C.BAD_REQUEST, "ctrlMode 須為 open、close、lock 或 unlock");
  }

  const { device, client } = await getCameraDeviceAndClient(deviceId);
  const channelId = resolveChannelId(options.channelId);
  const modelName = device.model_name || device.model?.name;
  await executeBarrierGateControl({
    client,
    modelName,
    channelId,
    ctrlMode,
  });

  if (ctrlMode === "open") {
    const placeCtx = await loadPlaceContextByVehicleCameraDeviceId(deviceId);
    if (placeCtx?.locationId) {
      emitVehicleBarrierCameraEventFromPlaceContext(placeCtx, {
        source: "manual",
        deviceId,
      });
    }
  }

  return { success: true, channelId, ctrlMode };
}

module.exports = {
  resolveChannelId,
  searchLicensePlates,
  upsertLicensePlates,
  deleteLicensePlates,
  controlBarrierGate,
  normalizeListTypeToApi,
};
