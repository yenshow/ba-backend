/**
 * Modbus 快照共用的點位讀取與連線狀態判定。
 */

const { resolveModbusDeviceConfig } = require("../devices/modbusDeviceConfig");
const {
  parseBitAddress,
  normalizeModbusRegisterType,
} = require("../devices/modbusDiDoConfig");
const { applyDefTransform } = require("../../utils/modbusTransform");

const ALLOWED_REGISTER_TYPES = new Set([
  "coil",
  "discrete",
  "holding",
  "input",
]);

/**
 * @param {number|string|null|undefined} deviceId
 * @param {object|null|undefined} modbus
 * @param {{ logger?: { debug?: Function } }} [options]
 */
async function resolveDeviceConfig(deviceId, modbus, options = {}) {
  try {
    return await resolveModbusDeviceConfig(deviceId, modbus);
  } catch (err) {
    options.logger?.debug?.("Modbus device lookup failed", {
      deviceId,
      error: err?.message || String(err),
    });
    return null;
  }
}

function normalizeRegisterType(pointDef) {
  return (
    normalizeModbusRegisterType(pointDef.registerType || pointDef.type) ||
    String(pointDef.registerType || pointDef.type || "")
      .toLowerCase()
      .trim()
  );
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
  const bitStore = require("../devices/modbusBitStore");
  const preferStore = options.preferBitStore !== false && options.noCache !== true;
  if (preferStore) {
    const bits = new Map();
    let allFresh = true;
    for (let addr = start; addr <= end; addr += 1) {
      const hit = bitStore.getBit(deviceConfig, "discrete", addr);
      if (!hit || !hit.ok) {
        allFresh = false;
        break;
      }
      bits.set(addr, Boolean(hit.value));
    }
    if (allFresh) return { bits, readOk: true };
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

// 單點 DI/DO 優先使用 Fast poll 結果。其他讀取與快取未命中統一交給 batchRead。
async function readSnapshotPoints(requests) {
  const modbusBatchService = require("../devices/modbusBatchService");
  const bitStore = require("../devices/modbusBitStore");
  const results = new Array(requests.length);
  const pending = [];

  requests.forEach((request, index) => {
    const { registerType, address, length, meta } = request;
    if (length === 1 && (registerType === "coil" || registerType === "discrete")) {
      if (!bitStore.isModuleOnlineForAddress(request, address)) {
        results[index] = { ok: false, error: "IO 模組離線", meta };
        return;
      }
      const hit = bitStore.getBit(request, registerType, address);
      if (hit?.ok) {
        results[index] = { ok: true, data: [hit.value], meta, fromBitStore: true };
        return;
      }
    }
    pending.push(index);
  });

  if (pending.length > 0) {
    const fetched = await modbusBatchService.batchRead(
      pending.map((index) => requests[index]),
    );
    pending.forEach((index, batchIndex) => {
      results[index] = fetched[batchIndex];
    });
  }
  return results;
}

/**
 * 讀取 statusPoints（可每點獨立 deviceId）。預設輸出布林狀態，空調點位保留數值與轉換。
 */
async function readAllStatusPoints(
  statusPoints,
  cfgDeviceId,
  cfgModbus,
  { numeric = false } = {},
) {
  const raw = {};
  if (!statusPoints || typeof statusPoints !== "object") {
    return raw;
  }

  const reqs = [];
  for (const key of Object.keys(statusPoints)) {
    const def = statusPoints[key];
    if (!def || typeof def !== "object") continue;
    const registerType = normalizeRegisterType(def);
    const address = parseBitAddress(def.address);
    const length = def.length != null ? Number(def.length) : 1;
    if (
      address === null ||
      !Number.isFinite(length) || length <= 0 ||
      !ALLOWED_REGISTER_TYPES.has(registerType)
    ) {
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
      ...pointDeviceConfig,
      registerType,
      address,
      length,
      meta: { pointKey: key },
    });
  }

  const results = await readSnapshotPoints(reqs);
  reqs.forEach(({ meta: { pointKey } }, index) => {
    const result = results[index];
    if (!result?.ok) {
      raw[pointKey] = undefined;
      return;
    }
    const value = result.data?.[0];
    if (!numeric || result.fromBitStore) {
      raw[pointKey] = typeof value === "number" ? value !== 0 : Boolean(value);
    } else {
      raw[pointKey] = value != null && Number.isFinite(Number(value))
        ? applyDefTransform(Number(value), statusPoints[pointKey])
        : value;
    }
  });

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
  resolveDeviceConfig,
  deriveConnectivityUiStatus,
  deriveRunningAlarmUiStatus,
  parseZoneIdsQuery,
  readDiscreteBitRange,
  readSnapshotPoints,
  readAllStatusPoints,
  hasResolvableDeviceForPoints,
};
