/**
 * Modbus 快照服務共用：設備連線設定快取、inline modbus 解析、點位型別正規化
 * 供 snapshotStatus/*StatusService 使用，避免 8 檔重複實作。
 */

const deviceService = require("../devices/deviceService");

const { DEVICE_CFG_TTL_MS: DEVICE_CFG_CACHE_TTL } = require("../../config/realtimeTiming");
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
  const numericId = Number(deviceId);
  if (
    deviceId != null &&
    deviceId !== "" &&
    Number.isFinite(numericId) &&
    numericId > 0
  ) {
    try {
      const { isDeviceEnabled } = require("../devices/deviceEnabledFilter");
      if (!(await isDeviceEnabled(numericId))) {
        return null;
      }

      const cached = getCachedDeviceCfg(numericId);
      if (cached) return cached;

      const { device } = await deviceService.getDeviceById(numericId);
      const c = device?.config || {};
      if (c.host != null && c.port !== undefined && c.port !== null) {
        const cfg = {
          host: c.host,
          port: Number(c.port),
          unitId: Number(c.unitId ?? 1),
        };
        setCachedDeviceCfg(numericId, cfg);
        return cfg;
      }
    } catch (err) {
      log?.debug?.("resolveDeviceConfig: device lookup failed", {
        deviceId: numericId,
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

const EMPTY_BITS = Object.freeze({ bits: new Map(), readOk: false });

/**
 * 讀取 Modbus discrete 位址範圍 [start, end]（含端點）；對齊排水／消防 statusPoints 的 batchRead 路徑。
 * @returns {{ bits: Map<number, boolean>, readOk: boolean }}
 */
async function readDiscreteBitRange(deviceConfig, start, end, options = {}) {
  if (!deviceConfig || start == null || end == null || end < start) {
    return EMPTY_BITS;
  }
  const modbusBatchService = require("../devices/modbusBatchService");
  const length = end - start + 1;
  const noCache = options.noCache !== false;
  try {
    const results = await modbusBatchService.batchRead([
      {
        host: deviceConfig.host,
        port: deviceConfig.port,
        unitId: deviceConfig.unitId,
        registerType: "discrete",
        address: start,
        length,
        meta: { noCache },
      },
    ]);
    const first = results?.[0];
    if (!first?.ok || !Array.isArray(first.data)) {
      return { bits: new Map(), readOk: false };
    }
    const bits = new Map();
    for (let i = 0; i < first.data.length; i += 1) {
      bits.set(start + i, Boolean(first.data[i]));
    }
    return { bits, readOk: true };
  } catch {
    return { bits: new Map(), readOk: false };
  }
}

/**
 * 讀取 statusPoints 物件中每個鍵對應的點位（可每點獨立 deviceId），失敗的鍵略過。
 * 同 device+registerType 由 batchRead 合併範圍並共用 snapshot cache。
 */
async function readAllStatusPoints(statusPoints, cfgDeviceId, cfgModbus) {
  const modbusBatchService = require("../devices/modbusBatchService");
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") {
    return raw;
  }

  const reqs = [];
  for (const key of Object.keys(statusPoints)) {
    const def = statusPoints[key];
    if (!def || typeof def !== "object") continue;
    const registerType = normalizeRegisterType(def);
    const address = Number(def.address);
    const length = def.length != null ? Number(def.length) : 1;
    if (!Number.isFinite(address) || address < 0) {
      raw[key] = undefined;
      continue;
    }
    if (!ALLOWED_REGISTER_TYPES.has(registerType)) {
      raw[key] = undefined;
      continue;
    }

    let pointDeviceConfig = null;
    try {
      const ownId = def.deviceId != null && def.deviceId !== "";
      pointDeviceConfig = ownId
        ? await resolveDeviceConfig(Number(def.deviceId), def.modbus || null)
        : await resolveDeviceConfig(cfgDeviceId, cfgModbus);
    } catch (_) {
      pointDeviceConfig = null;
    }

    if (!pointDeviceConfig) {
      raw[key] = undefined;
      continue;
    }

    reqs.push({
      host: pointDeviceConfig.host,
      port: pointDeviceConfig.port,
      unitId: pointDeviceConfig.unitId,
      registerType,
      address,
      length,
      meta: { pointKey: key },
    });
  }

  if (reqs.length === 0) {
    return raw;
  }

  const results = await modbusBatchService.batchRead(reqs);
  for (const r of results) {
    const k = r?.meta?.pointKey;
    if (!k) continue;
    if (r.ok) {
      const v = r.data?.[0];
      if (typeof v === "boolean") raw[k] = v;
      else if (typeof v === "number") raw[k] = v !== 0;
      else raw[k] = Boolean(v);
    } else {
      raw[k] = undefined;
    }
  }

  return raw;
}

async function hasResolvableDeviceForPoints(
  statusPoints,
  cfgDeviceId,
  cfgModbus,
) {
  const keys = Object.keys(statusPoints || {}).filter(
    (k) => statusPoints[k] && typeof statusPoints[k] === "object",
  );
  if (keys.length === 0) {
    try {
      return Boolean(await resolveDeviceConfig(cfgDeviceId, cfgModbus));
    } catch (_) {
      return false;
    }
  }
  for (const key of keys) {
    const def = statusPoints[key];
    let c = null;
    try {
      const ownId = def.deviceId != null && def.deviceId !== "";
      c = ownId
        ? await resolveDeviceConfig(Number(def.deviceId), def.modbus || null)
        : await resolveDeviceConfig(cfgDeviceId, cfgModbus);
    } catch (_) {
      c = null;
    }
    if (c) return true;
  }
  return false;
}

/** running===true → alarm；其餘依連線／讀值 → warning／normal（煙霧／求救／空氣循環） */
function deriveRunningAlarmUiStatus(
  rawMerged,
  hadDeviceConfig,
  pointKeysConfigured,
  rawRead,
) {
  if (!hadDeviceConfig) return "warning";
  if (!pointKeysConfigured || pointKeysConfigured.length === 0) {
    return "warning";
  }

  const src = rawRead && typeof rawRead === "object" ? rawRead : rawMerged;
  const anyRead = pointKeysConfigured.some(
    (k) => src[k] !== undefined && src[k] !== null,
  );
  if (!anyRead) return "warning";

  if (rawMerged.running === true) {
    return "alarm";
  }
  return "normal";
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
  deriveRunningAlarmUiStatus,
  parseZoneIdsQuery,
  readDiscreteBitRange,
  readAllStatusPoints,
  hasResolvableDeviceForPoints,
};
