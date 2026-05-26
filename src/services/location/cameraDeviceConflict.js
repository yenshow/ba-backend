/**
 * ISAPI 攝影機設備跨系統／同系統衝突檢查（人流 isapi_camera ↔ 車輛 isapi_camera）
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const SQL_PC_ISAPI = `
  SELECT ls.location_id, ls.system_config
  FROM location_systems ls
  WHERE ls.system_type = 'people_counting'
    AND COALESCE(ls.system_config->>'data_source', 'yscp') = 'isapi_camera'
    AND ($1::int IS NULL OR ls.location_id <> $1::int)
`;

const SQL_VA_ISAPI = `
  SELECT ls.location_id, ls.system_config
  FROM location_systems ls
  WHERE ls.system_type = 'vehicle_access'
    AND COALESCE(ls.system_config->>'data_source', 'yscp') = 'isapi_camera'
    AND ($1::int IS NULL OR ls.location_id <> $1::int)
`;

function ensureIntArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
}

function pcCameraIds(config) {
  return ensureIntArray(config?.camera_device_ids);
}

function vaCameraIds(config) {
  const c = config || {};
  return [
    ...ensureIntArray(c.entry_camera_device_ids),
    ...ensureIntArray(c.exit_camera_device_ids),
  ];
}

function assertIdConflict(conflictSet, otherIds, formatMessage) {
  for (const id of otherIds) {
    if (conflictSet.has(id)) {
      throwApiError(C.PEOPLE_COUNTING_VALIDATION_FAILED, formatMessage(id));
    }
  }
}

async function hostsOfDeviceIds(deviceIds) {
  if (!deviceIds.length) return new Set();
  const rows = await db.query(
    `SELECT config FROM devices WHERE id = ANY(?::int[])`,
    [deviceIds],
  );
  const hosts = new Set();
  for (const d of rows || []) {
    const host = d?.config?.host ? String(d.config.host).trim() : "";
    if (host) hosts.add(host);
  }
  return hosts;
}

async function assertHostConflictWithPeopleCounting(deviceIds, excludeLocationId) {
  const hosts = await hostsOfDeviceIds(deviceIds);
  if (hosts.size === 0) return;

  const rows = await db.query(
    `
      SELECT d.config
      FROM location_systems ls
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(ls.system_config->'camera_device_ids', '[]'::jsonb)
      ) AS cam_id
      INNER JOIN devices d ON d.id = cam_id::int
      WHERE ls.system_type = 'people_counting'
        AND COALESCE(ls.system_config->>'data_source', 'yscp') = 'isapi_camera'
        AND ($1::int IS NULL OR ls.location_id <> $1::int)
    `,
    [excludeLocationId],
  );
  for (const d of rows || []) {
    const host = d?.config?.host ? String(d.config.host).trim() : "";
    if (host && hosts.has(host)) {
      throwApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        `攝影機 IP（${host}）已用於人流統計（isapi_camera），不可同時用於車輛 ISAPI`,
      );
    }
  }
}

async function assertHostConflictWithVehicleAccess(deviceIds, excludeLocationId) {
  const hosts = await hostsOfDeviceIds(deviceIds);
  if (hosts.size === 0) return;

  const rows = await db.query(
    `
      SELECT d.config
      FROM location_systems ls
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(COALESCE(ls.system_config->'entry_camera_device_ids', '[]'::jsonb)) AS cam_id
        UNION ALL
        SELECT jsonb_array_elements_text(COALESCE(ls.system_config->'exit_camera_device_ids', '[]'::jsonb))
      ) AS cams
      INNER JOIN devices d ON d.id = cams.cam_id::int
      WHERE ls.system_type = 'vehicle_access'
        AND COALESCE(ls.system_config->>'data_source', 'yscp') = 'isapi_camera'
        AND ($1::int IS NULL OR ls.location_id <> $1::int)
    `,
    [excludeLocationId],
  );
  for (const d of rows || []) {
    const host = d?.config?.host ? String(d.config.host).trim() : "";
    if (host && hosts.has(host)) {
      throwApiError(
        C.PEOPLE_COUNTING_VALIDATION_FAILED,
        `攝影機 IP（${host}）已用於車輛進出（isapi_camera），不可同時用於人流 ISAPI`,
      );
    }
  }
}

async function assertPeopleCountingIsapiCamerasAvailable(
  deviceIds,
  excludeLocationId = null,
) {
  if (!deviceIds.length) return;
  const conflictSet = new Set(deviceIds);
  const pcRows = await db.query(SQL_PC_ISAPI, [excludeLocationId]);
  for (const r of pcRows || []) {
    assertIdConflict(conflictSet, pcCameraIds(r.system_config), (id) =>
      `攝影機設備 ${id} 已被其他人流統計地點使用`,
    );
  }
  await assertCamerasNotUsedByVehicleAccessIsapi(deviceIds, excludeLocationId);
}

async function assertCamerasNotUsedByPeopleCountingIsapi(
  deviceIds,
  excludeLocationId = null,
) {
  if (!deviceIds.length) return;
  const conflictSet = new Set(deviceIds);
  const pcRows = await db.query(SQL_PC_ISAPI, [excludeLocationId]);
  for (const r of pcRows || []) {
    assertIdConflict(conflictSet, pcCameraIds(r.system_config), (id) =>
      `攝影機設備 ${id} 已用於人流統計（isapi_camera），不可同時用於車輛 ISAPI 訂閱`,
    );
  }
  await assertHostConflictWithPeopleCounting(deviceIds, excludeLocationId);
}

async function assertCamerasNotUsedByVehicleAccessIsapi(
  deviceIds,
  excludeLocationId = null,
) {
  if (!deviceIds.length) return;
  const conflictSet = new Set(deviceIds);
  const vaRows = await db.query(SQL_VA_ISAPI, [excludeLocationId]);
  for (const r of vaRows || []) {
    assertIdConflict(conflictSet, vaCameraIds(r.system_config), (id) =>
      `攝影機設備 ${id} 已用於車輛進出（isapi_camera），不可同時用於人流 ISAPI`,
    );
  }
  await assertHostConflictWithVehicleAccess(deviceIds, excludeLocationId);
}

module.exports = {
  ensureIntArray,
  assertPeopleCountingIsapiCamerasAvailable,
  assertCamerasNotUsedByPeopleCountingIsapi,
  assertCamerasNotUsedByVehicleAccessIsapi,
};
