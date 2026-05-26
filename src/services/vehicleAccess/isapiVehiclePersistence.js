/**
 * ISAPI 車輛 ANPR 事件寫入 vehicle_passageway_logs（先 XML 後圖）
 */
const path = require("path");
const fs = require("fs");
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const { normalizePlate } = require("../../utils/vehiclePlateUtils");
const { lookupPersonByPlate } = require("./vehiclePlateEnrichment");

const UPLOADS_VEHICLE_DIR = path.join(
  process.cwd(),
  "uploads",
  "vehicle-events",
);

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_VEHICLE_DIR)) {
    fs.mkdirSync(UPLOADS_VEHICLE_DIR, { recursive: true });
  }
}

function listTypeToAllowResult(listType) {
  const t = String(listType || "").trim().toLowerCase();
  return t === "white" ? 1 : 0;
}

/**
 * @param {object} options
 * @returns {Promise<{ inserted: boolean, ids: number[], licensePlatePictureIndex: number }>}
 */
async function persistAnprEvent(options) {
  const {
    parsed,
    deviceId,
    locationTargets = [],
  } = options || {};

  if (!parsed?.dateTime || !Array.isArray(locationTargets) || locationTargets.length === 0) {
    return { inserted: false, ids: [], licensePlatePictureIndex: -1 };
  }

  const plate = normalizePlate(parsed.licensePlate);
  const allowResult = listTypeToAllowResult(parsed.listType);
  const personInfo = plate ? await lookupPersonByPlate(plate) : null;

  let licensePlatePictureIndex = -1;
  (parsed.pictureInfoList || []).forEach((p, idx) => {
    if (String(p.type || "").toLowerCase() === "licenseplatepicture") {
      licensePlatePictureIndex = idx;
    }
  });

  const ids = [];
  for (const target of locationTargets) {
    const laneType = target.laneType;
    const laneName =
      parsed.line != null && String(parsed.line).trim() !== ""
        ? `線別 ${parsed.line}`
        : null;

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
        'isapi_camera', ?, ?, NULL, 0, ?
      ) RETURNING id`,
      [
        parsed.dateTime,
        laneName,
        plate || null,
        personInfo?.ownerName || null,
        allowResult,
        laneType,
        target.zoneName || "",
        target.locationName || "",
        target.locationId,
        deviceId,
        parsed.line != null ? String(parsed.line) : null,
        JSON.stringify(parsed.payload || {}),
      ],
    );
    const id = rows?.[0]?.id;
    if (id != null) ids.push(id);
  }

  if (ids.length > 0) {
    websocketService.emitVehicleAccessIsapiEvent({
      deviceId,
      locationIds: locationTargets.map((t) => t.locationId),
      eventTime: parsed.dateTime,
    });
  }

  return {
    inserted: ids.length > 0,
    ids,
    licensePlatePictureIndex,
  };
}

async function attachLicensePlatePicture(logId, pictureBuffer) {
  if (
    logId == null ||
    !Buffer.isBuffer(pictureBuffer) ||
    pictureBuffer.length === 0
  ) {
    return;
  }
  ensureUploadsDir();
  const rows = await db.query(
    `SELECT device_id, trigger_time FROM vehicle_passageway_logs WHERE id = ?`,
    [logId],
  );
  const row = rows?.[0];
  if (!row) return;

  const devRows = await db.query(`SELECT config FROM devices WHERE id = ?`, [
    row.device_id,
  ]);
  const host = devRows?.[0]?.config?.host
    ? String(devRows[0].config.host).replace(/[^0-9a-fA-F.:]/g, "_")
    : "unknown";
  const rawTime = String(row.trigger_time || "")
    .replace(/:/g, "-")
    .replace(/\+.*$/, "")
    .replace(/Z$/, "")
    .slice(0, 19);
  const basename = `${host}_${rawTime}_${logId}.jpg`;
  const filePath = path.join(UPLOADS_VEHICLE_DIR, basename);
  fs.writeFileSync(filePath, pictureBuffer);
  const picturePath = `/uploads/vehicle-events/${basename}`;
  await db.query(
    `UPDATE vehicle_passageway_logs SET picture_path = ?, file_count = 1 WHERE id = ?`,
    [picturePath, logId],
  );
  websocketService.emitVehicleAccessIsapiEvent({
    logId,
    eventTime: row.trigger_time,
  });
}

module.exports = {
  persistAnprEvent,
  attachLicensePlatePicture,
  UPLOADS_VEHICLE_DIR,
  ensureUploadsDir,
  listTypeToAllowResult,
};
