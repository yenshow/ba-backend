/**
 * Modbus DI/DO BitStore — Fast poll 結果語意層快取
 * key: host:port:unitId|registerType|address
 */

const { BIT_STORE_FRESHNESS_MS } = require("../../config/realtimeTiming");

/** @type {Map<string, { value: boolean, readAt: number, ok: boolean }>} */
const bitMap = new Map();

/**
 * deviceKey -> Map<moduleId, health>
 * @typedef {{ moduleId: number, role: string, addressStart: number, addressEnd: number, serial?: string, status: "online"|"offline", lastError?: string|null, checkedAt: number }} ModuleHealth
 * @type {Map<string, Map<number, ModuleHealth>>}
 */
const moduleHealthByDevice = new Map();

/** deviceId -> { online: boolean, checkedAt: number, modules: ModuleHealth[] } */
const deviceReachability = new Map();

/** deviceIds currently covered by poll planner (skip holding@0 connectivity) */
const plannerCoveredDeviceIds = new Set();

const buildDeviceKey = (d) =>
  `${String(d.host || "").trim()}:${Number(d.port)}:${Number(d.unitId)}`;

const buildBitKey = (deviceKey, registerType, address) =>
  `${deviceKey}|${registerType}|${Number(address)}`;

function setBit(deviceConfig, registerType, address, value, { ok = true, readAt = Date.now() } = {}) {
  const deviceKey = buildDeviceKey(deviceConfig);
  bitMap.set(buildBitKey(deviceKey, registerType, address), {
    value: Boolean(value),
    readAt,
    ok: Boolean(ok),
  });
}

/**
 * @returns {{ value: boolean, readAt: number, ok: boolean } | null}
 */
function getBit(deviceConfig, registerType, address, { maxAgeMs = BIT_STORE_FRESHNESS_MS } = {}) {
  const deviceKey = buildDeviceKey(deviceConfig);
  const hit = bitMap.get(buildBitKey(deviceKey, registerType, address));
  if (!hit) return null;
  if (!hit.ok) return hit;
  if (maxAgeMs != null && Date.now() - hit.readAt > maxAgeMs) return null;
  return hit;
}

/**
 * 取得 bit；不過期檢查（警報／edge 用當輪結果）
 */
function getBitRaw(deviceConfig, registerType, address) {
  const deviceKey = buildDeviceKey(deviceConfig);
  return bitMap.get(buildBitKey(deviceKey, registerType, address)) || null;
}

function setModuleHealth(deviceConfig, moduleRow) {
  const deviceKey = buildDeviceKey(deviceConfig);
  if (!moduleHealthByDevice.has(deviceKey)) {
    moduleHealthByDevice.set(deviceKey, new Map());
  }
  moduleHealthByDevice.get(deviceKey).set(Number(moduleRow.moduleId), {
    moduleId: Number(moduleRow.moduleId),
    role: moduleRow.role,
    addressStart: moduleRow.addressStart,
    addressEnd: moduleRow.addressEnd,
    serial: moduleRow.serial,
    status: moduleRow.status === "online" ? "online" : "offline",
    lastError: moduleRow.lastError ?? null,
    checkedAt: moduleRow.checkedAt || Date.now(),
  });
}

function getModulesForDeviceKey(deviceKey) {
  const map = moduleHealthByDevice.get(deviceKey);
  if (!map) return [];
  return [...map.values()].sort((a, b) => a.moduleId - b.moduleId);
}

function setDeviceReachability(deviceId, { online, modules, checkedAt = Date.now() }) {
  const id = Number(deviceId);
  if (!Number.isFinite(id) || id <= 0) return;
  deviceReachability.set(id, {
    online: Boolean(online),
    modules: Array.isArray(modules) ? modules : [],
    checkedAt,
  });
  plannerCoveredDeviceIds.add(id);
}

function getDeviceReachability(deviceId) {
  return deviceReachability.get(Number(deviceId)) || null;
}

function isPlannerCoveredDevice(deviceId) {
  return plannerCoveredDeviceIds.has(Number(deviceId));
}

function markPlannerCovered(deviceIds) {
  for (const id of deviceIds || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) plannerCoveredDeviceIds.add(n);
  }
}

function isModuleOnlineForAddress(deviceConfig, address) {
  const deviceKey = buildDeviceKey(deviceConfig);
  const modules = getModulesForDeviceKey(deviceKey);
  if (modules.length === 0) return true;
  const addr = Number(address);
  const m = modules.find((x) => addr >= x.addressStart && addr <= x.addressEnd);
  if (!m) return true;
  return m.status === "online";
}

function toPublicModules(modules) {
  return (modules || []).map((m) => ({
    moduleId: m.moduleId,
    role: m.role,
    addressStart: m.addressStart,
    addressEnd: m.addressEnd,
    status: m.status,
    ...(m.serial ? { serial: m.serial } : {}),
  }));
}

/** @internal */
function _resetForTests() {
  bitMap.clear();
  moduleHealthByDevice.clear();
  deviceReachability.clear();
  plannerCoveredDeviceIds.clear();
}

module.exports = {
  setBit,
  getBit,
  getBitRaw,
  setModuleHealth,
  setDeviceReachability,
  getDeviceReachability,
  isPlannerCoveredDevice,
  markPlannerCovered,
  isModuleOnlineForAddress,
  toPublicModules,
  _resetForTests,
};
