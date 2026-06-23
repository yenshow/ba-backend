/**
 * ISAPI 佈防訂閱統一中心（生命週期與狀態彙總；各 profile 實作見 PROFILES）
 */
const logger = require("../../utils/logger").createLogger("ISAPI Subscribe Hub");
const licenseService = require("../license/licenseService");
const effectiveFeaturesCache = require("../license/effectiveFeaturesCache");

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

const PROFILE_FEATURE_KEYS = {
  access_control: "people_counting",
  people_counting: "people_counting",
  vehicle_anpr: "vehicle_access",
};

let hubStarted = false;

const getEnabledProfiles = (licensedFeatures) => {
  if (!Array.isArray(licensedFeatures)) {
    return [];
  }
  const licensed = new Set(
    licensedFeatures.filter((key) => typeof key === "string"),
  );
  return PROFILES.filter((profile) => {
    const featureKey = PROFILE_FEATURE_KEYS[profile.key];
    return featureKey ? licensed.has(featureKey) : true;
  });
};

async function runAll(run, profiles = PROFILES) {
  const results = {};
  await Promise.all(
    profiles.map(async (profile) => {
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

async function start({ licensedFeatures } = {}) {
  return reconcile({ licensedFeatures });
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

async function reconcile({ licensedFeatures } = {}) {
  const features = await resolveLicensedFeatures(licensedFeatures);
  const enabledProfiles = getEnabledProfiles(features);
  const enabledKeys = new Set(enabledProfiles.map((profile) => profile.key));

  for (const profile of PROFILES) {
    if (enabledKeys.has(profile.key)) {
      continue;
    }
    try {
      profile.service.stop();
    } catch (error) {
      logger.warn(`[ISAPI Hub] 停止 ${profile.key} 失敗`, {
        error: error?.message || String(error),
      });
    }
  }

  if (enabledProfiles.length === 0) {
    hubStarted = false;
    return { started: false, profileKeys: [] };
  }

  hubStarted = true;
  await runAll((profile) => {
    if (typeof profile.service.refresh === "function") {
      return profile.service.refresh();
    }
    return profile.service.start();
  }, enabledProfiles);

  return {
    started: true,
    profileKeys: enabledProfiles.map((profile) => profile.key),
  };
}

async function resolveLicensedFeatures(licensedFeatures) {
  if (Array.isArray(licensedFeatures)) {
    return licensedFeatures;
  }
  const cached = effectiveFeaturesCache.getCachedEffectiveFeatures();
  if (cached.length > 0) {
    return cached;
  }
  return licenseService.getEffectiveLicensedFeatures();
}

async function refreshProfiles(profileKeys, { licensedFeatures } = {}) {
  const features = await resolveLicensedFeatures(licensedFeatures);
  let enabledProfiles = getEnabledProfiles(features);

  if (profileKeys != null) {
    const keys = (Array.isArray(profileKeys) ? profileKeys : [profileKeys]).filter(
      Boolean,
    );
    if (keys.length === 0) {
      return {};
    }
    const keySet = new Set(keys);
    enabledProfiles = enabledProfiles.filter((p) => keySet.has(p.key));
  }

  if (enabledProfiles.length === 0) {
    return {};
  }
  return runAll((p) => p.service.refresh(), enabledProfiles);
}

async function refresh(options) {
  return refreshProfiles(null, options);
}

/** 依 license feature 刷新對應 ISAPI profile（供地點 CRUD 增量啟停） */
async function refreshForFeature(featureKey, options = {}) {
  const keys = PROFILES.filter(
    (profile) => PROFILE_FEATURE_KEYS[profile.key] === featureKey,
  ).map((profile) => profile.key);
  return refreshProfiles(keys, options);
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

/**
 * 各設備目前參與的 ISAPI 佈防 profile（供設備管理頁顯示）
 * @returns {{ hubStarted: boolean, byDevice: Record<string, string[]> }}
 */
function getDeviceProfileMap() {
  const byDevice = {};
  const add = (deviceId, profileKey) => {
    const id = Number(deviceId);
    if (!Number.isFinite(id) || id <= 0) return;
    const key = String(id);
    if (!byDevice[key]) byDevice[key] = [];
    if (!byDevice[key].includes(profileKey)) byDevice[key].push(profileKey);
  };

  for (const { key, service } of PROFILES) {
    if (typeof service.getSubscribeStatus !== "function") continue;
    const status = service.getSubscribeStatus();
    if (key === "people_counting") {
      for (const sub of status.subs || []) {
        if (sub?.deviceId != null) add(sub.deviceId, key);
      }
      continue;
    }
    for (const deviceId of status.deviceIds || []) {
      add(deviceId, key);
    }
  }

  return { hubStarted, byDevice };
}

module.exports = {
  start,
  stop,
  refresh,
  refreshForFeature,
  reconcile,
  getStatus,
  getDeviceProfileMap,
};
