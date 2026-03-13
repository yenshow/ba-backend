const config = require("../config");
const settingsService = require("./settingsService");

const SETTINGS_KEYS = {
  features: "license_features",
  expiresAt: "license_expires_at",
  updatedAt: "license_updated_at",
};

/** 授權控管的功能：人流、照明、環境、影像監控、車輛進出（其餘由角色管理） */
const ALL_FEATURE_KEYS = [
  "people_counting",
  "lighting",
  "environment",
  "surveillance",
  "vehicle_access",
];

const CACHE_TTL_MS = 30_000;

let cached = {
  atMs: 0,
  features: [],
  expiresAt: null,
};

const parseFeaturesValue = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((x) => typeof x === "string");

  const raw = String(value).trim();
  if (!raw) return [];

  // Preferred format: JSON array string
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x) => typeof x === "string");
    } catch {
      return [];
    }
  }

  // Backward compatible: comma-separated
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const parseExpiresAtValue = (value) => {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const isExpired = (expiresAtIso) => {
  if (!expiresAtIso) return false;
  const t = new Date(expiresAtIso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() > t;
};

async function getLicenseState({ bypassCache = false } = {}) {
  // 環境變數：暫時開放所有功能
  if (config.license && config.license.openAllFeatures === true) {
    return {
      features: [...ALL_FEATURE_KEYS],
      expiresAt: null,
      expired: false,
    };
  }

  const now = Date.now();
  if (!bypassCache && now - cached.atMs < CACHE_TTL_MS) {
    return {
      features: cached.features,
      expiresAt: cached.expiresAt,
      expired: isExpired(cached.expiresAt),
    };
  }

  const settings = await settingsService.getSettingsByKeys([
    SETTINGS_KEYS.features,
    SETTINGS_KEYS.expiresAt,
  ]);

  const features = parseFeaturesValue(settings[SETTINGS_KEYS.features]);
  const expiresAt = parseExpiresAtValue(settings[SETTINGS_KEYS.expiresAt]);

  cached = { atMs: now, features, expiresAt };

  return { features, expiresAt, expired: isExpired(expiresAt) };
}

async function setLicenseState({ features, expiresAt, description } = {}) {
  const raw = Array.isArray(features)
    ? features.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
  const normalizedFeatures = raw.filter((key) => ALL_FEATURE_KEYS.includes(key));

  const normalizedExpiresAt = expiresAt == null || String(expiresAt).trim() === ""
    ? null
    : parseExpiresAtValue(expiresAt);

  await settingsService.upsertSetting(
    SETTINGS_KEYS.features,
    JSON.stringify(normalizedFeatures),
    description || "license features",
  );
  await settingsService.upsertSetting(
    SETTINGS_KEYS.expiresAt,
    normalizedExpiresAt,
    description || "license expiresAt",
  );
  await settingsService.upsertSetting(
    SETTINGS_KEYS.updatedAt,
    new Date().toISOString(),
    null,
  );

  // Bust cache
  cached = { atMs: 0, features: normalizedFeatures, expiresAt: normalizedExpiresAt };

  return getLicenseState({ bypassCache: true });
}

module.exports = {
  SETTINGS_KEYS,
  ALL_FEATURE_KEYS,
  getLicenseState,
  setLicenseState,
};

