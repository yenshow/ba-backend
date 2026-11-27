/**
 * 一人同步 job（person_sync）：只編排單人設備寫入，不重推整地點名單
 */
const db = require("../../database/db");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const personSyncJobStore = require("./personSyncJobStore");
const personSyncJobService = require("./personSyncJobService");
const personSyncDeviceOps = require("./personSyncDeviceOps");
const personnelService = require("./personnelService");
const personSyncJobConflictWait = require("./personSyncJobConflictWait");
const { sleep, toPositiveIds } = personSyncJobConflictWait;
const {
  PROGRESS_FLUSH_MS,
  STEP_DELAY_MS,
} = require("../../config/deviceSyncTiming");
const logger = require("../../utils/logger").createLogger(
  "PersonScopedSyncJobService",
);

const toMessage = (err) => err?.message ?? String(err);

function trackJobWrite(job, promise) {
  if (!job?.pendingWrites) return promise;
  const p = Promise.resolve(promise).finally(() => {
    job.pendingWrites.delete(p);
  });
  job.pendingWrites.add(p);
  return p;
}

function createPersonJobReporter(job) {
  const progress = job.progress;
  return {
    setTotals: (patch) => {
      Object.assign(progress, patch || {});
      job._flushProgress?.(true);
    },
    markDevice: ({ deviceId, deviceIndex, deviceTotal }) => {
      progress.currentDeviceId = deviceId ?? null;
      if (deviceIndex != null) progress.currentDeviceIndex = deviceIndex;
      if (deviceTotal != null) progress.deviceTotal = deviceTotal;
      job._flushProgress?.();
    },
    startOp: ({ employeeNo, deviceId, action, stage }) => {
      progress.currentEmployeeNo = employeeNo ?? null;
      progress.currentDeviceId = deviceId ?? null;
      progress.currentAction = action ?? null;
      progress.currentStage = stage ?? null;
      progress.attempted = (progress.attempted || 0) + 1;
      job._flushProgress?.();
      return Date.now();
    },
    finishOp: ({ employeeNo, deviceId, action, stage, startedAt, ok, message }) => {
      progress.completed = (progress.completed || 0) + 1;
      if (ok) progress.succeeded = (progress.succeeded || 0) + 1;
      else progress.failed = (progress.failed || 0) + 1;
      progress.currentEmployeeNo = employeeNo ?? null;
      progress.currentDeviceId = deviceId ?? null;
      progress.currentAction = action ?? null;
      progress.currentStage = stage ?? null;
      job._flushProgress?.();
      const payload = {
        employeeNo: employeeNo ?? null,
        deviceId: deviceId ?? null,
        action: action ?? null,
        stage: stage ?? null,
        ok: Boolean(ok),
        message: message || null,
        durationMs:
          startedAt != null ? Math.max(0, Date.now() - Number(startedAt)) : null,
        at: Date.now(),
      };
      trackJobWrite(job, personSyncJobStore.appendItem(job.jobId, "tail", payload));
      if (!ok) {
        trackJobWrite(
          job,
          personSyncJobStore.appendItem(job.jobId, "issues", payload),
        );
      }
    },
    skipOp: ({ employeeNo, deviceId, action, stage, message }) => {
      progress.skipped = (progress.skipped || 0) + 1;
      progress.completed = (progress.completed || 0) + 1;
      job._flushProgress?.();
      trackJobWrite(
        job,
        personSyncJobStore.appendItem(job.jobId, "tail", {
          employeeNo: employeeNo ?? null,
          deviceId: deviceId ?? null,
          action: action ?? null,
          stage: stage ?? null,
          ok: true,
          skipped: true,
          message: message || "略過",
          at: Date.now(),
        }),
      );
    },
  };
}

async function findRunningPersonSyncJob(personId) {
  const pid = String(Math.trunc(Number(personId)));
  const rows = await db.query(
    `
      SELECT job_id FROM person_sync_jobs
      WHERE job_type = 'person_sync'
        AND status IN ('queued', 'running')
        AND progress->>'personId' = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [pid],
  );
  return rows?.[0]?.job_id || null;
}

async function resolveAccessLocationIdsForPerson(personId, locationIdsFilter) {
  const pid = Number(personId);
  const rows = await db.query(
    `SELECT location_id FROM person_location_access WHERE person_id = ?`,
    [pid],
  );
  let ids = (rows || [])
    .map((r) => Number(r.location_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  const filter = toPositiveIds(locationIdsFilter);
  if (filter.length) {
    const set = new Set(filter);
    ids = ids.filter((id) => set.has(id));
  }
  return ids;
}

async function resolveElevatorLocationIdsForPerson(personId, locationIdsFilter) {
  const pid = Number(personId);
  const rows = await db.query(
    `SELECT DISTINCT location_id FROM person_elevator_floor_access WHERE person_id = ?`,
    [pid],
  );
  let ids = (rows || [])
    .map((r) => Number(r.location_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  const filter = toPositiveIds(locationIdsFilter);
  if (filter.length) {
    const set = new Set(filter);
    ids = ids.filter((id) => set.has(id));
  }
  return ids;
}

async function syncPersonAccessAtLocation(person, locationId, warnings, reporter) {
  const devs =
    await personSyncJobService.getPeopleCountingDevicesForLocation(locationId);
  if (!devs) return;
  const accessDeviceIds = [
    ...new Set([
      ...(devs.entryDeviceIds || []),
      ...(devs.exitDeviceIds || []),
    ]),
  ];
  if (accessDeviceIds.length) {
    await personSyncDeviceOps.syncSinglePersonToAccessDevices(
      accessDeviceIds,
      person,
      warnings,
      reporter,
      { forceUserInfo: true, locationId },
    );
  }
  const cameraDeviceIds = devs.cameraDeviceIds || [];
  if (cameraDeviceIds.length) {
    await personSyncDeviceOps.syncSinglePersonToCameraDevices(
      cameraDeviceIds,
      person,
      warnings,
      reporter,
      { locationId, cameraChannelId: devs.cameraChannelId },
    );
  }
}

async function removePersonAccessAtLocation(
  employeeNo,
  locationId,
  warnings,
  reporter,
) {
  const devs =
    await personSyncJobService.getPeopleCountingDevicesForLocation(locationId);
  if (!devs) return;
  const accessDeviceIds = [
    ...new Set([
      ...(devs.entryDeviceIds || []),
      ...(devs.exitDeviceIds || []),
    ]),
  ];
  if (accessDeviceIds.length) {
    await personSyncDeviceOps.removeSinglePersonFromAccessDevices(
      accessDeviceIds,
      employeeNo,
      warnings,
      reporter,
      { locationId },
    );
  }
  const cameraDeviceIds = devs.cameraDeviceIds || [];
  if (cameraDeviceIds.length) {
    await personSyncDeviceOps.removeSinglePersonFromCameraDevices(
      cameraDeviceIds,
      employeeNo,
      warnings,
      reporter,
      { locationId },
    );
  }
}

async function syncPersonElevatorAtLocation(personRow, locationId, warnings, job) {
  try {
    const elevatorFloorSyncJobService = require("../elevator/elevatorFloorSyncJobService");
    const persons = [
      {
        id: personRow.id,
        employee_no: personRow.employee_no,
        full_name: personRow.full_name,
        face_url: personRow.face_url || null,
        config: personRow.config,
      },
    ];
    const { warnings: elevWarnings } =
      await elevatorFloorSyncJobService.syncPersonsOnLocation(
        locationId,
        persons,
        job,
      );
    warnings.push(...(elevWarnings || []));
  } catch (err) {
    warnings.push({
      type: "elevator",
      locationId,
      employeeNo: personRow?.employee_no,
      message: toMessage(err),
    });
  }
}

async function runPersonSync(job, params) {
  const personId = Number(params.personId);
  const domains = new Set(
    (Array.isArray(params.domains) && params.domains.length
      ? params.domains
      : ["access", "plates", "elevator"]
    ).map((d) => String(d)),
  );
  const grantLocationIds = toPositiveIds(params.grantLocationIds);
  const revokeLocationIds = toPositiveIds(params.revokeLocationIds);
  const locationIdsFilter =
    params.locationIds == null ? null : toPositiveIds(params.locationIds);

  const personRow = await personnelService.getPersonById(personId);
  if (!personRow) {
    throwApiError(C.PERSONNEL_PERSON_NOT_FOUND, "人員不存在", {
      statusCode: 404,
    });
  }

  const person = {
    employeeNo: String(personRow.employee_no),
    name: personRow.full_name || personRow.employee_no,
    face_url: personRow.face_url || null,
    config: personRow.config || null,
  };

  const warnings = [];
  const reporter = createPersonJobReporter(job);

  const accessLocIds = await resolveAccessLocationIdsForPerson(
    personId,
    locationIdsFilter,
  );
  const elevatorLocIds = domains.has("elevator")
    ? await resolveElevatorLocationIdsForPerson(personId, locationIdsFilter)
    : [];

  /** 增量授權：只同步 grant；一般同步：全部仍授權地點；revoke 另刪設備 */
  let accessSyncList = accessLocIds;
  if (grantLocationIds.length) {
    accessSyncList = grantLocationIds;
  } else if (revokeLocationIds.length && !grantLocationIds.length) {
    accessSyncList = [];
  }

  const waitIds = [
    ...new Set([...accessSyncList, ...elevatorLocIds, ...revokeLocationIds]),
  ];
  job.progress.touchLocationIds = waitIds;
  job.progress.waitMessage = waitIds.length
    ? "等待地點同步釋放設備…"
    : null;
  job._flushProgress?.(true);
  await personSyncJobConflictWait.waitForConflictingLocationJobs(waitIds);
  job.progress.waitMessage = null;
  job._flushProgress?.(true);

  reporter.setTotals({
    targetPersonsTotal: 1,
    total:
      accessSyncList.length + revokeLocationIds.length + elevatorLocIds.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    attempted: 0,
  });

  if (domains.has("access")) {
    for (const locationId of revokeLocationIds) {
      job.progress.currentLocationId = locationId;
      job._flushProgress?.(true);
      await removePersonAccessAtLocation(
        person.employeeNo,
        locationId,
        warnings,
        reporter,
      );
      if (STEP_DELAY_MS > 0) await sleep(STEP_DELAY_MS);
    }
    for (const locationId of accessSyncList) {
      job.progress.currentLocationId = locationId;
      job._flushProgress?.(true);
      if (String(personRow.status || "") !== "active") {
        reporter.skipOp({
          employeeNo: person.employeeNo,
          deviceId: null,
          action: "sync",
          stage: "person",
          message: "人員非啟用，略過下發",
        });
        continue;
      }
      await syncPersonAccessAtLocation(person, locationId, warnings, reporter);
      if (STEP_DELAY_MS > 0) await sleep(STEP_DELAY_MS);
    }
  }

  if (domains.has("plates") && String(personRow.status || "") === "active") {
    try {
      const vehiclePlateSyncService = require("../vehicleAccess/vehiclePlateSyncService");
      job.progress.currentStage = "plates";
      job._flushProgress?.(true);
      const plateResult =
        await vehiclePlateSyncService.syncPersonPlates(personId);
      if (plateResult?.failures?.length) {
        for (const f of plateResult.failures) {
          warnings.push({
            type: "plates",
            employeeNo: person.employeeNo,
            message: f?.message || String(f),
          });
        }
      }
    } catch (err) {
      warnings.push({
        type: "plates",
        employeeNo: person.employeeNo,
        message: toMessage(err),
      });
    }
  }

  if (domains.has("elevator") && String(personRow.status || "") === "active") {
    for (const locationId of elevatorLocIds) {
      job.progress.currentLocationId = locationId;
      job.progress.currentStage = "elevator";
      job._flushProgress?.(true);
      await syncPersonElevatorAtLocation(personRow, locationId, warnings, job);
      if (STEP_DELAY_MS > 0) await sleep(STEP_DELAY_MS);
    }
  }

  return {
    warnings,
    result: {
      personId,
      accessSynced: accessSyncList,
      accessRevoked: revokeLocationIds,
      elevatorSynced: elevatorLocIds,
      warningCount: warnings.length,
    },
  };
}

async function startPersonSyncJob(personId, options = {}) {
  const pid = Number(personId);
  if (!Number.isFinite(pid) || pid <= 0) {
    throwApiError(C.PERSONNEL_VALIDATION_FAILED, "無效的人員 ID");
  }

  const existing = await findRunningPersonSyncJob(pid);
  if (existing) {
    return { jobId: existing, reused: true };
  }

  const jobId = `personsync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const progress = {
    personId: pid,
    total: 0,
    attempted: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    deviceTotal: 0,
    currentDeviceIndex: 0,
    currentDeviceId: null,
    currentLocationId: null,
    currentEmployeeNo: null,
    currentAction: null,
    currentStage: null,
    waitMessage: null,
    domains: Array.isArray(options.domains) ? options.domains : ["access", "plates", "elevator"],
    locationIds: options.locationIds ?? null,
    grantLocationIds: options.grantLocationIds || [],
    revokeLocationIds: options.revokeLocationIds || [],
  };

  await personSyncJobStore.createJob({
    jobId,
    jobType: "person_sync",
    locationId: null,
    status: "queued",
    progress,
    itemsMeta: { issuesTotal: 0, tailTotal: 0, issuesStored: 0, tailStored: 0 },
  });

  const execute = async () => {
    const job = { jobId, locationId: null, progress, pendingWrites: new Set() };
    let lastProgressFlushAt = 0;
    job._flushProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressFlushAt < PROGRESS_FLUSH_MS) return;
      lastProgressFlushAt = now;
      trackJobWrite(
        job,
        personSyncJobStore.updateJob(jobId, { progress: { ...job.progress } }),
      );
    };

    let result = null;
    let error = null;
    const warnings = [];
    try {
      await personSyncJobStore.updateJob(jobId, {
        status: "running",
        startedAt: Date.now(),
        progress,
      });
      const outcome = await runPersonSync(job, {
        personId: pid,
        domains: options.domains,
        locationIds: options.locationIds,
        grantLocationIds: options.grantLocationIds,
        revokeLocationIds: options.revokeLocationIds,
      });
      warnings.push(...(outcome.warnings || []));
      result = outcome.result;
      await personSyncJobStore.replaceWarnings(jobId, warnings, null);
    } catch (err) {
      error = { message: toMessage(err) };
      logger.warn("person_sync 失敗", { jobId, personId: pid, error: error.message });
    }
    await Promise.all(job.pendingWrites);
    await personSyncJobStore.updateJob(jobId, {
      status: "completed",
      finishedAt: Date.now(),
      progress: { ...job.progress },
      result,
      error,
    });
  };

  void execute().catch((err) => {
    logger.error("person_sync 背景執行失敗", {
      jobId,
      error: toMessage(err),
    });
  });

  return { jobId, reused: false };
}

async function getPersonSyncJobView(jobId, options = {}) {
  return personSyncJobService.getSyncLocationJobView(jobId, options);
}

module.exports = {
  startPersonSyncJob,
  getPersonSyncJobView,
};
