const modbusClient = require("./modbusClient");
const { markCoilControlWrite } = require("./modbusBitStore");
const { STANDARD_CONCURRENCY } = require("./modbusGlobalLimiter");
const { normalizeModbusRegisterType } = require("./modbusDiDoConfig");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { mapWithConcurrency } = require("../../utils/mapWithConcurrency");
const {
  MODBUS_BATCH_CACHE_TTL_MS: CACHE_TTL,
  MODBUS_MAX_LENGTH: MAX_LENGTH,
} = require("../../config/realtimeTiming");

/**
 * 批次 Modbus 讀取服務
 * - 目標：把「多次讀單點」合併為「一次讀一段範圍」
 * - 提供 TTL snapshot cache 與 inflight coalescing，讓 UI 與背景監控共用
 * - 同設備（含跨 registerType）串列；跨設備最多 STANDARD_CONCURRENCY 並行
 *
 * 注意：
 * - 單次讀取 length 上限為 MODBUS_MAX_LENGTH（125）
 * - 合併策略預設以「連續 address」為主（MAX_GAP=0）
 */

const MAX_GAP = 0;

const cache = new Map(); // key -> { cached, latestRead, sharedRead }

const normalizeRegisterType = normalizeModbusRegisterType;

const buildDeviceKey = (d) => `${d.host}:${d.port}:${d.unitId}`;
const buildCacheKey = (deviceKey, registerType, address, length) =>
  `${deviceKey}|${registerType}|${address}|${length}`;

const invalidateDeviceCache = (deviceConfig, registerType = null) => {
  const deviceKey = buildDeviceKey(deviceConfig);
  const prefix = registerType ? `${deviceKey}|${registerType}|` : `${deviceKey}|`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
  modbusClient.invalidateReads(deviceConfig, registerType);
};

// 確認成功後立即標記所有線圈，再清除快取。呼叫端接回控制權後才寫營運事件。
async function writeCoilValues(address, value, deviceConfig) {
  const multiple = Array.isArray(value);
  const success = await (multiple
    ? modbusClient.writeCoils(address, value, deviceConfig)
    : modbusClient.writeCoil(address, value, deviceConfig));
  if (success) {
    markCoilControlWrite(deviceConfig, address, multiple ? value.length : 1);
    invalidateDeviceCache(deviceConfig, "coil");
  }
  return success;
}

const readByType = async (registerType, address, length, deviceConfig) => {
  if (registerType === "coil") return modbusClient.readCoils(address, length, deviceConfig);
  if (registerType === "discrete") return modbusClient.readDiscreteInputs(address, length, deviceConfig);
  if (registerType === "holding") return modbusClient.readHoldingRegisters(address, length, deviceConfig);
  if (registerType === "input") return modbusClient.readInputRegisters(address, length, deviceConfig);
  throwApiError(
    C.MODBUS_REGISTER_TYPE_UNSUPPORTED,
    `unsupported registerType: ${registerType}`,
  );
};

async function readRange(key, read, bypassCache) {
  let entry = cache.get(key);
  if (!entry) {
    entry = { cached: null, latestRead: null, sharedRead: null };
    cache.set(key, entry);
  }
  if (entry.cached && Date.now() - entry.cached.ts > CACHE_TTL) {
    entry.cached = null;
  }
  if (!bypassCache) {
    if (entry.cached) return entry.cached.data;
    if (entry.sharedRead) return entry.sharedRead;
  }

  const pending = read();
  entry.latestRead = pending;
  if (!bypassCache) entry.sharedRead = pending;
  try {
    const data = await pending;
    // 寫入可能已清除 entry，或同一範圍已有較新的讀取。
    if (cache.get(key) === entry && entry.latestRead === pending) {
      entry.cached = { ts: Date.now(), data };
    }
    return data;
  } finally {
    if (entry.latestRead === pending) entry.latestRead = null;
    if (entry.sharedRead === pending) entry.sharedRead = null;
    if (cache.get(key) === entry && !entry.cached && !entry.latestRead && !entry.sharedRead) {
      cache.delete(key);
    }
  }
}

/**
 * 把同 device+registerType 的單點讀取合併為 range
 * @param {Array<{address:number,length:number, idx:number}>} points
 * @returns {Array<{start:number,length:number, members:Array<{address,length,idx,offset}>}>}
 */
function coalesceToRanges(points) {
  const sorted = [...points].sort((a, b) => a.address - b.address);
  const ranges = [];

  for (const p of sorted) {
    const addr = Number(p.address);
    const len = p.length != null ? Number(p.length) : 1;
    if (!Number.isInteger(addr) || addr < 0) continue;
    if (!Number.isInteger(len) || len <= 0 || len > MAX_LENGTH) continue;

    const last = ranges[ranges.length - 1];
    if (!last) {
      ranges.push({
        start: addr,
        length: len,
        members: [{ ...p, length: len, offset: 0 }],
      });
      continue;
    }

    const lastEnd = last.start + last.length - 1;
    const nextStart = addr;
    const nextEnd = addr + len - 1;

    const gap = nextStart - lastEnd - 1;
    if (gap >= 0 && gap <= MAX_GAP && nextEnd - last.start + 1 <= MAX_LENGTH) {
      const newLength = nextEnd - last.start + 1;
      last.members.push({ ...p, length: len, offset: nextStart - last.start });
      last.length = newLength;
      continue;
    }

    ranges.push({
      start: addr,
      length: len,
      members: [{ ...p, length: len, offset: 0 }],
    });
  }

  return ranges;
}

/**
 * @param {{ deviceConfig: object, byType: Map<string, Array> }} deviceGroup
 */
async function readDeviceSerial(deviceGroup) {
  const deviceKey = buildDeviceKey(deviceGroup.deviceConfig);
  for (const [registerType, points] of deviceGroup.byType) {
    const ranges = coalesceToRanges(points);
    for (const range of ranges) {
      const cacheKey = buildCacheKey(deviceKey, registerType, range.start, range.length);
      try {
        const data = await readRange(
          cacheKey,
          () =>
            readByType(
              registerType,
              range.start,
              range.length,
              deviceGroup.deviceConfig,
            ),
          range.members.some((member) => member.meta?.noCache === true),
        );
        range.members.forEach((m) => {
          deviceGroup.results[m.idx] = {
            ok: true,
            data: data.slice(m.offset, m.offset + m.length),
            device: deviceGroup.deviceConfig,
            registerType,
            address: m.address,
            length: m.length,
            meta: m.meta,
          };
        });
      } catch (e) {
        const msg = e?.message || String(e);
        range.members.forEach((m) => {
          deviceGroup.results[m.idx] = { ok: false, error: msg, meta: m.meta };
        });
      }
    }
  }
}

/**
 * 批次讀取
 * @param {Array<{host:string,port:number,unitId:number,registerType:string,address:number,length?:number,meta?:any}>} requests
 * @returns {Promise<Array<{ok:true,data:any[],device:any,registerType:string,address:number,length:number,meta?:any} | {ok:false,error:string,meta?:any}>>}
 */
async function batchRead(requests) {
  const reqList = Array.isArray(requests) ? requests : [];
  const results = new Array(reqList.length);

  /** @type {Map<string, { deviceConfig: object, byType: Map<string, Array>, results: any[] }>} */
  const devices = new Map();

  reqList.forEach((r, idx) => {
    const deviceConfig = {
      host: String(r?.host || "").trim(),
      port: Number(r?.port),
      unitId: Number(r?.unitId),
    };
    const registerType = normalizeRegisterType(r?.registerType);
    const address = Number(r?.address);
    const length = r?.length != null ? Number(r.length) : 1;

    if (!deviceConfig.host || !Number.isInteger(deviceConfig.port) || !Number.isInteger(deviceConfig.unitId)) {
      results[idx] = { ok: false, error: "deviceConfig 無效（host/port/unitId）", meta: r?.meta };
      return;
    }
    if (!registerType) {
      results[idx] = { ok: false, error: "registerType 無效", meta: r?.meta };
      return;
    }
    if (!Number.isInteger(address) || address < 0) {
      results[idx] = { ok: false, error: "address 無效", meta: r?.meta };
      return;
    }
    if (!Number.isInteger(length) || length <= 0 || length > MAX_LENGTH) {
      results[idx] = { ok: false, error: "length 無效（1~125）", meta: r?.meta };
      return;
    }

    const deviceKey = buildDeviceKey(deviceConfig);
    if (!devices.has(deviceKey)) {
      devices.set(deviceKey, {
        deviceConfig,
        byType: new Map(),
        results,
      });
    }
    const deviceGroup = devices.get(deviceKey);
    if (!deviceGroup.byType.has(registerType)) {
      deviceGroup.byType.set(registerType, []);
    }
    deviceGroup.byType.get(registerType).push({ address, length, idx, meta: r?.meta });
  });

  /**
   * 同設備所有 registerType／ranges 串列（避免同閘道並行 FC 互擠逾時）。
   * 跨設備最多 STANDARD_CONCURRENCY 並行。
   */
  await mapWithConcurrency(
    [...devices.values()],
    (deviceGroup) => readDeviceSerial(deviceGroup),
    { concurrency: STANDARD_CONCURRENCY },
  );

  for (let i = 0; i < results.length; i++) {
    if (!results[i]) results[i] = { ok: false, error: "未知錯誤", meta: reqList[i]?.meta };
  }

  return results;
}

module.exports = {
  batchRead,
  writeCoilValues,
  invalidateDeviceCache,
  _internal: {
    normalizeRegisterType,
    coalesceToRanges,
  },
};
