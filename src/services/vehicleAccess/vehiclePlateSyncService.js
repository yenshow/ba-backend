/**
 * 人員車牌 ↔ ISAPI 設備名單同步（獨立於門禁 person_device_sync）
 */
const db = require("../../database/db");
const { parseConfig } = require("./vehicleAccessConfig");
const isapiVehicleDeviceService = require("./isapiVehicleDeviceService");
const { normalizeListTypeToDevice } = require("./isapiVehicleXmlParser");
const personLicensePlateService = require("../personnel/personLicensePlateService");

const SYNC_STATUS = {
  SYNCED: "synced",
  PARTIAL: "partial",
  PENDING: "pending",
  FAILED: "failed",
  SKIPPED: "skipped",
};

function summarizePlateSyncError(failures) {
  const messages = [
    ...new Set(
      (failures || [])
        .map((f) => (f?.message != null ? String(f.message).trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (messages.length === 0) return "同步失敗";
  const combined = messages.join("；");
  if (/timeout.*exceeded/i.test(combined)) {
    return "請求逾時，請檢查攝影機連線";
  }
  return messages[0];
}

function buildIsapiTimesFromRow(row) {
  // 時間格式統一由 isapiVehicleDeviceService.formatIsapiTime 處理
  return {
    createTime: row.effective_begin || new Date(),
    effectiveTime:
      row.effective_end || new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
  };
}

/**
 * @param {number} personId
 * @returns {Promise<Array<{ locationId: number, deviceIds: number[], channelId: number }>>}
 */
async function resolveIsapiTargetsForPersonId(personId) {
  const pid = Number(personId);
  if (!Number.isFinite(pid)) return [];

  const accessRows = await db.query(
    `SELECT location_id FROM person_location_access WHERE person_id = ?`,
    [pid],
  );
  const locationIds = (accessRows || [])
    .map((r) => Number(r.location_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (locationIds.length === 0) return [];

  const placeholders = locationIds.map(() => "?").join(",");
  const rows = await db.query(
    `
      SELECT ls.location_id, ls.system_config
      FROM location_systems ls
      WHERE ls.system_type = 'vehicle_access'
        AND ls.location_id IN (${placeholders})
    `,
    locationIds,
  );

  const targets = [];
  for (const row of rows || []) {
    const cfg = parseConfig(row.system_config);
    if (cfg.dataSource !== "isapi_camera") continue;
    const deviceIds = Array.from(
      new Set([...(cfg.entryCameraDeviceIds || []), ...(cfg.exitCameraDeviceIds || [])]),
    );
    if (deviceIds.length === 0) continue;
    targets.push({
      locationId: Number(row.location_id),
      deviceIds,
      channelId: cfg.cameraChannelId ?? 1,
    });
  }
  return targets;
}

function resolveTargetForLocation(locationId, systemConfig) {
  const cfg = parseConfig(systemConfig);
  if (cfg.dataSource !== "isapi_camera") return null;
  const deviceIds = Array.from(
    new Set([...(cfg.entryCameraDeviceIds || []), ...(cfg.exitCameraDeviceIds || [])]),
  );
  if (deviceIds.length === 0) return null;
  return {
    locationId: Number(locationId),
    deviceIds,
    channelId: cfg.cameraChannelId ?? 1,
  };
}

function aggregateSyncResults(results) {
  const warnings = [];
  const failures = [];
  let hasSuccess = false;
  let hasFailure = false;
  let hasPending = false;

  for (const r of results) {
    if (r.warning) warnings.push(r.warning);
    if (r.failure) failures.push(r.failure);
    if (r.status === SYNC_STATUS.SYNCED) hasSuccess = true;
    if (r.status === SYNC_STATUS.FAILED || r.status === SYNC_STATUS.PARTIAL) {
      hasFailure = true;
    }
    if (r.status === SYNC_STATUS.PENDING) hasPending = true;
  }

  if (results.length === 0 || hasPending) {
    return {
      status: SYNC_STATUS.PENDING,
      warnings:
        warnings.length > 0
          ? warnings
          : ["尚無可同步的 ISAPI 車輛地點或入口/出口攝影機，車牌已儲存，待地點設定後將自動同步"],
      failures,
    };
  }
  if (hasFailure && hasSuccess) {
    return { status: SYNC_STATUS.PARTIAL, warnings, failures };
  }
  if (hasFailure) {
    return { status: SYNC_STATUS.FAILED, warnings, failures };
  }
  return { status: SYNC_STATUS.SYNCED, warnings, failures };
}

async function pushPlateRowToTarget(plateRow, target) {
  const { createTime, effectiveTime } = buildIsapiTimesFromRow(plateRow);
  const listType = normalizeListTypeToDevice(plateRow.list_type || "allowList");
  const licensePlate = plateRow.plate_number;
  const operationType =
    plateRow.isapi_sync_status === SYNC_STATUS.SYNCED ? "modify" : "add";
  const failures = [];
  let successCount = 0;

  const deviceResults = await Promise.all(
    target.deviceIds.map(async (deviceId) => {
      try {
        await isapiVehicleDeviceService.upsertLicensePlates(deviceId, {
          siteId: target.locationId,
          channelId: target.channelId,
          plates: [
            {
              licensePlate,
              listType,
              createTime,
              effectiveTime,
              operationType,
            },
          ],
        });
        return { ok: true, deviceId };
      } catch (err) {
        return {
          ok: false,
          deviceId,
          failure: {
            plateNumber: licensePlate,
            deviceId,
            locationId: target.locationId,
            message: err?.message || String(err),
          },
        };
      }
    }),
  );

  for (const r of deviceResults) {
    if (r.ok) successCount += 1;
    else if (r.failure) failures.push(r.failure);
  }

  return { successCount, failures, totalDevices: target.deviceIds.length };
}

async function syncPlateRowById(plateId, targets) {
  const rows = await db.query(
    `SELECT * FROM person_license_plates WHERE id = ? LIMIT 1`,
    [plateId],
  );
  const row = rows?.[0];
  if (!row) {
    return { status: SYNC_STATUS.SKIPPED, warning: null, failure: null };
  }

  if (!targets.length) {
    await personLicensePlateService.updateSyncStatus(plateId, {
      status: SYNC_STATUS.PENDING,
      error: null,
      syncedAt: null,
    });
    return { status: SYNC_STATUS.PENDING, warning: null, failure: null };
  }

  let totalOk = 0;
  let totalDevices = 0;
  const allFailures = [];

  const targetResults = await Promise.all(
    targets.map((target) => pushPlateRowToTarget(row, target)),
  );
  for (const res of targetResults) {
    totalOk += res.successCount;
    totalDevices += res.totalDevices;
    allFailures.push(...res.failures);
  }

  if (totalDevices === 0) {
    await personLicensePlateService.updateSyncStatus(plateId, {
      status: SYNC_STATUS.PENDING,
      error: "缺少入口/出口攝影機",
      syncedAt: null,
    });
    return { status: SYNC_STATUS.PENDING, warning: null, failure: null };
  }

  if (allFailures.length === 0) {
    await personLicensePlateService.updateSyncStatus(plateId, {
      status: SYNC_STATUS.SYNCED,
      error: null,
      syncedAt: new Date(),
    });
    return { status: SYNC_STATUS.SYNCED, warning: null, failure: null };
  }

  if (totalOk > 0) {
    await personLicensePlateService.updateSyncStatus(plateId, {
      status: SYNC_STATUS.PARTIAL,
      error: summarizePlateSyncError(allFailures) || "部分設備同步失敗",
      syncedAt: new Date(),
    });
    return {
      status: SYNC_STATUS.PARTIAL,
      warning: null,
      failure: allFailures[0],
    };
  }

  await personLicensePlateService.updateSyncStatus(plateId, {
    status: SYNC_STATUS.FAILED,
    error: summarizePlateSyncError(allFailures) || "同步失敗",
    syncedAt: null,
  });
  return {
    status: SYNC_STATUS.FAILED,
    warning: null,
    failure: allFailures[0],
  };
}

/**
 * @param {number} personId
 */
async function syncPersonPlates(personId) {
  const pid = Number(personId);
  if (!Number.isFinite(pid)) {
    return aggregateSyncResults([]);
  }

  const targets = await resolveIsapiTargetsForPersonId(pid);
  const plates = await personLicensePlateService.listByPersonId(pid);

  if (plates.length === 0) {
    return { status: SYNC_STATUS.SKIPPED, warnings: [], failures: [] };
  }

  const results = await Promise.all(
    plates.map((plate) => syncPlateRowById(plate.id, targets)),
  );
  return aggregateSyncResults(results);
}

/**
 * @param {number} locationId
 */
async function syncPlatesForLocation(locationId) {
  const locId = Number(locationId);
  if (!Number.isFinite(locId)) {
    return { status: SYNC_STATUS.SKIPPED, warnings: [], failures: [] };
  }

  const rows = await db.query(
    `
      SELECT system_config
      FROM location_systems
      WHERE location_id = ? AND system_type = 'vehicle_access'
      LIMIT 1
    `,
    [locId],
  );
  const target = resolveTargetForLocation(locId, rows?.[0]?.system_config);

  if (!target) {
    return {
      status: SYNC_STATUS.SKIPPED,
      warnings: [],
      failures: [],
    };
  }

  const plateRows = await db.query(
    `
      SELECT plp.id
      FROM person_license_plates plp
      INNER JOIN person_location_access pla ON pla.person_id = plp.person_id
      INNER JOIN persons p ON p.id = plp.person_id
      WHERE pla.location_id = ? AND p.status = 'active'
      ORDER BY plp.id ASC
    `,
    [locId],
  );

  const inactivePlateRows = await db.query(
    `
      SELECT plp.plate_number
      FROM person_license_plates plp
      INNER JOIN person_location_access pla ON pla.person_id = plp.person_id
      INNER JOIN persons p ON p.id = plp.person_id
      WHERE pla.location_id = ? AND p.status != 'active'
    `,
    [locId],
  );

  const cleanupFailures = [];
  for (const row of inactivePlateRows || []) {
    await removePlateFromTargets(row.plate_number, [target], cleanupFailures);
  }

  const results = [];
  for (const row of plateRows || []) {
    results.push(await syncPlateRowById(row.id, [target]));
  }
  const aggregated = aggregateSyncResults(results);
  if (cleanupFailures.length > 0) {
    aggregated.failures = [...(aggregated.failures || []), ...cleanupFailures];
    if (aggregated.status === SYNC_STATUS.SYNCED) {
      aggregated.status = SYNC_STATUS.PARTIAL;
    }
  }
  return aggregated;
}

function mergeTargets(targetLists) {
  const map = new Map();
  for (const list of targetLists) {
    for (const target of list || []) {
      if (!target?.locationId) continue;
      const key = Number(target.locationId);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          locationId: key,
          deviceIds: Array.from(new Set(target.deviceIds || [])),
          channelId: target.channelId ?? 1,
        });
        continue;
      }
      existing.deviceIds = Array.from(
        new Set([...(existing.deviceIds || []), ...(target.deviceIds || [])]),
      );
    }
  }
  return Array.from(map.values());
}

async function removePlateFromTargets(plateNumber, targets, failures = []) {
  const licensePlate = String(plateNumber || "").trim();
  if (!licensePlate || !targets?.length) return { removed: 0, failures };

  let removed = 0;
  for (const target of targets) {
    for (const deviceId of target.deviceIds || []) {
      try {
        await isapiVehicleDeviceService.deleteLicensePlates(deviceId, {
          siteId: target.locationId,
          channelId: target.channelId,
          licensePlates: [licensePlate],
        });
        removed += 1;
      } catch (err) {
        failures.push({
          plateNumber: licensePlate,
          deviceId,
          locationId: target.locationId,
          message: err?.message || String(err),
        });
      }
    }
  }
  return { removed, failures };
}

/**
 * 人員改群組或刪除車牌時，從舊設備移除名單
 */
async function reconcileAfterPersonChange(personId, context = {}) {
  const removedPlates = Array.isArray(context.removedPlates)
    ? context.removedPlates
    : [];
  const locationAccessChanged = Boolean(context.locationAccessChanged);
  if (!locationAccessChanged && removedPlates.length === 0) {
    return { failures: [] };
  }

  const previousLocationIds = Array.isArray(context.previousLocationIds)
    ? context.previousLocationIds.map(Number).filter((n) => Number.isFinite(n))
    : [];
  const failures = [];

  if (locationAccessChanged && previousLocationIds.length > 0) {
    const currentPlates =
      await personLicensePlateService.listByPersonId(personId);
    const oldTargets = [];
    for (const locationId of previousLocationIds) {
      const rows = await db.query(
        `
          SELECT system_config
          FROM location_systems
          WHERE location_id = ? AND system_type = 'vehicle_access'
          LIMIT 1
        `,
        [locationId],
      );
      const target = resolveTargetForLocation(locationId, rows?.[0]?.system_config);
      if (target) oldTargets.push(target);
    }
    for (const plate of currentPlates) {
      await removePlateFromTargets(plate.plate_number, oldTargets, failures);
    }
  }

  if (removedPlates.length > 0) {
    const cleanupTargets = await resolveIsapiTargetsForPersonId(personId);
    for (const plate of removedPlates) {
      const plateNumber = plate?.plate_number || plate?.plateNumber;
      await removePlateFromTargets(plateNumber, cleanupTargets, failures);
    }
  }

  return { failures };
}

/**
 * 人員刪除前：從群組對應設備移除所有車牌
 */
async function purgePersonPlatesFromDevices(personId) {
  const plates = await personLicensePlateService.listByPersonId(personId);
  const targets = await resolveIsapiTargetsForPersonId(personId);
  const failures = [];
  for (const plate of plates) {
    await removePlateFromTargets(plate.plate_number, targets, failures);
  }
  return { failures };
}

function diffRemovedPlates(before, after) {
  const afterNorm = new Set((after || []).map((p) => p.plate_normalized));
  return (before || []).filter((p) => !afterNorm.has(p.plate_normalized));
}

/**
 * 地點名單縮減時，從該地點攝影機移除被移除人員的車牌
 */
async function reconcileLocationMemberChange(locationId, removedPersonIds = []) {
  const locId = Number(locationId);
  const removed = (Array.isArray(removedPersonIds) ? removedPersonIds : [])
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!Number.isFinite(locId) || removed.length === 0) {
    return { failures: [] };
  }

  const rows = await db.query(
    `
      SELECT system_config
      FROM location_systems
      WHERE location_id = ? AND system_type = 'vehicle_access'
      LIMIT 1
    `,
    [locId],
  );
  const target = resolveTargetForLocation(locId, rows?.[0]?.system_config);
  if (!target) return { failures: [] };

  const placeholders = removed.map(() => "?").join(",");
  const plateRows = await db.query(
    `
      SELECT plp.plate_number
      FROM person_license_plates plp
      WHERE plp.person_id IN (${placeholders})
    `,
    removed,
  );

  const failures = [];
  for (const row of plateRows || []) {
    await removePlateFromTargets(row.plate_number, [target], failures);
  }
  return { failures };
}

/**
 * 僅寫入平台 person_license_plates，並清理設備上已刪除的車牌
 */
async function savePersonLicensePlatesPlatform(personId, platesInput, oldPlates = []) {
  const pid = Number(personId);
  await personLicensePlateService.replacePlatesForPerson(pid, platesInput);
  const newPlates = await personLicensePlateService.listByPersonId(pid);
  const removedPlates = diffRemovedPlates(oldPlates, newPlates);
  if (removedPlates.length > 0) {
    await reconcileAfterPersonChange(pid, { removedPlates });
  }
  return newPlates;
}

/**
 * 平台儲存後推送至 ISAPI 攝影機
 */
async function saveAndSyncPersonLicensePlates(personId, platesInput, oldPlates = []) {
  const pid = Number(personId);
  await savePersonLicensePlatesPlatform(pid, platesInput, oldPlates);
  return syncPersonPlates(pid);
}

module.exports = {
  SYNC_STATUS,
  resolveIsapiTargetsForPersonId,
  savePersonLicensePlatesPlatform,
  saveAndSyncPersonLicensePlates,
  syncPersonPlates,
  syncPlatesForLocation,
  reconcileAfterPersonChange,
  purgePersonPlatesFromDevices,
  reconcileLocationMemberChange,
};
