/**
 * 門禁保全：室內機 → 戶別（location_systems）對照
 */
const db = require("../../database/db");

const toPositiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function resolveLocationByIndoorDeviceId(deviceId) {
  const id = toPositiveInt(deviceId);
  if (!id) return null;

  const rows = await db.query(
    `
    SELECT ls.location_id, ls.id AS system_id, l.name AS location_name
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    WHERE ls.system_type = 'access_security'
      AND NULLIF(ls.system_config->>'indoor_device_id', '')::int = ?
    LIMIT 1
    `,
    [id],
  );
  const row = rows?.[0];
  if (!row?.location_id) return null;
  return {
    locationId: Number(row.location_id),
    systemId: row.system_id != null ? Number(row.system_id) : null,
    locationName: row.location_name || null,
  };
}

async function resolveLocationByVoipOrHost({ voipNumber, host } = {}) {
  const voip = String(voipNumber || "").trim();
  const ip = String(host || "").trim();
  if (!voip && !ip) return null;

  const rows = await db.query(
    `
    SELECT ls.location_id, ls.id AS system_id, l.name AS location_name
    FROM location_systems ls
    INNER JOIN locations l ON l.id = ls.location_id
    INNER JOIN devices d
      ON d.id = NULLIF(ls.system_config->>'indoor_device_id', '')::int
    WHERE ls.system_type = 'access_security'
      AND d.type_code = 'video_intercom'
      AND (
        (? <> '' AND (d.config->>'voipNumber') = ?)
        OR (? <> '' AND (d.config->>'host') = ?)
      )
    LIMIT 1
    `,
    [voip, voip, ip, ip],
  );
  const row = rows?.[0];
  if (!row?.location_id) return null;
  return {
    locationId: Number(row.location_id),
    systemId: row.system_id != null ? Number(row.system_id) : null,
    locationName: row.location_name || null,
  };
}

module.exports = {
  resolveLocationByIndoorDeviceId,
  resolveLocationByVoipOrHost,
};
