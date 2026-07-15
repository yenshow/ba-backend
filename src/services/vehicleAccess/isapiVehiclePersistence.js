/**
 * ISAPI 車輛 ANPR 事件寫入 vehicle_passageway_logs（先 XML 後圖）
 */
const path = require("path");
const fs = require("fs");
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { lookupPersonByPlate } = require("./vehicleAccessHelpers");
const {
  parseConfig,
  getEffectiveSince,
  isEventAfterEffectiveSince,
} = require("./vehicleAccessConfig");
const vehiclePresenceService = require("./vehiclePresenceService");
const { getUploadsDir, formatUploadTimestampForFilename } = require("../../utils/baDataPaths");
const operationalEventService = require("../operationalEvents/operationalEventService");
const { summaryVehicle } = require("../operationalEvents/operationalEventCopy");

async function resolveDeviceDisplayName(deviceId) {
  if (!deviceId) return null;
  const rows = await db.query(`SELECT name FROM devices WHERE id = ?`, [deviceId]);
  const name = rows?.[0]?.name ? String(rows[0].name).trim() : "";
  return name || null;
}

function listTypeToAllowResult(listType) {
  const t = String(listType || "").trim().toLowerCase();
  if (t === "allowlist" || t === "white") return 1;
  if (t === "blocklist" || t === "black") return 0;
  return null;
}

/** @type {Map<number, { operationMode: string, effectiveSince: string|null }>} */
const locationParkingCache = new Map();
const LOCATION_CFG_CACHE_MS = 30_000;

async function getLocationIngestPolicy(locationId) {
  const cached = locationParkingCache.get(locationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.policy;
  }
  const locRows = await db.query(
    `SELECT l.created_at, ls.system_config
     FROM locations l
     JOIN location_systems ls ON ls.location_id = l.id AND ls.system_type = 'vehicle_access'
     WHERE l.id = ?`,
    [locationId],
  );
  if (!locRows?.length) {
    return { skipIngest: false, updatePresence: false };
  }
  const cfg = parseConfig(locRows[0].system_config);
  const createdAt = locRows[0].created_at
    ? new Date(locRows[0].created_at).toISOString()
    : null;
  const effectiveSince = getEffectiveSince(cfg, createdAt);
  const policy = {
    operationMode: cfg.operationMode,
    effectiveSince,
    /** 停車場：略過 effectiveSince 之前的歷史事件 */
    filterEventsBeforeSince:
      cfg.operationMode === "parking" && effectiveSince != null,
    updatePresence: cfg.operationMode === "parking",
  };
  locationParkingCache.set(locationId, {
    policy,
    expiresAt: Date.now() + LOCATION_CFG_CACHE_MS,
  });
  return policy;
}

function invalidateLocationIngestCache(locationId) {
  if (locationId != null) locationParkingCache.delete(Number(locationId));
}

/**
 * @param {object} options
 * @returns {Promise<{ inserted: boolean, ids: number[] }>}
 */
async function persistAnprEvent(options) {
  const { parsed, deviceId, locationTargets = [] } = options || {};

  if (!parsed?.dateTime || !Array.isArray(locationTargets) || locationTargets.length === 0) {
    return { inserted: false, ids: [] };
  }

  const plate = normalizePlate(parsed.licensePlate);
  const personInfo = plate ? await lookupPersonByPlate(plate) : null;
  const laneName = await resolveDeviceDisplayName(deviceId);
  const allowResult = listTypeToAllowResult(parsed.listType);
  const payload = JSON.stringify({
    dateTime: parsed.dateTime,
    eventType: parsed.eventType,
    licensePlate: parsed.licensePlate,
    listType: parsed.listType,
  });

  const ids = [];
  for (const target of locationTargets) {
    const policy = await getLocationIngestPolicy(target.locationId);
    if (
      policy.filterEventsBeforeSince &&
      !isEventAfterEffectiveSince(parsed.dateTime, policy.effectiveSince)
    ) {
      continue;
    }

    const rows = await db.query(
      `INSERT INTO vehicle_passageway_logs (
        external_id, trigger_time, lane_id, lane_name, license_plate, owner_name,
        allow_result, lane_type, vehicle_list_id, vehicle_list_name,
        zone_name, location_name, location_id,
        data_source, device_id, anpr_line, picture_path, file_count, payload
      ) VALUES (
        NULL, ?, NULL, ?, ?, ?,
        ?, ?, NULL, NULL,
        ?, ?, ?,
        'isapi_camera', ?, NULL, NULL, 0, ?
      ) RETURNING id`,
      [
        parsed.dateTime,
        laneName,
        plate || null,
        personInfo?.ownerName || null,
        allowResult,
        target.laneType,
        target.zoneName || "",
        target.locationName || "",
        target.locationId,
        deviceId,
        payload,
      ],
    );
    const id = rows?.[0]?.id;
    if (id != null) {
      ids.push(id);
      void operationalEventService.recordEvent({
        source: "vehicle_access",
        event_kind: "vehicle",
        occurred_at: parsed.dateTime,
        location_id: target.locationId,
        device_id: deviceId,
        summary: summaryVehicle({
          plate,
          laneType: target.laneType,
        }),
        ref_table: "vehicle_passageway_logs",
        ref_id: id,
        payload: {
          licensePlate: plate || null,
          laneType: target.laneType,
          allowResult,
        },
      });
      if (
        policy.updatePresence &&
        plate &&
        allowResult === 1 &&
        target.laneType != null
      ) {
        await vehiclePresenceService.upsertPresenceFromPassage(
          target.locationId,
          plate,
          { allow_result: allowResult, lane_type: target.laneType },
          parsed.dateTime,
        );
      }
    }
  }

  if (ids.length > 0) {
    websocketService.emitVehicleAccessIsapiEvent({
      deviceId,
      locationIds: locationTargets.map((t) => t.locationId),
      eventTime: parsed.dateTime,
    });
  }

  return { inserted: ids.length > 0, ids };
}

function normalizeLogIds(logIds) {
  const raw = Array.isArray(logIds) ? logIds : logIds != null ? [logIds] : [];
  return [
    ...new Set(
      raw
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];
}

/** fan-out 至多地點：附圖寫一次，所有 log 共用 picture_path */
async function attachLicensePlatePicture(logIds, pictureBuffer) {
  const ids = normalizeLogIds(logIds);
  if (ids.length === 0 || !Buffer.isBuffer(pictureBuffer) || pictureBuffer.length === 0) {
    return;
  }
  const primaryId = ids[0];
  const rows = await db.query(
    `SELECT device_id, trigger_time FROM vehicle_passageway_logs WHERE id = ?`,
    [primaryId],
  );
  const row = rows?.[0];
  if (!row) return;

  const devRows = await db.query(`SELECT config FROM devices WHERE id = ?`, [
    row.device_id,
  ]);
  const host = devRows?.[0]?.config?.host
    ? String(devRows[0].config.host).replace(/[^0-9a-fA-F.:]/g, "_")
    : "unknown";
  const rawTime = formatUploadTimestampForFilename(row.trigger_time, 19);
  const basename = `${host}_${rawTime}_${primaryId}.jpg`;
  const filePath = path.join(getUploadsDir("vehicle-events"), basename);
  fs.writeFileSync(filePath, pictureBuffer);
  const picturePath = `/uploads/vehicle-events/${basename}`;
  const placeholders = ids.map(() => "?").join(", ");
  await db.query(
    `UPDATE vehicle_passageway_logs SET picture_path = ?, file_count = 1 WHERE id IN (${placeholders})`,
    [picturePath, ...ids],
  );
  websocketService.emitVehicleAccessIsapiEvent({
    logIds: ids,
    eventTime: row.trigger_time,
  });
}

let fanOutPictureBackfillDone = false;

/** 啟動時一次：fan-out 缺圖列自同事件 sibling 複製 picture_path */
async function runFanOutPictureBackfillOnce() {
  if (fanOutPictureBackfillDone) return 0;
  fanOutPictureBackfillDone = true;
  const rows = await db.query(
    `UPDATE vehicle_passageway_logs AS target
     SET picture_path = src.picture_path,
         file_count = GREATEST(COALESCE(target.file_count, 0), 1)
     FROM vehicle_passageway_logs AS src
     WHERE target.picture_path IS NULL
       AND src.picture_path IS NOT NULL
       AND target.data_source = 'isapi_camera'
       AND src.data_source = 'isapi_camera'
       AND target.device_id = src.device_id
       AND target.trigger_time = src.trigger_time
       AND target.license_plate IS NOT DISTINCT FROM src.license_plate
       AND target.id <> src.id
     RETURNING target.id`,
  );
  return Array.isArray(rows) ? rows.length : 0;
}

module.exports = {
  persistAnprEvent,
  attachLicensePlatePicture,
  runFanOutPictureBackfillOnce,
  invalidateLocationIngestCache,
};
