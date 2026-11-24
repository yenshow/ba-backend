const modbusClient = require("./modbusClient");
const { STANDARD_CONCURRENCY } = require("./modbusGlobalLimiter");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrors");
const { mapWithConcurrency } = require("../../utils/mapWithConcurrency");

/**
 * 批次 Modbus 讀取服務
 * - 目標：把「多次讀單點」合併為「一次讀一段範圍」
 * - 提供 TTL snapshot cache 與 inflight coalescing，讓 UI 與背景監控共用
 *
 * 注意：
 * - 目前依照 modbusRoutes 的限制，單次讀取 length 上限為 125
 * - 合併策略預設以「連續 address」為主（MAX_GAP=0）
 */

const MAX_LENGTH = 125;
const MAX_GAP = 0;
const { MODBUS_BATCH_CACHE_TTL_MS: CACHE_TTL } = require("../../config/realtimeTiming");

const cache = new Map(); // key -> { cached, latestRead, sharedRead }

const normalizeRegisterType = (raw) => {
  const t = String(raw || "").trim().toLowerCase();
  if (t === "di") return "discrete";
  if (t === "do") return "coil";
  if (t === "coil" || t === "discrete" || t === "holding" || t === "input") return t;
  return null;
};

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

    // 合併策略：允許小 gap（預設 0=僅連續）
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
 * 批次讀取
 * @param {Array<{host:string,port:number,unitId:number,registerType:string,address:number,length?:number,meta?:any}>} requests
 * @returns {Promise<Array<{ok:true,data:any[],device:any,registerType:string,address:number,length:number,meta?:any} | {ok:false,error:string,meta?:any}>>}
 */
async function batchRead(requests) {
  const reqList = Array.isArray(requests) ? requests : [];
  const results = new Array(reqList.length);

  const groups = new Map(); // key -> { deviceConfig, registerType, points: [{address,length,idx,meta}] }

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
    const groupKey = `${deviceKey}|${registerType}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { deviceConfig, registerType, points: [] });
    }
    groups.get(groupKey).points.push({ address, length, idx, meta: r?.meta });
  });

  /**
   * 同一 device+registerType 的 ranges 必須串列讀取。
   * 多電表／閘道並行 FC03 易逾時（A21：電能 0x1400、需量 0x3006 常被擠掉）。
   * 不同 device 群組仍可並行。
   */
  await mapWithConcurrency(
    [...groups.values()],
    async (g) => {
      const deviceKey = buildDeviceKey(g.deviceConfig);
      const ranges = coalesceToRanges(g.points);

      for (const range of ranges) {
        const cacheKey = buildCacheKey(deviceKey, g.registerType, range.start, range.length);

        try {
          const data = await readRange(
            cacheKey,
            () => readByType(g.registerType, range.start, range.length, g.deviceConfig),
            range.members.some((member) => member.meta?.noCache === true),
          );
          range.members.forEach((m) => {
            results[m.idx] = {
              ok: true,
              data: data.slice(m.offset, m.offset + m.length),
              device: g.deviceConfig,
              registerType: g.registerType,
              address: m.address,
              length: m.length,
              meta: m.meta,
            };
          });
        } catch (e) {
          const msg = e?.message || String(e);
          range.members.forEach((m) => {
            results[m.idx] = { ok: false, error: msg, meta: m.meta };
          });
        }
      }
    },
    { concurrency: STANDARD_CONCURRENCY },
  );

  // 填補任何未寫入的結果（理論上不會發生）
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) results[i] = { ok: false, error: "未知錯誤", meta: reqList[i]?.meta };
  }

  return results;
}

module.exports = {
  batchRead,
  invalidateDeviceCache,
  _internal: {
    normalizeRegisterType,
    coalesceToRanges,
  },
};

