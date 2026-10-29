const db = require("../../database/db");
const licenseService = require("./licenseService");
const { parseConfig } = require("../../utils/deviceHelpers");
const {
  collectConfiguredBitPointsFromSystemConfig,
} = require("../devices/modbusDiDoConfig");
const { isValidEnergyParameterKey } = require("../../constants/energyParameterCatalog");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");
const {
  MODBUS_POINT_SYSTEM_TYPES,
  MODBUS_POINT_SYSTEM_TYPE_SET,
} = require("../../constants/licenseQuotaSystems");
const {
  CAMERA_CATEGORY_PEOPLE_COUNTING,
  CAMERA_CATEGORY_LICENSE_PLATE,
  CAMERA_CATEGORY_NVR,
  CAMERA_SURVEILLANCE_CATEGORY_SET,
} = require("../../constants/cameraModelCategories");
const LOCATION_USAGE_SYSTEM_TYPES = [
  ...MODBUS_POINT_SYSTEM_TYPES,
  "elevator",
  "roll_call",
];

const normalizeFeatureKey = (v) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
};

const normalizeCategoryCode = (v) => String(v || "").trim().toLowerCase();

const parseJsonish = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return parseConfig(value) || {};
};

const isHcnetProtocol = (deviceConfig, modelConfig) =>
  String(deviceConfig?.protocol || modelConfig?.protocol || "")
    .trim()
    .toLowerCase() === "hcnet_sdk";

const isNvrCamera = (deviceConfig, categoryCode) =>
  String(deviceConfig?.is_nvr).toLowerCase() === "true" ||
  normalizeCategoryCode(categoryCode) === CAMERA_CATEGORY_NVR;

const isEnergyMeterKind = (modelConfig, deviceConfig) => {
  const kind = String(
    modelConfig?.meterKind || deviceConfig?.meterKind || "",
  )
    .trim()
    .toLowerCase();
  return kind === "electricity" || kind === "water";
};

/**
 * 由 type_code＋型號分類／meterKind／protocol 推出額度 Feature。
 * 攝影機以型號分類為準，不另存、不覆寫。
 */
const resolveQuotaFeature = ({
  typeCode,
  categoryCode,
  modelConfig,
  deviceConfig,
} = {}) => {
  const code = normalizeFeatureKey(typeCode);
  if (!code) return null;

  if (code === "camera") {
    if (isNvrCamera(deviceConfig, categoryCode)) return null;
    const cat = normalizeCategoryCode(categoryCode);
    if (cat === CAMERA_CATEGORY_PEOPLE_COUNTING) return "people_counting";
    if (cat === CAMERA_CATEGORY_LICENSE_PLATE) return "vehicle_access";
    if (CAMERA_SURVEILLANCE_CATEGORY_SET.has(cat)) return "surveillance";
    return null;
  }
  if (code === "access_control") return "people_counting";
  if (code === "video_intercom") return "access_security";
  if (code === "controller") {
    return isHcnetProtocol(deviceConfig, modelConfig) ? "elevator" : null;
  }
  if (code === "sensor") {
    return isEnergyMeterKind(modelConfig, deviceConfig) ? "energy" : "environment";
  }
  return null;
};

const applyQuotaFeatureToConfig = ({
  typeCode,
  categoryCode,
  modelConfig,
  deviceConfig,
} = {}) => {
  const cfg =
    deviceConfig && typeof deviceConfig === "object" ? deviceConfig : {};
  if (Object.prototype.hasOwnProperty.call(cfg, "quotaFeature")) {
    delete cfg.quotaFeature;
  }
  return {
    featureKey: resolveQuotaFeature({
      typeCode,
      categoryCode,
      modelConfig,
      deviceConfig: cfg,
    }),
  };
};

const countEnabledSensorPoints = (deviceConfig, modelConfig) => {
  const energy = isEnergyMeterKind(modelConfig, deviceConfig);
  const loggingValues =
    (Array.isArray(deviceConfig?.logging?.values) &&
    deviceConfig.logging.values.length > 0
      ? deviceConfig.logging.values
      : null) ||
    (Array.isArray(modelConfig?.logging?.values) ? modelConfig.logging.values : []);

  if (loggingValues.length > 0) {
    return loggingValues.filter((v) => {
      if (!v || v.enabled === false) return false;
      if (energy) return isValidEnergyParameterKey(v.name);
      return true;
    }).length;
  }

  const params = Array.isArray(modelConfig?.sensorParameters)
    ? modelConfig.sensorParameters
    : Array.isArray(deviceConfig?.sensorParameters)
      ? deviceConfig.sensorParameters
      : [];
  return params.filter((p) => {
    const addr = p?.modbusConfig?.address;
    if (addr === undefined || addr === null) return false;
    if (energy) return isValidEnergyParameterKey(p.type);
    return true;
  }).length;
};

const normalizeRegisterType = (raw) => {
  const t = String(raw || "")
    .toLowerCase()
    .trim();
  if (
    t === "holding" ||
    t === "holdingregister" ||
    t === "holding_register" ||
    t === "holdingregisters"
  ) {
    return "holding";
  }
  if (t === "input" || t === "inputregister" || t === "input_register") {
    return "input";
  }
  if (t === "coil" || t === "coils" || t === "do") return "coil";
  if (
    t === "discrete" ||
    t === "discreteinput" ||
    t === "discrete_input" ||
    t === "di"
  ) {
    return "discrete";
  }
  return null;
};

const primaryDeviceIdFromSystemConfig = (systemConfig) => {
  const cfg = systemConfig && typeof systemConfig === "object" ? systemConfig : {};
  const primary = Number(Array.isArray(cfg.device_ids) ? cfg.device_ids[0] : NaN);
  return Number.isFinite(primary) && primary > 0 ? primary : null;
};

/** 基礎設施一筆 location_systems 的點數（bit + holding/input） */
const countModbusSystemPoints = (systemConfig) => {
  const cfg = parseJsonish(systemConfig);
  const keys = new Set();
  const add = (deviceId, registerType, address) => {
    if (!deviceId || !registerType || !Number.isFinite(address) || address < 0) {
      return;
    }
    keys.add(`${deviceId}:${registerType}:${address}`);
  };

  for (const p of collectConfiguredBitPointsFromSystemConfig(cfg)) {
    add(p.deviceId, p.registerType, p.address);
  }

  const defaultDeviceId = primaryDeviceIdFromSystemConfig(cfg);
  const statusPoints =
    cfg.status_points && typeof cfg.status_points === "object"
      ? cfg.status_points
      : {};
  for (const def of Object.values(statusPoints)) {
    if (!def || typeof def !== "object") continue;
    const registerType = normalizeRegisterType(def.registerType || def.type);
    if (registerType !== "holding" && registerType !== "input") continue;
    const address = Number(def.address);
    let deviceId = defaultDeviceId;
    if (def.deviceId != null && def.deviceId !== "") {
      const own = Number(def.deviceId);
      if (Number.isFinite(own) && own > 0) deviceId = own;
    }
    add(deviceId, registerType, address);
  }

  return keys.size;
};

/** 電梯樓層偵測 DI 點（與 runtime 讀取區間／floors[].di_address 對齊） */
const countElevatorFloorDiPoints = (systemConfig) => {
  const cfg = parseJsonish(systemConfig);
  const fd = cfg.floor_detection && typeof cfg.floor_detection === "object"
    ? cfg.floor_detection
    : {};
  const floors = Array.isArray(cfg.floors) ? cfg.floors : [];
  const addrs = new Set();
  for (const floor of floors) {
    const a = Number(floor?.di_address ?? floor?.diAddress);
    if (Number.isFinite(a) && a >= 0) addrs.add(a);
  }
  if (addrs.size > 0) return addrs.size;

  const start = Number(fd.point_start ?? fd.pointStart);
  const endRaw = fd.point_end ?? fd.pointEnd;
  const end = Number(endRaw);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return end - start + 1;
  }
  if (Number.isFinite(start) && floors.length > 0) {
    return floors.length;
  }
  return 0;
};

const throwQuotaExceeded = (featureKey, used, max) => {
  throw createApiError(C.LICENSE_QUOTA_EXCEEDED, "已達到授權配額上限", {
    details: { feature: featureKey, used, max },
  });
};

const assertWithinMax = (featureKey, used, rawMax) => {
  const max = rawMax == null ? null : Math.floor(Number(rawMax));
  if (!Number.isFinite(max) || max < 0) return;
  if (used > max) throwQuotaExceeded(featureKey, used, max);
};

const assertFeatureLicensed = async (featureKey) => {
  const key = normalizeFeatureKey(featureKey);
  if (!key) return;
  const license = await licenseService.getLicenseState();
  if (license?.activationMethod === "open_all") return;

  const activeKeys = licenseService.getActiveFeatureKeys();
  if (!activeKeys.includes(key)) {
    throw createApiError(C.DEVICE_UNSUPPORTED_FEATURE, `不支援的 system_type：${key}`, {
      details: { feature: key },
    });
  }
  const licensed =
    Array.isArray(license?.features) && license.features.includes(key);
  if (!licensed) {
    throw createApiError(C.FEATURE_NOT_LICENSED, `未授權功能：${key}`, {
      details: { feature: key },
    });
  }
};

const normalizeExcludeIds = ({ excludeDeviceId = null, excludeDeviceIds = [] } = {}) => {
  const ids = [];
  if (excludeDeviceId != null) ids.push(Number(excludeDeviceId));
  for (const raw of excludeDeviceIds || []) ids.push(Number(raw));
  return [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
};

const countDevicesByResolvedFeature = async (featureKey, opts = {}) => {
  const excludeIds = normalizeExcludeIds(opts);
  const rows = await db.query(
    `SELECT d.id, d.type_code, d.config, dm.category_code, dm.config AS model_config
     FROM devices d
     LEFT JOIN device_models dm ON dm.id = d.model_id
     WHERE (cardinality(?::int[]) = 0 OR NOT (d.id = ANY(?::int[])))`,
    [excludeIds, excludeIds],
  );
  let n = 0;
  for (const row of rows || []) {
    const resolved = resolveQuotaFeature({
      typeCode: row.type_code,
      categoryCode: row.category_code,
      deviceConfig: parseJsonish(row.config),
      modelConfig: parseJsonish(row.model_config),
    });
    if (resolved === featureKey) n += 1;
  }
  return n;
};

const countSensorPointsForFeature = async (featureKey, opts = {}) => {
  const excludeIds = normalizeExcludeIds(opts);
  const extraPoints = Number(opts.extraPoints) || 0;
  const rows = await db.query(
    `SELECT d.id, d.config, dm.config AS model_config
     FROM devices d
     LEFT JOIN device_models dm ON dm.id = d.model_id
     WHERE d.type_code = 'sensor'
       AND (cardinality(?::int[]) = 0 OR NOT (d.id = ANY(?::int[])))`,
    [excludeIds, excludeIds],
  );
  let total = extraPoints;
  for (const row of rows || []) {
    const deviceConfig = parseJsonish(row.config);
    const modelConfig = parseJsonish(row.model_config);
    const energy = isEnergyMeterKind(modelConfig, deviceConfig);
    if (featureKey === "energy" && !energy) continue;
    if (featureKey === "environment" && energy) continue;
    total += countEnabledSensorPoints(deviceConfig, modelConfig);
  }
  return total;
};

const countRollCallBoundDevices = async ({
  query = db.query.bind(db),
  excludeSystemId = null,
  extraDeviceIds = [],
} = {}) => {
  const rows = await query(
    `SELECT system_config
     FROM location_systems
     WHERE system_type = 'roll_call'
       AND ($1::int IS NULL OR id <> $1)`,
    [excludeSystemId != null ? Number(excludeSystemId) : null],
  );
  const ids = new Set();
  for (const row of rows || []) {
    const cfg = parseJsonish(row.system_config);
    const list = Array.isArray(cfg.device_ids) ? cfg.device_ids : [];
    for (const raw of list) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  for (const raw of extraDeviceIds || []) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  return ids.size;
};

const sumLocationPoints = async ({
  query = db.query.bind(db),
  systemType,
  excludeSystemId = null,
  extraConfig = null,
  counter,
} = {}) => {
  const rows = await query(
    `SELECT system_config
     FROM location_systems
     WHERE system_type = $1
       AND ($2::int IS NULL OR id <> $2)`,
    [systemType, excludeSystemId != null ? Number(excludeSystemId) : null],
  );
  let total = extraConfig != null ? counter(extraConfig) : 0;
  for (const row of rows || []) {
    total += counter(row.system_config);
  }
  return total;
};

const getUsedDevicesCount = async (featureKey, opts = {}) => {
  const key = normalizeFeatureKey(featureKey);
  if (!key || key === "multimedia") return 0;
  if (key === "roll_call") return countRollCallBoundDevices(opts);
  if (key === "environment" || key === "energy") {
    return countSensorPointsForFeature(key, opts);
  }
  if (MODBUS_POINT_SYSTEM_TYPE_SET.has(key)) {
    return sumLocationPoints({
      systemType: key,
      excludeSystemId: opts.excludeSystemId,
      extraConfig: opts.extraConfig,
      counter: countModbusSystemPoints,
    });
  }
  return countDevicesByResolvedFeature(key, opts);
};

const tallyResolvedDeviceFeatures = async () => {
  const rows = await db.query(
    `SELECT d.type_code, d.config, dm.category_code, dm.config AS model_config
     FROM devices d
     LEFT JOIN device_models dm ON dm.id = d.model_id`,
  );
  const counts = Object.create(null);
  for (const row of rows || []) {
    const resolved = resolveQuotaFeature({
      typeCode: row.type_code,
      categoryCode: row.category_code,
      deviceConfig: parseJsonish(row.config),
      modelConfig: parseJsonish(row.model_config),
    });
    if (!resolved) continue;
    counts[resolved] = (counts[resolved] || 0) + 1;
  }
  return counts;
};

const tallyLocationUsage = async () => {
  const rows = await db.query(
    `SELECT system_type, system_config
     FROM location_systems
     WHERE system_type = ANY($1::text[])`,
    [LOCATION_USAGE_SYSTEM_TYPES],
  );
  const points = Object.create(null);
  for (const type of MODBUS_POINT_SYSTEM_TYPES) points[type] = 0;
  let elevatorPoints = 0;
  const rollIds = new Set();
  for (const row of rows || []) {
    const type = row.system_type;
    if (type === "roll_call") {
      const cfg = parseJsonish(row.system_config);
      const list = Array.isArray(cfg.device_ids) ? cfg.device_ids : [];
      for (const raw of list) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) rollIds.add(n);
      }
    } else if (type === "elevator") {
      elevatorPoints += countElevatorFloorDiPoints(row.system_config);
    } else if (MODBUS_POINT_SYSTEM_TYPE_SET.has(type)) {
      points[type] += countModbusSystemPoints(row.system_config);
    }
  }
  return { points, elevatorPoints, rollCall: rollIds.size };
};

const tallySensorPoints = async () => {
  const rows = await db.query(
    `SELECT d.config, dm.config AS model_config
     FROM devices d
     LEFT JOIN device_models dm ON dm.id = d.model_id
     WHERE d.type_code = 'sensor'`,
  );
  let environment = 0;
  let energy = 0;
  for (const row of rows || []) {
    const deviceConfig = parseJsonish(row.config);
    const modelConfig = parseJsonish(row.model_config);
    const pts = countEnabledSensorPoints(deviceConfig, modelConfig);
    if (isEnergyMeterKind(modelConfig, deviceConfig)) energy += pts;
    else environment += pts;
  }
  return { environment, energy };
};

const getUsageMap = async (featureKeys) => {
  const keys = Array.isArray(featureKeys)
    ? featureKeys.map(normalizeFeatureKey).filter(Boolean)
    : [];
  const deviceCounts = await tallyResolvedDeviceFeatures();
  const sensorPoints = await tallySensorPoints();
  const locationUsage = await tallyLocationUsage();
  const usage = {};
  for (const key of keys) {
    let usedDevices = 0;
    if (key === "environment") {
      usedDevices = sensorPoints.environment;
    } else if (key === "energy") {
      usedDevices = sensorPoints.energy;
    } else if (key === "roll_call") {
      usedDevices = locationUsage.rollCall;
    } else if (MODBUS_POINT_SYSTEM_TYPE_SET.has(key)) {
      usedDevices = locationUsage.points[key] || 0;
    } else if (key !== "multimedia") {
      usedDevices = deviceCounts[key] || 0;
    }
    const entry = { usedDevices };
    if (key === "elevator") {
      entry.usedPoints = locationUsage.elevatorPoints;
    }
    usage[key] = entry;
  }
  return usage;
};

const assertDeviceWriteQuota = async ({
  featureKey,
  deviceConfig,
  modelConfig,
  excludeDeviceId = null,
} = {}) => {
  const key = normalizeFeatureKey(featureKey);
  if (!key) return;
  await assertFeatureLicensed(key);

  const license = await licenseService.getLicenseState();
  if (license?.activationMethod === "open_all") return;

  if (key === "environment" || key === "energy") {
    const extraPoints = countEnabledSensorPoints(deviceConfig, modelConfig);
    const used = await countSensorPointsForFeature(key, {
      excludeDeviceId,
      extraPoints,
    });
    assertWithinMax(key, used, license?.quotas?.[key]?.maxDevices);
    return;
  }

  const used = await getUsedDevicesCount(key, { excludeDeviceId });
  const next = used + 1;
  assertWithinMax(key, next, license?.quotas?.[key]?.maxDevices);
};

const assertSystemQuotaWithinLimit = async ({
  query,
  systemType,
  nextConfig,
  excludeSystemId = null,
} = {}) => {
  const key = normalizeFeatureKey(systemType);
  if (!key) return;

  const license = await licenseService.getLicenseState();
  if (license?.activationMethod === "open_all") return;

  if (key === "roll_call") {
    const extra = Array.isArray(nextConfig?.device_ids) ? nextConfig.device_ids : [];
    const used = await countRollCallBoundDevices({
      query,
      excludeSystemId,
      extraDeviceIds: extra,
    });
    assertWithinMax(key, used, license?.quotas?.[key]?.maxDevices);
    return;
  }

  if (key === "elevator") {
    const used = await sumLocationPoints({
      query,
      systemType: "elevator",
      excludeSystemId,
      extraConfig: nextConfig,
      counter: countElevatorFloorDiPoints,
    });
    assertWithinMax(key, used, license?.quotas?.[key]?.maxPoints);
    return;
  }

  if (!MODBUS_POINT_SYSTEM_TYPE_SET.has(key)) return;

  const used = await sumLocationPoints({
    query,
    systemType: key,
    excludeSystemId,
    extraConfig: nextConfig,
    counter: countModbusSystemPoints,
  });
  assertWithinMax(key, used, license?.quotas?.[key]?.maxDevices);
};

const assertModelQuotaReclass = async ({
  modelId,
  typeCode,
  existingCategoryCode,
  nextCategoryCode,
  nextModelConfig,
} = {}) => {
  const rows = await db.query(
    `SELECT d.id, d.type_code, d.config
     FROM devices d
     WHERE d.model_id = ?`,
    [modelId],
  );
  if (!rows?.length) return;

  const license = await licenseService.getLicenseState();
  if (license?.activationMethod === "open_all") return;

  const newModelCfg = parseJsonish(nextModelConfig);
  const newCat =
    nextCategoryCode !== undefined ? nextCategoryCode : existingCategoryCode;
  const ids = rows
    .map((row) => Number(row.id))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (typeCode === "sensor") {
    const incoming = { environment: 0, energy: 0 };
    for (const row of rows) {
      const deviceConfig = parseJsonish(row.config);
      const newFeat = resolveQuotaFeature({
        typeCode: "sensor",
        modelConfig: newModelCfg,
        deviceConfig,
      });
      if (!newFeat) continue;
      incoming[newFeat] += countEnabledSensorPoints(deviceConfig, newModelCfg);
    }
    for (const key of ["environment", "energy"]) {
      const extra = incoming[key] || 0;
      if (extra <= 0) continue;
      await assertFeatureLicensed(key);
      const used = await countSensorPointsForFeature(key, {
        excludeDeviceIds: ids,
      });
      assertWithinMax(key, used + extra, license?.quotas?.[key]?.maxDevices);
    }
    return;
  }

  const incoming = Object.create(null);
  for (const row of rows) {
    const deviceConfig = parseJsonish(row.config);
    const newFeat = resolveQuotaFeature({
      typeCode: row.type_code || typeCode,
      categoryCode: newCat,
      modelConfig: newModelCfg,
      deviceConfig,
    });
    if (!newFeat) continue;
    incoming[newFeat] = (incoming[newFeat] || 0) + 1;
  }

  for (const [key, extra] of Object.entries(incoming)) {
    if (!extra) continue;
    await assertFeatureLicensed(key);
    const used = await getUsedDevicesCount(key, { excludeDeviceIds: ids });
    assertWithinMax(key, used + extra, license?.quotas?.[key]?.maxDevices);
  }
};

const assertCameraStreamLicensed = async (device) => {
  const license = await licenseService.getLicenseState();
  if (license?.activationMethod === "open_all") return;

  const features = Array.isArray(license?.features) ? license.features : [];
  if (features.includes("surveillance")) return;

  const featureKey = resolveQuotaFeature({
    typeCode: device?.type_code,
    categoryCode: device?.model_category_code || device?.model?.category_code,
    modelConfig: parseJsonish(device?.model?.config),
    deviceConfig: parseJsonish(device?.config),
  });
  if (featureKey && features.includes(featureKey)) return;

  const denied = featureKey || "surveillance";
  throw createApiError(C.FEATURE_NOT_LICENSED, `未授權功能：${denied}`, {
    details: { feature: denied },
  });
};

module.exports = {
  applyQuotaFeatureToConfig,
  getUsageMap,
  assertDeviceWriteQuota,
  assertSystemQuotaWithinLimit,
  assertModelQuotaReclass,
  assertCameraStreamLicensed,
};
