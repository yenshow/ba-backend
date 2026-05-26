/**
 * ISAPI 佈防訂閱統一中心（生命週期與狀態彙總；各 profile 實作見 PROFILES）
 */
const logger = require("../../utils/logger").createLogger("ISAPI Subscribe Hub");

const PROFILES = [
  {
    key: "access_control",
    label: "門禁",
    service: require("../accessControl/isapiSubscribeService"),
  },
  {
    key: "people_counting",
    label: "人流 PeopleCounting",
    service: require("../peopleCounting/isapiPeopleCountingSubscribeService"),
  },
  {
    key: "vehicle_anpr",
    label: "車牌 ANPR",
    service: require("../vehicleAccess/isapiVehicleSubscribeService"),
  },
];

let hubStarted = false;

async function runAll(run) {
  const results = {};
  await Promise.all(
    PROFILES.map(async (profile) => {
      try {
        results[profile.key] = await run(profile);
      } catch (error) {
        logger.warn(`[ISAPI Hub] ${profile.label} 失敗`, {
          error: error?.message || String(error),
        });
        results[profile.key] = { error: error?.message || String(error) };
      }
    }),
  );
  return results;
}

async function start() {
  if (hubStarted) return getStatus();
  hubStarted = true;
  logger.info("[ISAPI Hub] 啟動佈防訂閱");
  const profiles = await runAll((p) => p.service.start());
  return { started: true, profiles };
}

function stop() {
  hubStarted = false;
  for (const { key, service } of PROFILES) {
    try {
      service.stop();
    } catch (error) {
      logger.warn(`[ISAPI Hub] 停止 ${key} 失敗`, {
        error: error?.message || String(error),
      });
    }
  }
}

async function refresh() {
  return runAll((p) => p.service.refresh());
}

function getStatus() {
  return {
    hubStarted,
    profiles: PROFILES.map(({ key, label, service }) => ({
      key,
      label,
      ...(typeof service.getSubscribeStatus === "function"
        ? service.getSubscribeStatus()
        : { started: hubStarted }),
    })),
  };
}

module.exports = { start, stop, refresh, getStatus };
