/**
 * 電梯梯控卡片同步 job（地點成員 → 設備卡片）
 */
const db = require("../../database/db");
const logger = require("../../utils/logger").createLogger("ElevatorCardSync");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");
const personnelService = require("../personnel/personnelService");
const personLadderCardService = require("../personnel/personLadderCardService");
const personDeviceSyncStateService = require("../personnel/personDeviceSyncStateService");
const sdkCardService = require("../ladderSdk/sdkCardService");
const elevatorService = require("./elevatorService");

const SYNC_DELAY_MS = 300;
const jobs = new Map();

const randomJobId = () =>
  `elevator_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toMessage = (err) => err?.message ?? String(err);

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

const buildCardPayload = (person, ladderCard) => ({
  cardNo: ladderCard.card_no,
  floors: ladderCard.floors,
  homeFloor: ladderCard.home_floor,
  name: person.full_name || person.employee_no,
  employeeNo: person.employee_no,
  password: ladderCard.card_password || undefined,
  cardType: ladderCard.card_type,
  validEnabled: ladderCard.valid_enabled,
  validBegin: ladderCard.valid_begin,
  validEnd: ladderCard.valid_end,
  floorMode: ladderCard.floor_mode || "byte",
});

async function syncLocationCards(locationId, job = null) {
  const { location } = await elevatorService.getElevatorLocationById(locationId);
  const { deviceIds } = elevatorService.getElevatorConfig(location);
  if (!deviceIds.length) {
    throwApiError(C.ELEVATOR_VALIDATION_FAILED, "該地點未設定梯控設備");
  }
  const deviceId = deviceIds[0];

  const persons =
    await personnelService.getPersonsWithAccessByLocationId(locationId);
  const targetCardNos = new Set();
  const warnings = [];

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
      totalOps: persons.length,
      doneOps: 0,
    };
  }

  for (const person of persons) {
    const ladderCard = await personLadderCardService.getByPersonId(person.id);
    if (!ladderCard?.card_no) {
      warnings.push({
        type: "skip_no_card",
        employeeNo: person.employee_no,
        message: "人員未設定梯控卡",
      });
      if (job) job.progress.doneOps += 1;
      continue;
    }

    const cardNo = String(ladderCard.card_no).trim();
    targetCardNos.add(cardNo);
    const payload = buildCardPayload(person, ladderCard);
    const desiredHash = personDeviceSyncStateService.hashLadderCard({
      cardNo: ladderCard.card_no,
      homeFloor: ladderCard.home_floor,
      floors: ladderCard.floors,
      cardType: ladderCard.card_type,
      floorMode: ladderCard.floor_mode,
      cardPassword: ladderCard.card_password,
      validEnabled: ladderCard.valid_enabled,
      validBegin: ladderCard.valid_begin,
      validEnd: ladderCard.valid_end,
    });

    const stateMap = await personDeviceSyncStateService.getStatesForDevice(
      deviceId,
      [person.employee_no],
    );
    const stateRow = stateMap.get(String(person.employee_no));
    const lastHash = stateRow?.card_hash ? String(stateRow.card_hash) : null;

    try {
      if (deviceCardNos.has(cardNo)) {
        if (lastHash && lastHash === desiredHash) {
          await updateLadderCardSyncStatus(person.id, "synced");
          if (job) job.progress.doneOps += 1;
          await sleep(SYNC_DELAY_MS);
          continue;
        }
        await sdkCardService.updateCard(deviceId, cardNo, payload);
      } else {
        await sdkCardService.createCard(deviceId, payload);
        deviceCardNos.add(cardNo);
      }

      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employee_no,
        step: "card",
        status: "synced",
        hash: desiredHash,
      });
      await updateLadderCardSyncStatus(person.id, "synced");
    } catch (err) {
      const message = toMessage(err);
      logger.warn("梯控卡片同步失敗", {
        locationId,
        deviceId,
        employeeNo: person.employee_no,
        error: message,
      });
      await personDeviceSyncStateService.upsertStepState({
        deviceId,
        employeeNo: person.employee_no,
        step: "card",
        status: "failed",
        hash: desiredHash,
        lastErrorMessage: message,
      });
      await updateLadderCardSyncStatus(person.id, "failed", message);
      warnings.push({
        type: "sync_failed",
        employeeNo: person.employee_no,
        deviceId,
        message,
      });
    }

    if (job) job.progress.doneOps += 1;
    await sleep(SYNC_DELAY_MS);
  }

  for (const cardNo of deviceCardNos) {
    if (targetCardNos.has(cardNo)) continue;
    try {
      await sdkCardService.deleteCard(deviceId, cardNo);
    } catch (err) {
      warnings.push({
        type: "delete_failed",
        cardNo,
        deviceId,
        message: toMessage(err),
      });
    }
    await sleep(SYNC_DELAY_MS);
  }

  return { warnings, deviceId };
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "running";
  job.startedAt = Date.now();
  try {
    const { warnings, deviceId } = await syncLocationCards(
      job.locationId,
      job,
    );
    job.status = "completed";
    job.finishedAt = Date.now();
    job.result = { warnings, deviceId };
  } catch (err) {
    job.status = "completed";
    job.finishedAt = Date.now();
    job.error = toMessage(err);
    job.result = { warnings: [] };
  }
}

async function startLocationSyncJob(locationId, _userId) {
  const jobId = randomJobId();
  const job = {
    jobId,
    jobType: "elevator_sync_location",
    locationId: Number(locationId),
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: {},
    result: null,
    error: null,
  };
  jobs.set(jobId, job);
  setImmediate(() => {
    void runJob(jobId);
  });
  return { jobId };
}

function getJob(jobId) {
  const job = jobs.get(String(jobId || "").trim());
  if (!job) {
    throwApiError(C.ELEVATOR_SYNC_JOB_NOT_FOUND, "同步工作不存在");
  }
  return { job };
}

module.exports = {
  startLocationSyncJob,
  getJob,
  syncLocationCards,
};
