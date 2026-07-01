/**
 * 電梯梯控設備同步 job（地點樓層授權 + 人員梯控卡 → 設備）
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("ElevatorFloorSync");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const personLadderCardService = require("../personnel/personLadderCardService");
const personDeviceSyncStateService = require("../personnel/personDeviceSyncStateService");
const sdkCardService = require("../ladderSdk/sdkCardService");
const elevatorService = require("./elevatorService");
const {
  getElevatorConfigFromLocation,
  buildPersonFloorAccessView,
} = require("./elevatorFloorModel");
const elevatorFloorAccessService = require("./elevatorFloorAccessService");
const personSyncJobService = require("../personnel/personSyncJobService");
const personSyncJobStore = require("../personnel/personSyncJobStore");
const { getDeviceNameByIds } = require("../../utils/deviceHelpers");
const { pushPersonSyncWarning } = require("../../utils/personDisplayUtils");

const SYNC_DELAY_MS = 300;

const randomJobId = () =>
  `elevator_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toMessage = (err) => err?.message ?? String(err);

const flushJobProgress = (job, force = false) => {
  if (job?._flushProgress) {
    void job._flushProgress(force);
  }
};

const updateLadderCardSyncStatus = async (personId, status, error = null) => {
  await db.query(
    `UPDATE person_ladder_cards
     SET sdk_sync_status = ?,
         sdk_sync_error = ?,
         sdk_synced_at = CASE WHEN ? = 'synced' THEN CURRENT_TIMESTAMP ELSE sdk_synced_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE person_id = ?`,
    [status, error, status, Number(personId)],
  );
};

const buildLadderIdentity = (person) => ({
  name: String(person.full_name || person.employee_no || "").trim(),
  employeeNo: Number(person.id) > 0 ? Number(person.id) : 0,
});

const buildCardPayload = (person, floors, cardNo) => {
  const { cardPassword, ...fields } = personLadderCardService.resolveSyncFields(
    person,
    floors,
    cardNo,
  );
  const identity = buildLadderIdentity(person);
  return {
    ...fields,
    cardNo: cardNo || fields.cardNo,
    name: identity.name,
    employeeNo: identity.employeeNo > 0 ? identity.employeeNo : undefined,
    password: cardPassword || undefined,
  };
};

const buildLadderDesiredHash = (person, floors, resolved) => {
  const identity = buildLadderIdentity(person);
  const cardKey =
    Array.isArray(resolved.cardNos) && resolved.cardNos.length
      ? resolved.cardNos.join("|")
      : resolved.cardNo;
  return personDeviceSyncStateService.hashLadderCard({
    cardNo: cardKey,
    homeFloor: resolved.homeFloor,
    floors,
    cardType: resolved.cardType,
    floorMode: resolved.floorMode,
    cardPassword: resolved.cardPassword,
    validEnabled: resolved.validEnabled,
    validBegin: resolved.validBegin,
    validEnd: resolved.validEnd,
    name: identity.name,
    employeeNo: identity.employeeNo,
  });
};

async function syncLocationToDevice(
  locationId,
  deviceId,
  job = null,
  deviceNameById = null,
  floorCtx = null,
) {
  const persons =
    await elevatorFloorAccessService.getPersonsWithFloorAccess(locationId);
  const warnings = [];
  const deviceName = deviceNameById?.get(Number(deviceId)) ?? null;

  let deviceCards = [];
  try {
    const listResult = await sdkCardService.listCards(deviceId);
    deviceCards = Array.isArray(listResult?.cards)
      ? listResult.cards
      : Array.isArray(listResult)
        ? listResult
        : [];
  } catch (err) {
    throwApiError(
      C.ELEVATOR_OPERATION_FAILED,
      `讀取設備卡片失敗: ${toMessage(err)}`,
    );
  }

  const deviceCardNos = new Set(
    deviceCards
      .map((c) => (c?.cardNo != null ? String(c.cardNo).trim() : ""))
      .filter(Boolean),
  );

  if (job) {
    job.progress = {
      ...job.progress,
      targetPersonsTotal: persons.length,
      deviceId,
      totalOps: (job.progress?.totalOps || 0) + persons.length,
    };
    flushJobProgress(job, true);
  }

  for (const person of persons) {
    const ladderCard = await personLadderCardService.getByPersonId(person.id);
    const syncFields = personLadderCardService.resolveSyncFields(person, []);
    const cardNos = Array.isArray(syncFields.cardNos)
      ? syncFields.cardNos.map((c) => String(c).trim()).filter(Boolean)
      : [];
    if (!cardNos.length) {
      pushPersonSyncWarning(warnings, person, {
        type: "skip_no_card",
        message: "人員未設定卡號（請於人員主檔卡片設定填寫）",
      });
      if (job) {
        job.progress.doneOps = (job.progress.doneOps || 0) + 1;
        flushJobProgress(job);
      }
      continue;
    }
    if (!ladderCard) {
      pushPersonSyncWarning(warnings, person, {
        type: "skip_no_ladder_floors",
        message: "人員未設定梯控授權樓層",
      });
      if (job) {
        job.progress.doneOps = (job.progress.doneOps || 0) + 1;
        flushJobProgress(job);
      }
      continue;
    }

    const floors = floorCtx
      ? buildPersonFloorAccessView(
          floorCtx.configFloors,
          floorCtx.accessIndexByPerson.get(person.id) || [],
        ).authorized_ladder_gateways
      : await elevatorFloorAccessService.aggregateFloorsForPerson(
          locationId,
          person.id,
        );
    if (!floors.length) {
      pushPersonSyncWarning(warnings, person, {
        type: "skip_no_floors",
        message: "人員未授權任何樓層",
      });
      if (job) {
        job.progress.doneOps = (job.progress.doneOps || 0) + 1;
        flushJobProgress(job);
      }
      continue;
    }

    const resolved = personLadderCardService.resolveSyncFields(person, floors);
    const desiredHash = buildLadderDesiredHash(person, floors, resolved);

    const stateMap = await personDeviceSyncStateService.getStatesForDevice(
      deviceId,
      [person.employee_no],
    );
    const stateRow = stateMap.get(String(person.employee_no));
    const lastHash = stateRow?.card_hash ? String(stateRow.card_hash) : null;

    let personSyncFailed = false;
    let personSyncMessage = null;

    for (const cardNo of cardNos) {
      const payload = buildCardPayload(person, floors, cardNo);

      try {
        if (deviceCardNos.has(cardNo)) {
          if (lastHash && lastHash === desiredHash) {
            continue;
          }
          await sdkCardService.updateCard(deviceId, cardNo, payload);
        } else {
          await sdkCardService.createCard(deviceId, payload);
          deviceCardNos.add(cardNo);
        }
      } catch (err) {
        personSyncFailed = true;
        personSyncMessage = toMessage(err);
        logger.warn("梯控卡片同步失敗", {
          locationId,
          deviceId,
          employeeNo: person.employee_no,
          cardNo,
          error: personSyncMessage,
        });
      }

      if (job) {
        job.progress.doneOps = (job.progress.doneOps || 0) + 1;
        flushJobProgress(job);
      }
      await sleep(SYNC_DELAY_MS);
    }

    if (lastHash && lastHash === desiredHash && !personSyncFailed) {
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employee_no,
        step: "card",
        status: "synced",
        hash: desiredHash,
      });
      await updateLadderCardSyncStatus(person.id, "synced");
      continue;
    }

    if (personSyncFailed) {
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employee_no,
        step: "card",
        status: "failed",
        hash: desiredHash,
        lastErrorMessage: personSyncMessage,
      });
      await updateLadderCardSyncStatus(person.id, "failed", personSyncMessage);
      pushPersonSyncWarning(warnings, person, {
        type: "sync_failed",
        deviceId,
        deviceName,
        message: personSyncMessage,
      });
    } else {
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employee_no,
        step: "card",
        status: "synced",
        hash: desiredHash,
      });
      await updateLadderCardSyncStatus(person.id, "synced");
    }
  }

  const targetEmployeeNos = new Set(
    persons.map((p) => String(p.employee_no)),
  );
  const platformSyncedByDevice =
    await personDeviceSyncStateService.getSyncedEmployeeNosByDeviceIds([
      deviceId,
    ]);
  const platformSynced =
    platformSyncedByDevice.get(Number(deviceId)) ?? new Set();
  const removedSyncedEmployees = [...platformSynced].filter(
    (eno) => !targetEmployeeNos.has(String(eno)),
  );
  const deletableCardNos = removedSyncedEmployees.length
    ? await personDeviceSyncStateService.getCardNosForEmployeeNos(
        removedSyncedEmployees,
      )
    : new Set();

  for (const cardNo of deviceCardNos) {
    if (!deletableCardNos.has(cardNo)) continue;
    try {
      await sdkCardService.deleteCard(deviceId, cardNo);
    } catch (err) {
      if (err?.code === C.LADDER_SDK_CARD_NOT_FOUND) continue;
      warnings.push({
        type: "delete_failed",
        cardNo,
        deviceId,
        deviceName,
        message: toMessage(err),
      });
    }
    await sleep(SYNC_DELAY_MS);
  }

  return { warnings, deviceId };
}

async function syncLocationCards(locationId, job = null) {
  const { location } = await elevatorService.getElevatorLocationById(locationId);
  const { ladderDevice, accessDeviceIds } =
    elevatorService.getElevatorConfig(location);
  const ladderDeviceIds = ladderDevice?.deviceId ? [ladderDevice.deviceId] : [];
  if (!ladderDeviceIds.length && !accessDeviceIds.length) {
    throwApiError(
      C.ELEVATOR_VALIDATION_FAILED,
      "該地點未設定梯控或門禁設備",
    );
  }

  const hasAccess = await elevatorFloorAccessService.getPersonIdsWithFloorAccess(
    locationId,
  );
  if (!hasAccess.length) {
    throwApiError(
      C.ELEVATOR_VALIDATION_FAILED,
      "此地點尚未設定樓層授權，請先完成樓層管理步驟 1",
    );
  }

  if (job) {
    job.progress = {
      ...job.progress,
      doneOps: 0,
      totalOps: 0,
    };
    flushJobProgress(job, true);
  }

  const allWarnings = [];
  const syncedDeviceIds = [];
  const syncedAccessDeviceIds = [];
  const deviceNameById = await getDeviceNameByIds([
    ...ladderDeviceIds,
    ...accessDeviceIds,
  ]);

  const configFloors = getElevatorConfigFromLocation(location).floors || [];
  const accessIndexByPerson =
    await elevatorFloorAccessService.getFloorAccessIndexByPerson(locationId);
  const floorCtx = { configFloors, accessIndexByPerson };

  if (ladderDeviceIds.length) {
    for (const deviceId of ladderDeviceIds) {
      const { warnings, deviceId: syncedId } = await syncLocationToDevice(
        locationId,
        deviceId,
        job,
        deviceNameById,
        floorCtx,
      );
      allWarnings.push(...warnings);
      syncedDeviceIds.push(syncedId);
    }
  }

  if (accessDeviceIds.length) {
    const persons =
      await elevatorFloorAccessService.getPersonsWithFloorAccess(locationId);
    const { warnings: accessWarnings } =
      await personSyncJobService.syncPersonsToAccessDevices({
        deviceIds: accessDeviceIds,
        persons,
        warnings: [],
      });
    allWarnings.push(...accessWarnings);
    syncedAccessDeviceIds.push(...accessDeviceIds);
  }

  return {
    warnings: allWarnings,
    deviceId: syncedDeviceIds[0] ?? syncedAccessDeviceIds[0] ?? null,
    deviceIds: syncedDeviceIds,
    accessDeviceIds: syncedAccessDeviceIds,
  };
}

const toElevatorJobView = (stored) => {
  if (!stored) return null;
  return {
    jobId: stored.jobId,
    status: stored.status,
    progress: stored.progress || {},
    result: stored.result || null,
    error: stored.error?.message ?? null,
  };
};

async function startLocationSyncJob(locationId, _userId) {
  const jobId = randomJobId();
  const locId = Number(locationId);
  const progress = { doneOps: 0, totalOps: 0 };

  await personSyncJobStore.createJob({
    jobId,
    jobType: "elevator_sync_location",
    locationId: locId,
    status: "queued",
    progress,
    itemsMeta: {},
  });

  void (async () => {
    const job = {
      jobId,
      locationId: locId,
      status: "running",
      progress,
      result: null,
      error: null,
    };
    let lastProgressFlushAt = 0;
    job._flushProgress = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressFlushAt < 2000) return;
      lastProgressFlushAt = now;
      await personSyncJobStore.updateJob(jobId, {
        progress: { ...job.progress },
      });
    };
    const startedAt = Date.now();
    try {
      await personSyncJobStore.updateJob(jobId, {
        status: "running",
        startedAt,
        progress,
      });
      const result = await syncLocationCards(locId, job);
      const finishedAt = Date.now();
      job.status = "completed";
      job.finishedAt = finishedAt;
      job.result = result;
      await personSyncJobStore.replaceWarnings(
        jobId,
        result?.warnings ?? [],
        locId,
      );
      await personSyncJobStore.updateJob(jobId, {
        status: "completed",
        finishedAt,
        progress: job.progress,
        result,
        error: null,
      });
    } catch (err) {
      const finishedAt = Date.now();
      job.status = "completed";
      job.finishedAt = finishedAt;
      job.error = toMessage(err);
      job.result = { warnings: [] };
      await personSyncJobStore.updateJob(jobId, {
        status: "completed",
        finishedAt,
        progress: job.progress,
        result: job.result,
        error: { message: toMessage(err) },
      });
    }
  })();

  return { jobId };
}

async function getJob(jobId) {
  const stored = await personSyncJobStore.getJob(String(jobId || "").trim());
  if (!stored) {
    throwApiError(C.ELEVATOR_SYNC_JOB_NOT_FOUND, "同步工作不存在");
  }
  return { job: toElevatorJobView(stored) };
}

function mapCardSyncStatus(raw) {
  const s = String(raw || "").trim();
  if (s === "synced" || s === "success") return "success";
  if (s === "failed") return "failed";
  if (s === "unchanged") return "unchanged";
  if (s === "no_data") return "no_data";
  return s || "no_data";
}

async function getSyncCandidatesForLocation(locationId) {
  const { location } = await elevatorService.getElevatorLocationById(locationId);
  const configFloors = getElevatorConfigFromLocation(location).floors || [];
  const { ladderDevice, accessDeviceIds } =
    elevatorService.getElevatorConfig(location);
  const ladderDeviceIds = ladderDevice?.deviceId ? [ladderDevice.deviceId] : [];
  const [persons, accessIndexByPerson] = await Promise.all([
    elevatorFloorAccessService.getPersonsWithFloorAccess(locationId),
    elevatorFloorAccessService.getFloorAccessIndexByPerson(locationId),
  ]);
  const employeeNos = persons.map((p) => String(p.employee_no));

  const stateMaps = [];
  for (const deviceId of ladderDeviceIds) {
    stateMaps.push({
      deviceId,
      map: await personDeviceSyncStateService.getStatesForDevice(
        deviceId,
        employeeNos,
      ),
    });
  }

  const accessFieldsByEmployeeNo = new Map();
  if (accessDeviceIds.length) {
    const accessRows = await personSyncJobService.buildAccessSyncFieldsForPersons(
      persons,
      accessDeviceIds,
    );
    persons.forEach((person, idx) => {
      const row = accessRows[idx];
      if (row) {
        accessFieldsByEmployeeNo.set(String(person.employee_no), row);
      }
    });
  }

  const results = [];
  for (const person of persons) {
    const ladderCard = await personLadderCardService.getByPersonId(person.id);
    const logicalIndices = accessIndexByPerson.get(person.id) || [];
    const floorAccess = buildPersonFloorAccessView(configFloors, logicalIndices);
    const ladderGateways = floorAccess.authorized_ladder_gateways;
    const resolved = personLadderCardService.resolveSyncFields(person, ladderGateways);
    const cardNos = Array.isArray(resolved.cardNos)
      ? resolved.cardNos.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const desiredHash = cardNos.length
      ? buildLadderDesiredHash(person, ladderGateways, resolved)
      : null;

    let cardStatus = "no_data";
    let cardSyncedAt = null;
    let needsSync = false;

    if (!cardNos.length) {
      needsSync = true;
    } else if (!ladderDeviceIds.length) {
      needsSync = true;
    } else {
      let allSynced = true;
      for (const { map } of stateMaps) {
        const row = map.get(String(person.employee_no));
        if (!row) {
          allSynced = false;
          continue;
        }
        const ok =
          String(row.card_status || "") === "synced" &&
          String(row.card_hash || "") === String(desiredHash || "");
        if (!ok) allSynced = false;
        if (row.card_synced_at) {
          cardSyncedAt = row.card_synced_at;
        }
        cardStatus = mapCardSyncStatus(row.card_status);
      }
      needsSync = !allSynced;
    }

    const accessRow = accessFieldsByEmployeeNo.get(String(person.employee_no));
    const needsAccessSync = Boolean(accessRow?.needs_sync);
    results.push({
      employee_no: person.employee_no,
      full_name: person.full_name,
      has_ladder_card: Boolean(cardNos.length && ladderCard),
      authorized_floor_labels: floorAccess.authorized_floor_labels,
      authorized_ladder_gateways: floorAccess.authorized_ladder_gateways,
      needs_sync: needsSync || needsAccessSync,
      needs_ladder_sync: needsSync,
      needs_access_sync: needsAccessSync,
      last_sync: {
        card: {
          status: cardStatus,
          at: cardSyncedAt,
        },
        ...(accessRow?.last_sync ? { access: accessRow.last_sync } : {}),
      },
    });
  }

  return {
    persons: results,
    hasAccessDevices: accessDeviceIds.length > 0,
  };
}

module.exports = {
  startLocationSyncJob,
  getJob,
  syncLocationCards,
  getSyncCandidatesForLocation,
};
