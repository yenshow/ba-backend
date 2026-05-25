/**
 * Modbus 快照服務共用：設備連線設定快取、inline modbus 解析、點位型別正規化
 * 供 snapshotStatus/*StatusService 使用，避免 8 檔重複實作。
 */

const deviceService = require("../devices/deviceService");

const DEVICE_CFG_CACHE_TTL = 60_000;
const deviceCfgCache = new Map();

const ALLOWED_REGISTER_TYPES = new Set([
  "coil",
  "discrete",
  "holding",
  "input",
]);

function getCachedDeviceCfg(deviceId) {
  const hit = deviceCfgCache.get(String(deviceId));
  if (!hit) return null;
  if (Date.now() - hit.ts > DEVICE_CFG_CACHE_TTL) {
    deviceCfgCache.delete(String(deviceId));
    return null;
  }
  return hit.cfg || null;
}

function setCachedDeviceCfg(deviceId, cfg) {
  deviceCfgCache.set(String(deviceId), { ts: Date.now(), cfg: cfg || null });
}

function parseInlineModbus(modbus) {
  if (!modbus || typeof modbus !== "object") return null;
  const { host, port, unitId = 1 } = modbus;
  if (!host || port === undefined || port === null) return null;
  return { host, port: Number(port), unitId: Number(unitId) };
}

/**
 * @param {number|string|null|undefined} deviceId
 * @param {object|null|undefined} modbus
 * @param {{ logger?: { debug?: Function } }} [options]
 */
async function resolveDeviceConfig(deviceId, modbus, options = {}) {
  const log = options.logger;
  if (deviceId != null && deviceId !== "") {
    try {
      const cached = getCachedDeviceCfg(deviceId);
      if (cached) return cached;

      const { device } = await deviceService.getDeviceById(Number(deviceId));
      const c = device?.config || {};
      if (c.host != null && c.port !== undefined && c.port !== null) {
        const cfg = {
          host: c.host,
          port: Number(c.port),
          unitId: Number(c.unitId ?? 1),
        };
        setCachedDeviceCfg(deviceId, cfg);
        return cfg;
      }
    } catch (err) {
      log?.debug?.("resolveDeviceConfig: device lookup failed", {
        deviceId,
        error: err?.message || String(err || ""),
      });
    }
  }
  return parseInlineModbus(modbus);
}

function normalizeRegisterType(pointDef) {
  let registerType = String(pointDef.registerType || pointDef.type || "")
    .toLowerCase()
    .trim();
  if (registerType === "di") registerType = "discrete";
  if (registerType === "do") registerType = "coil";
  return registerType;
}

/**
 * 連線／可讀性健康判定（照明、HVAC 等共用；不在此層做 alarm 分級）
 */
function deriveConnectivityUiStatus(raw, hadDeviceConfig, pointKeysConfigured) {
  if (!hadDeviceConfig) return "offline";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0) return "unknown";

  const anyRead = pointKeysConfigured.some(
    (k) => raw[k] !== undefined && raw[k] !== null,
  );
  if (!anyRead) return "warning";
  return "normal";
}

function parseZoneIdsQuery(raw) {
  if (raw == null || raw === "") return undefined;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => parseInt(v, 10))
    .filter((n) => !Number.isNaN(n));
}

/**
 * @param {'off'|'opt-in'|'opt-out'} mode
 * @param {string|undefined} rawQuery syncAlerts query value
 */
function resolveSyncAlertsFromQuery(mode, rawQuery) {
  if (mode === "off") return false;
  if (mode === "opt-out") {
    return String(rawQuery ?? "true") !== "false";
  }
  return String(rawQuery ?? "false") === "true";
}

module.exports = {
  DEVICE_CFG_CACHE_TTL,
  ALLOWED_REGISTER_TYPES,
  getCachedDeviceCfg,
  setCachedDeviceCfg,
  parseInlineModbus,
  resolveDeviceConfig,
  normalizeRegisterType,
  deriveConnectivityUiStatus,
  parseZoneIdsQuery,
  resolveSyncAlertsFromQuery,
};
