const config = require("../config");
const settingsService = require("./settingsService");

const SETTINGS_KEYS = {
  features: "license_features",
  updatedAt: "license_updated_at",
  serialNumber: "license_serial_number",
  licenseKey: "license_license_key",
  activationMethod: "license_activation_method",
  deviceFingerprint: "license_device_fingerprint",
  extensionKeys: "license_extension_keys",
};

/** 授權控管的功能：人流、照明、排水、環境、影像監控、車輛進出（其餘由角色管理） */
const ALL_FEATURE_KEYS = [
  "people_counting",
  "lighting",
  "drainage",
  "fire",
  "emergency_rescue",
  "environment",
  "surveillance",
  "vehicle_access",
];

const CACHE_TTL_MS = 30_000;

let cached = {
  atMs: 0,
  features: [],
  serialNumber: null,
  licenseKey: null,
  activationMethod: null,
  deviceFingerprint: null,
  extensionKeys: [],
};

const parseFeaturesValue = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((x) => typeof x === "string");

  const raw = String(value).trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x) => typeof x === "string");
    } catch {
      return [];
    }
  }

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const parseStringValue = (value) => {
  if (value == null) return null;
  const raw = String(value).trim();
  return raw ? raw : null;
};

const parseExtensionKeysValue = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  }
  const raw = String(value).trim();
  if (!raw || raw === "[]") return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
};

const normalizeFeatureArray = (arr) => {
  const raw = Array.isArray(arr)
    ? arr.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
  return raw.filter((key) => ALL_FEATURE_KEYS.includes(key));
};

const mergeFeatureLists = (existing, incoming) => {
  const a = normalizeFeatureArray(existing);
  const b = normalizeFeatureArray(incoming);
  return [...new Set([...a, ...b])];
};

async function getLicenseState({ bypassCache = false } = {}) {
  if (config.license && config.license.openAllFeatures === true) {
    return {
      features: [...ALL_FEATURE_KEYS],
      expired: false,
      serialNumber: null,
      licenseKey: null,
      activationMethod: "open_all",
      deviceFingerprint: null,
      extensionKeys: [],
    };
  }

  const now = Date.now();
  if (!bypassCache && now - cached.atMs < CACHE_TTL_MS) {
    return {
      features: cached.features,
      expired: false,
      serialNumber: cached.serialNumber,
      licenseKey: cached.licenseKey,
      activationMethod: cached.activationMethod,
      deviceFingerprint: cached.deviceFingerprint,
      extensionKeys: [...cached.extensionKeys],
    };
  }

  const settings = await settingsService.getSettingsByKeys([
    SETTINGS_KEYS.features,
    SETTINGS_KEYS.serialNumber,
    SETTINGS_KEYS.licenseKey,
    SETTINGS_KEYS.activationMethod,
    SETTINGS_KEYS.deviceFingerprint,
    SETTINGS_KEYS.extensionKeys,
  ]);

  const features = parseFeaturesValue(settings[SETTINGS_KEYS.features]);
  const serialNumber = parseStringValue(settings[SETTINGS_KEYS.serialNumber]);
  const licenseKey = parseStringValue(settings[SETTINGS_KEYS.licenseKey]);
  const activationMethod = parseStringValue(settings[SETTINGS_KEYS.activationMethod]);
  const deviceFingerprint = parseStringValue(settings[SETTINGS_KEYS.deviceFingerprint]);
  const extensionKeys = parseExtensionKeysValue(settings[SETTINGS_KEYS.extensionKeys]);

  cached = {
    atMs: now,
    features,
    serialNumber,
    licenseKey,
    activationMethod,
    deviceFingerprint,
    extensionKeys,
  };

  return {
    features,
    expired: false,
    serialNumber,
    licenseKey,
    activationMethod,
    deviceFingerprint,
    extensionKeys: [...extensionKeys],
  };
}

/**
 * @param {object} opts
 * @param {string[]|undefined} opts.features — 未傳則不更新 features
 * @param {boolean} [opts.mergeFeatures] — true 時與現有 features 聯集
 * @param {string|null|undefined} opts.serialNumber — 傳 null 可清空（需明確傳入）
 * @param {string|null|undefined} opts.licenseKey
 * @param {boolean} [opts.preserveMainLicenseKey] — true 時不寫入主 LK（副 LK 啟用）
 * @param {string|null|undefined} opts.deviceFingerprint
 * @param {string[]|undefined} opts.extensionKeys — 整份取代；未傳則不更新
 * @param {string|undefined} opts.appendExtensionKey — 追加一筆副 LK（去重）
 * @param {string|null|undefined} opts.activationMethod
 */
async function setLicenseState(
  {
    features,
    mergeFeatures = false,
    serialNumber,
    licenseKey,
    preserveMainLicenseKey = false,
    deviceFingerprint,
    extensionKeys,
    appendExtensionKey,
    activationMethod,
    description,
  } = {},
) {
  const current = await getLicenseState({ bypassCache: true });

  let normalizedFeatures = current.features;
  if (features !== undefined) {
    normalizedFeatures = mergeFeatures
      ? mergeFeatureLists(current.features, features)
      : normalizeFeatureArray(features);
  }

  await settingsService.upsertSetting(
    SETTINGS_KEYS.features,
    JSON.stringify(normalizedFeatures),
    description || "license features",
  );

  if (serialNumber !== undefined) {
    await settingsService.upsertSetting(
      SETTINGS_KEYS.serialNumber,
      serialNumber == null ? "" : parseStringValue(serialNumber),
      description || "license serialNumber",
    );
  }
  if (licenseKey !== undefined && !preserveMainLicenseKey) {
    await settingsService.upsertSetting(
      SETTINGS_KEYS.licenseKey,
      licenseKey == null ? "" : parseStringValue(licenseKey),
      description || "license licenseKey",
    );
  }
  if (activationMethod !== undefined) {
    await settingsService.upsertSetting(
      SETTINGS_KEYS.activationMethod,
      activationMethod == null ? "" : parseStringValue(activationMethod),
      description || "license activationMethod",
    );
  }
  if (deviceFingerprint !== undefined) {
    await settingsService.upsertSetting(
      SETTINGS_KEYS.deviceFingerprint,
      deviceFingerprint == null ? "" : parseStringValue(deviceFingerprint),
      description || "license deviceFingerprint",
    );
  }

  let nextExtensionKeys = current.extensionKeys;
  if (extensionKeys !== undefined) {
    nextExtensionKeys = parseExtensionKeysValue(extensionKeys);
    await settingsService.upsertSetting(
      SETTINGS_KEYS.extensionKeys,
      JSON.stringify(nextExtensionKeys),
      description || "license extensionKeys",
    );
  } else if (appendExtensionKey) {
    const k = parseStringValue(appendExtensionKey);
    nextExtensionKeys = [...current.extensionKeys];
    if (k && !nextExtensionKeys.includes(k)) nextExtensionKeys.push(k);
    await settingsService.upsertSetting(
      SETTINGS_KEYS.extensionKeys,
      JSON.stringify(nextExtensionKeys),
      description || "license extensionKeys",
    );
  }

  await settingsService.upsertSetting(
    SETTINGS_KEYS.updatedAt,
    new Date().toISOString(),
    null,
  );

  const nextSerial = serialNumber !== undefined
    ? parseStringValue(serialNumber)
    : current.serialNumber;
  const nextLicenseKey = preserveMainLicenseKey
    ? current.licenseKey
    : (licenseKey !== undefined ? parseStringValue(licenseKey) : current.licenseKey);
  const nextActivation = activationMethod !== undefined
    ? parseStringValue(activationMethod)
    : current.activationMethod;
  const nextDeviceFp = deviceFingerprint !== undefined
    ? parseStringValue(deviceFingerprint)
    : current.deviceFingerprint;

  cached = {
    atMs: 0,
    features: normalizedFeatures,
    serialNumber: nextSerial,
    licenseKey: nextLicenseKey,
    activationMethod: nextActivation,
    deviceFingerprint: nextDeviceFp,
    extensionKeys: extensionKeys !== undefined || appendExtensionKey
      ? nextExtensionKeys
      : current.extensionKeys,
  };

  return getLicenseState({ bypassCache: true });
}

async function resetLicenseState({ description } = {}) {
  const reason = description || "license reset";
  await settingsService.upsertSetting(SETTINGS_KEYS.features, "[]", reason);
  await settingsService.upsertSetting(SETTINGS_KEYS.serialNumber, "", reason);
  await settingsService.upsertSetting(SETTINGS_KEYS.licenseKey, "", reason);
  await settingsService.upsertSetting(SETTINGS_KEYS.activationMethod, "", reason);
  await settingsService.upsertSetting(SETTINGS_KEYS.deviceFingerprint, "", reason);
  await settingsService.upsertSetting(SETTINGS_KEYS.extensionKeys, "[]", reason);
  await settingsService.upsertSetting(SETTINGS_KEYS.updatedAt, new Date().toISOString(), null);

  cached = {
    atMs: 0,
    features: [],
    serialNumber: null,
    licenseKey: null,
    activationMethod: null,
    deviceFingerprint: null,
    extensionKeys: [],
  };

  return getLicenseState({ bypassCache: true });
}

module.exports = {
  SETTINGS_KEYS,
  ALL_FEATURE_KEYS,
  getLicenseState,
  setLicenseState,
  resetLicenseState,
};
