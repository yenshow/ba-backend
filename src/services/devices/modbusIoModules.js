/**
 * Modbus DI/DO 主／副擴充模組（ioModules）SSOT
 * - 同 host／unitId 連續絕對位址（0-based）
 * - 無 ioModules → 隱式 master 0–15
 */

const DEFAULT_MODULE_WIDTH = 16;
const IMPLICIT_MASTER = Object.freeze({
  role: "master",
  moduleId: 0,
  addressStart: 0,
  addressEnd: DEFAULT_MODULE_WIDTH - 1,
});

/**
 * @param {unknown} raw
 * @returns {{ role: "master"|"slave", moduleId: number, serial?: string, addressStart: number, addressEnd: number } | null}
 */
function normalizeOneModule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const roleRaw = String(raw.role || "").toLowerCase().trim();
  const role = roleRaw === "slave" ? "slave" : roleRaw === "master" ? "master" : null;
  if (!role) return null;

  const moduleId = Number(raw.moduleId);
  if (!Number.isInteger(moduleId) || moduleId < 0) return null;
  if (role === "master" && moduleId !== 0) return null;
  if (role === "slave" && moduleId < 1) return null;

  const addressStart = Number(raw.addressStart);
  const addressEnd = Number(raw.addressEnd);
  if (!Number.isInteger(addressStart) || !Number.isInteger(addressEnd)) return null;
  if (addressStart < 0 || addressEnd < addressStart) return null;

  const serial =
    raw.serial != null && String(raw.serial).trim() !== ""
      ? String(raw.serial).trim()
      : undefined;

  return { role, moduleId, serial, addressStart, addressEnd };
}

/**
 * @param {unknown} config
 * @returns {{ role: "master"|"slave", moduleId: number, serial?: string, addressStart: number, addressEnd: number }[]}
 */
function resolveIoModules(config) {
  const cfg = config && typeof config === "object" ? config : {};
  const list = Array.isArray(cfg.ioModules) ? cfg.ioModules : null;
  if (!list || list.length === 0) {
    return [{ ...IMPLICIT_MASTER }];
  }
  const out = [];
  for (const item of list) {
    const m = normalizeOneModule(item);
    if (m) out.push(m);
  }
  return out.length > 0 ? out : [{ ...IMPLICIT_MASTER }];
}

/**
 * 驗證並正規化 ioModules（寫入 devices.config 用）
 * @param {object} config
 * @param {(msg: string) => never} [onInvalid]
 * @returns {object} config（已寫回正規化 ioModules，或未帶則不動）
 */
function validateAndNormalizeIoModules(config, onInvalid) {
  const fail =
    typeof onInvalid === "function"
      ? onInvalid
      : (msg) => {
          const err = new Error(msg);
          err.code = "DEVICE_CONFIG_INVALID";
          throw err;
        };

  if (!config || typeof config !== "object") return config;
  if (config.protocol === "hcnet_sdk") {
    delete config.ioModules;
    return config;
  }
  if (config.ioModules === undefined || config.ioModules === null) {
    return config;
  }
  if (!Array.isArray(config.ioModules)) {
    fail("ioModules 必須為陣列");
  }
  if (config.ioModules.length === 0) {
    delete config.ioModules;
    return config;
  }

  const normalized = [];
  const seenIds = new Set();
  let masterCount = 0;

  for (const raw of config.ioModules) {
    const m = normalizeOneModule(raw);
    if (!m) {
      fail(
        "ioModules 項目須含 role(master|slave)、moduleId（master=0／slave≥1）、addressStart／addressEnd（0-based，start≤end）",
      );
    }
    if (seenIds.has(m.moduleId)) {
      fail(`ioModules moduleId 重複：${m.moduleId}`);
    }
    seenIds.add(m.moduleId);
    if (m.role === "master") masterCount += 1;
    normalized.push(m);
  }

  if (masterCount !== 1) {
    fail("ioModules 須恰好一個 role=master（moduleId=0）");
  }

  const sorted = [...normalized].sort((a, b) => a.addressStart - b.addressStart);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.addressStart <= prev.addressEnd) {
      fail(
        `ioModules 位址區間重疊：module ${prev.moduleId} [${prev.addressStart}-${prev.addressEnd}] 與 module ${cur.moduleId} [${cur.addressStart}-${cur.addressEnd}]`,
      );
    }
  }

  config.ioModules = normalized.map((m) => {
    const row = {
      role: m.role,
      moduleId: m.moduleId,
      addressStart: m.addressStart,
      addressEnd: m.addressEnd,
    };
    if (m.serial) row.serial = m.serial;
    return row;
  });
  return config;
}

/**
 * @param {{ addressStart: number, addressEnd: number }[]} modules
 * @param {number} address
 */
function findModuleForAddress(modules, address) {
  const addr = Number(address);
  if (!Number.isInteger(addr) || addr < 0) return null;
  const list = Array.isArray(modules) ? modules : [];
  for (const m of list) {
    if (addr >= m.addressStart && addr <= m.addressEnd) return m;
  }
  return null;
}

/**
 * 若設備有明確 ioModules（非僅隱式），檢查 address 是否落在區間
 * @param {object|null|undefined} deviceConfig
 * @param {number} address
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function assertAddressInIoModules(deviceConfig, address) {
  const cfg = deviceConfig && typeof deviceConfig === "object" ? deviceConfig : {};
  const hasExplicit =
    Array.isArray(cfg.ioModules) && cfg.ioModules.length > 0;
  if (!hasExplicit) return { ok: true };

  const modules = resolveIoModules(cfg);
  const addr = Number(address);
  if (!Number.isInteger(addr) || addr < 0) {
    return { ok: false, message: "Modbus address 須為非負整數（0-based）" };
  }
  if (!findModuleForAddress(modules, addr)) {
    const ranges = modules
      .map((m) => `${m.moduleId}:[${m.addressStart}-${m.addressEnd}]`)
      .join(", ");
    return {
      ok: false,
      message: `位址 ${addr} 不在控制器 ioModules 區間內（${ranges}）`,
    };
  }
  return { ok: true };
}

module.exports = {
  DEFAULT_MODULE_WIDTH,
  IMPLICIT_MASTER,
  normalizeOneModule,
  resolveIoModules,
  validateAndNormalizeIoModules,
  findModuleForAddress,
  assertAddressInIoModules,
};
