/**
 * 營運事件：區域／地點反查（SSOT）
 */
const db = require("../../database/db");

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

const formatPlaceLabel = (zoneName, locationName) => {
  const zone = zoneName != null ? String(zoneName).trim() : "";
  const loc = locationName != null ? String(locationName).trim() : "";
  if (zone && loc) return `${zone} - ${loc}`;
  if (loc) return loc;
  if (zone) return zone;
  return null;
};

const pickPlaceFromRow = (row) => {
  const zoneName = row?.zone_name != null ? String(row.zone_name).trim() : "";
  const locationName =
    row?.location_name != null ? String(row.location_name).trim() : "";
  return {
    systemId: toPositiveInt(row?.system_id),
    locationId: toPositiveInt(row?.location_id),
    zoneName: zoneName || null,
    locationName: locationName || null,
    placeLabel: formatPlaceLabel(zoneName, locationName),
    systemConfig: row?.system_config ?? null,
    deviceRole: row?.device_role ?? null,
  };
};

async function loadPlaceContextByLocationId(locationId) {
  const id = toPositiveInt(locationId);
  if (!id) {
    return {
      locationId: null,
      zoneName: null,
      locationName: null,
      placeLabel: null,
    };
  }

  const rows = await db.query(
    `
    SELECT l.id AS location_id, l.name AS location_name, z.name AS zone_name
    FROM locations l
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE l.id = ?
    LIMIT 1
    `,
    [id],
  );
  const row = rows?.[0];
  const zoneName = row?.zone_name != null ? String(row.zone_name).trim() : "";
  const locationName =
    row?.location_name != null ? String(row.location_name).trim() : "";
  return {
    locationId: id,
    zoneName: zoneName || null,
    locationName: locationName || null,
    placeLabel: formatPlaceLabel(zoneName, locationName),
  };
}

/**
 * @returns {Promise<ReturnType<typeof pickPlaceFromRow>>}
 */
async function loadSystemPlaceContext(systemId) {
  const id = toPositiveInt(systemId);
  if (!id) {
    return {
      systemId: null,
      locationId: null,
      zoneName: null,
      locationName: null,
      placeLabel: null,
      systemConfig: null,
      deviceRole: null,
    };
  }

  const rows = await db.query(
    `
    SELECT
      ls.id AS system_id,
      ls.location_id,
      ls.system_config,
      l.name AS location_name,
      z.name AS zone_name
    FROM location_systems ls
    LEFT JOIN locations l ON ls.location_id = l.id
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE ls.id = ?
    LIMIT 1
    `,
    [id],
  );
  return pickPlaceFromRow(rows?.[0]);
}

/**
 * 門禁設備 → people_counting 地點（entry／exit_device_ids）
 * @returns {Promise<ReturnType<typeof pickPlaceFromRow>>}
 */
async function loadPlaceContextByAccessDeviceId(deviceId) {
  const id = toPositiveInt(deviceId);
  if (!id) {
    return {
      systemId: null,
      locationId: null,
      zoneName: null,
      locationName: null,
      placeLabel: null,
      systemConfig: null,
      deviceRole: null,
    };
  }

  const rows = await db.query(
    `
    SELECT
      ls.id AS system_id,
      ls.location_id,
      ls.system_config,
      l.name AS location_name,
      z.name AS zone_name,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'entry_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        ) THEN 'entry'
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'exit_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        ) THEN 'exit'
        ELSE NULL
      END AS device_role
    FROM location_systems ls
    LEFT JOIN locations l ON ls.location_id = l.id
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE ls.system_type = 'people_counting'
      AND (
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'entry_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'exit_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        )
      )
    ORDER BY ls.id
    LIMIT 1
    `,
    [id, id, id, id],
  );
  return pickPlaceFromRow(rows?.[0]);
}

/**
 * 車牌／柵欄攝影機 → vehicle_access 地點（entry／exit_camera_device_ids）
 * @returns {Promise<ReturnType<typeof pickPlaceFromRow>>}
 */
async function loadPlaceContextByVehicleCameraDeviceId(deviceId) {
  const id = toPositiveInt(deviceId);
  if (!id) {
    return {
      systemId: null,
      locationId: null,
      zoneName: null,
      locationName: null,
      placeLabel: null,
      systemConfig: null,
      deviceRole: null,
    };
  }

  const rows = await db.query(
    `
    SELECT
      ls.id AS system_id,
      ls.location_id,
      ls.system_config,
      l.name AS location_name,
      z.name AS zone_name,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'entry_camera_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        ) THEN 'entry'
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'exit_camera_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        ) THEN 'exit'
        ELSE NULL
      END AS device_role
    FROM location_systems ls
    LEFT JOIN locations l ON ls.location_id = l.id
    LEFT JOIN zones z ON l.zone_id = z.id
    WHERE ls.system_type = 'vehicle_access'
      AND (
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'entry_camera_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(ls.system_config->'exit_camera_device_ids', '[]'::jsonb)
          ) AS x(id)
          WHERE x.id::int = ?
        )
      )
    ORDER BY ls.id
    LIMIT 1
    `,
    [id, id, id, id],
  );
  return pickPlaceFromRow(rows?.[0]);
}

module.exports = {
  toPositiveInt,
  formatPlaceLabel,
  loadPlaceContextByLocationId,
  loadSystemPlaceContext,
  loadPlaceContextByAccessDeviceId,
  loadPlaceContextByVehicleCameraDeviceId,
};
