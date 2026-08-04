/**
 * 能源用途系統（負載分類）SSOT
 * - 電表設備：devices.config.energy_usage_system
 * - 儀表板分佈：共最多 6 項＝5 個具名系統 +「其他系統」
 */

const CATALOG_VERSION = "2026-08-04";

/** @type {ReadonlyArray<{ key: string; label: string; sortOrder: number }>} */
const ENERGY_USAGE_SYSTEMS = [
  { key: "hvac", label: "空調", sortOrder: 10 },
  { key: "lighting", label: "照明", sortOrder: 20 },
  { key: "elevator", label: "電梯", sortOrder: 30 },
  { key: "other", label: "其他", sortOrder: 90 },
];

const ENERGY_USAGE_SYSTEM_KEY_SET = new Set(
  ENERGY_USAGE_SYSTEMS.map((s) => s.key),
);

const DEFAULT_USAGE_SYSTEM_KEY = "other";

function isValidEnergyUsageSystemKey(key) {
  return ENERGY_USAGE_SYSTEM_KEY_SET.has(String(key || ""));
}

function normalizeEnergyUsageSystemKey(key) {
  const k = String(key || "").trim();
  if (isValidEnergyUsageSystemKey(k)) return k;
  return DEFAULT_USAGE_SYSTEM_KEY;
}

function getEnergyUsageSystemLabel(key) {
  const normalized = normalizeEnergyUsageSystemKey(key);
  const found = ENERGY_USAGE_SYSTEMS.find((s) => s.key === normalized);
  return found?.label || "其他";
}

function getEnergyUsageSystemsPayload() {
  return {
    version: CATALOG_VERSION,
    systems: ENERGY_USAGE_SYSTEMS,
    defaultKey: DEFAULT_USAGE_SYSTEM_KEY,
  };
}

module.exports = {
  CATALOG_VERSION,
  ENERGY_USAGE_SYSTEMS,
  DEFAULT_USAGE_SYSTEM_KEY,
  isValidEnergyUsageSystemKey,
  normalizeEnergyUsageSystemKey,
  getEnergyUsageSystemLabel,
  getEnergyUsageSystemsPayload,
};
