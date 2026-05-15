/**
 * 統一系統警報輔助函數
 * 為所有系統提供統一的警報創建和管理接口
 * 取代多個系統專用的 helper 文件
 */

const alertService = require("./alertService");
const db = require("../../database/db");
const websocketService = require("../websocket/websocketService");
const logger = require("../../utils/logger");
const { getDeviceTypeName } = require("../../constants/deviceTypes");

const helperLogger = logger.createLogger("systemAlertHelper");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

const getErrorTracker = () => require("./errorTracker");

/**
 * 取得指定 source 在一批 source_id 中「仍為 active」的集合
 * - 供各系統 `/status` 快照合併（將 active alerts 映射到快照 item）
 * @param {string} source - alert source（例如 alertService.ALERT_SOURCES.DRAINAGE）
 * @param {Array<string|number>} sourceIds - source_id 列表（location_systems.id）
 * @returns {Promise<Set<string>>} 以字串化 id 表示的 Set
 */
async function loadActiveAlertSystemIdSet(source, sourceIds) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [];
  const normalized = ids
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
  if (!source || normalized.length === 0) return new Set();

  // MySQL/SQLite 皆可：用 IN (?, ?, ...) 動態參數
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = await db.query(
    `
      SELECT DISTINCT source_id
      FROM alerts
      WHERE status = 'active'::alert_status
        AND source = ?
        AND source_id IN (${placeholders})
    `,
    [source, ...normalized],
  );

  const out = new Set();
  for (const r of rows || []) {
    const sid = Number(r?.source_id);
    if (Number.isFinite(sid)) out.add(String(sid));
  }
  return out;
}

function parseAlertRuleConditionConfig(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function normalizePointRegisterType(pointDef) {
  let registerType = String(
    pointDef?.registerType || pointDef?.register_type || pointDef?.type || "",
  )
    .toLowerCase()
    .trim();
  if (registerType === "di") registerType = "discrete";
  if (registerType === "do") registerType = "coil";
  return registerType;
}

function getSemanticsCandidateKeys(alertSource, equipmentKind, statusPoints) {
  const sp =
    statusPoints && typeof statusPoints === "object" ? statusPoints : {};
  const configured = Object.keys(sp).filter(
    (k) => sp[k] && typeof sp[k] === "object",
  );
  const ek = String(equipmentKind || "").trim().toLowerCase();

  let allowed = [];
  if (alertSource === "drainage" || alertSource === "fire") {
    allowed = ek === "tank" ? ["coverAlarm", "highLevel", "lowLevel"] : ["running"];
  } else if (alertSource === "power") {
    if (ek === "oil_level" || ek === "ats") allowed = ["running"];
    else allowed = ["fault", "highOil", "lowOil"];
  } else {
    return [];
  }
  return allowed.filter((k) => configured.includes(k));
}

function matchBitStateRuleToStatusPointKey(
  alertType,
  conditionConfig,
  statusPoints,
  candidateKeys,
) {
  const cc =
    conditionConfig && typeof conditionConfig === "object"
      ? conditionConfig
      : null;
  if (!cc) return null;
  const bk = String(cc.bit_key || "").trim().toLowerCase();
  const m = bk.match(/^(di|do|discrete|coil):(\d+)$/);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const addr = Number(m[2]);
  if (!Number.isFinite(addr)) return null;

  let expectedRt = null;
  if (prefix === "di" || prefix === "discrete") expectedRt = "discrete";
  else if (prefix === "do" || prefix === "coil") expectedRt = "coil";
  else return null;

  const at = String(alertType || "").trim().toLowerCase();
  if (at === "di" && expectedRt !== "discrete") return null;
  if (at === "do" && expectedRt !== "coil") return null;

  for (const key of candidateKeys) {
    const def = statusPoints[key];
    if (!def || typeof def !== "object") continue;
    const rt = normalizePointRegisterType(def);
    if (rt !== expectedRt) continue;
    const a = Number(def.address);
    if (!Number.isFinite(a) || a !== addr) continue;
    return key;
  }
  return null;
}

function buildSemanticsFlagsForLocationSystem(rows, alertSource, equipmentKind, statusPoints) {
  const candidates = getSemanticsCandidateKeys(
    alertSource,
    equipmentKind,
    statusPoints,
  );
  if (candidates.length === 0) return null;

  const flags = {};
  for (const row of rows || []) {
    const ct = String(row.condition_type || "").trim().toLowerCase();
    if (ct !== "bit_state") continue;
    const cc = parseAlertRuleConditionConfig(row.condition_config);
    const key = matchBitStateRuleToStatusPointKey(
      row.alert_type,
      cc,
      statusPoints,
      candidates,
    );
    if (key) flags[key] = true;
  }
  return Object.keys(flags).length > 0 ? flags : null;
}

/**
 * 載入「DI/DO bit_state 規則」作用中的警報，並依 location_system 的 status_points 位址映射成語意鍵
 * @param {string} source - alert source（drainage | fire | power）
 * @param {number[]} sourceIds - location_systems.id
 * @param {Map<string, { equipmentKind: string, statusPoints: object }>} metaBySystemId
 * @returns {Promise<Map<string, Record<string, boolean>>>}
 */
async function loadActiveRuleSemanticsBySystemId(source, sourceIds, metaBySystemId) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [];
  const normalized = ids.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!source || normalized.length === 0) return new Map();
  if (!(metaBySystemId instanceof Map)) return new Map();

  const placeholders = normalized.map(() => "?").join(", ");
  const rows = await db.query(
    `
      SELECT a.source_id,
             a.alert_type::text AS alert_type,
             ar.condition_type,
             ar.condition_config
      FROM alerts a
      INNER JOIN alert_rules ar ON ar.id = a.rule_id
      WHERE a.status = 'active'::alert_status
        AND a.source = ?
        AND a.source_id IN (${placeholders})
        AND ar.condition_type = 'bit_state'
    `,
    [source, ...normalized],
  );

  const bySid = new Map();
  for (const r of rows || []) {
    const sid = String(r.source_id);
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push(r);
  }

  const out = new Map();
  for (const [sid, list] of bySid.entries()) {
    const meta = metaBySystemId.get(sid);
    if (!meta) continue;
    const flags = buildSemanticsFlagsForLocationSystem(
      list,
      source,
      meta.equipmentKind,
      meta.statusPoints || {},
    );
    if (flags) out.set(sid, flags);
  }
  return out;
}

function mergeRuleSemanticsIntoDrainageFireSnapshotItems(items, semanticsBySystemId) {
  const {
    mergeDrainageFireTankSnapshotRaw,
    mergeDrainageFirePumpSnapshotRaw,
  } = require("../monitoring/systemSnapshotMonitorFactory");

  const list = Array.isArray(items) ? items : [];
  if (!(semanticsBySystemId instanceof Map) || semanticsBySystemId.size === 0) {
    return list;
  }

  return list.map((it) => {
    const sid = it?.systemId != null ? String(it.systemId) : "";
    if (!sid) return it;
    const flags = semanticsBySystemId.get(sid);
    if (!flags) return it;

    const prev = it?.raw && typeof it.raw === "object" ? { ...it.raw } : {};
    const runningAlarm = prev.runningAlarm === true;
    const ek = String(it.equipmentKind || "pump").trim().toLowerCase();

    let mergedShape;
    if (ek === "tank") {
      mergedShape = mergeDrainageFireTankSnapshotRaw({
        coverAlarm: !!(prev.coverAlarm || flags.coverAlarm),
        highLevel: !!(prev.highLevel || flags.highLevel),
        lowLevel: !!(prev.lowLevel || flags.lowLevel),
      });
    } else {
      mergedShape = mergeDrainageFirePumpSnapshotRaw({
        running: !!(prev.running || flags.running),
      });
    }

    let nextUi = it.uiStatus;
    if (mergedShape?.running === true) nextUi = "alarm";

    return {
      ...it,
      uiStatus: nextUi,
      raw: {
        ...mergedShape,
        ...(runningAlarm ? { runningAlarm: true } : {}),
      },
    };
  });
}

function mergeRuleSemanticsIntoPowerSnapshotItems(items, semanticsBySystemId) {
  const {
    mergePowerGeneratorSnapshotRaw,
    mergePowerAtsSnapshotRaw,
  } = require("../monitoring/systemSnapshotMonitorFactory");

  const list = Array.isArray(items) ? items : [];
  if (!(semanticsBySystemId instanceof Map) || semanticsBySystemId.size === 0) {
    return list;
  }

  return list.map((it) => {
    const sid = it?.systemId != null ? String(it.systemId) : "";
    if (!sid) return it;
    const flags = semanticsBySystemId.get(sid);
    if (!flags) return it;

    const prev = it?.raw && typeof it.raw === "object" ? { ...it.raw } : {};
    const runningAlarm = prev.runningAlarm === true;
    const ek = String(it.equipmentKind || "generator").trim().toLowerCase();

    let mergedShape;
    if (ek === "oil_level" || ek === "ats") {
      mergedShape = mergePowerAtsSnapshotRaw({
        running: !!(prev.running || flags.running),
      });
    } else {
      mergedShape = mergePowerGeneratorSnapshotRaw({
        fault: !!(prev.fault || flags.fault),
        highOil: !!(prev.highOil || flags.highOil),
        lowOil: !!(prev.lowOil || flags.lowOil),
      });
    }

    let nextUi = it.uiStatus;
    if (mergedShape?.running === true) nextUi = "alarm";

    return {
      ...it,
      uiStatus: nextUi,
      raw: {
        ...mergedShape,
        ...(runningAlarm ? { runningAlarm: true } : {}),
      },
    };
  });
}

/**
 * 將 active alert 集合合併進快照 items
 * - active 的系統：頂層 uiStatus 統一標記為 alarm，並在 raw.runningAlarm=true
 * @template T
 * @param {T[]} items
 * @param {Set<string>|null|undefined} activeAlertSystemIds
 * @returns {T[]}
 */
function mergeActiveAlertsIntoSnapshotItems(items, activeAlertSystemIds) {
  const list = Array.isArray(items) ? items : [];
  const activeSet =
    activeAlertSystemIds instanceof Set ? activeAlertSystemIds : new Set();

  if (list.length === 0) return list;
  if (activeSet.size === 0) return list;

  return list.map((it) => {
    const sid = it?.systemId != null ? String(it.systemId) : "";
    if (!sid || !activeSet.has(sid)) return it;

    const raw = it?.raw && typeof it.raw === "object" ? it.raw : {};
    return {
      ...it,
      uiStatus: "alarm",
      raw: { ...raw, runningAlarm: true },
    };
  });
}

/**
 * 從設備配置中提取設備 ID
 * @param {Object} deviceConfig - 設備配置 { host, port, unitId }
 * @returns {Promise<number|null>} 設備 ID
 */
async function getDeviceIdFromConfig(deviceConfig) {
  try {
    if (
      !deviceConfig ||
      !deviceConfig.host ||
      deviceConfig.port === undefined
    ) {
      return null;
    }

    // 查詢匹配的設備
    const result = await db.query(
      `SELECT d.id
      FROM devices d
      WHERE d.status = 'active'
        AND (
          (d.config::jsonb->>'protocol' = 'modbus'
            AND (d.config::jsonb->>'host')::text = ?
            AND (d.config::jsonb->>'port')::text = ?)
        )
      LIMIT 1`,
      [deviceConfig.host, String(deviceConfig.port)],
    );

    return result && result.length > 0 ? result[0].id : null;
  } catch (error) {
    helperLogger.error("從配置提取設備 ID 失敗", {
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return null;
  }
}

/**
 * 依系統類型獲取地點/區域資訊（共用查詢，減少重複）
 * @param {number} systemId - 地點系統 ID (location_systems.id)
 * @param {string} systemType - 'environment' | 'lighting'
 * @returns {Promise<Object|null>}
 */
async function getSourceInfoByType(systemId, systemType) {
  try {
    const result = await db.query(
      `SELECT ls.id, ls.system_type,
              (ls.system_config->'device_ids'->>0) as device_id,
              l.name, l.zone_id, z.name as zone_name
       FROM location_systems ls
       INNER JOIN locations l ON ls.location_id = l.id
       INNER JOIN zones z ON l.zone_id = z.id
       WHERE ls.id = ? AND ls.system_type = ?`,
      [systemId, systemType],
    );
    return result && result.length > 0 ? result[0] : null;
  } catch (error) {
    helperLogger.error("獲取來源資訊失敗", {
      systemType,
      systemId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return null;
  }
}

const getLocationInfo = (systemId) =>
  getSourceInfoByType(systemId, "environment");
const getAreaInfo = (systemId) => getSourceInfoByType(systemId, "lighting");
const getDrainageInfo = (systemId) => getSourceInfoByType(systemId, "drainage");
const getPowerInfo = (systemId) => getSourceInfoByType(systemId, "power");
const getFireInfo = (systemId) => getSourceInfoByType(systemId, "fire");
const getHvacInfo = (systemId) => getSourceInfoByType(systemId, "hvac");
const getAirCirculationInfo = (systemId) =>
  getSourceInfoByType(systemId, "air_circulation");
const getEmergencyRescueInfo = (systemId) =>
  getSourceInfoByType(systemId, "emergency_rescue");
const getSmokeAlarmInfo = (systemId) =>
  getSourceInfoByType(systemId, "smoke_alarm");

/**
 * 獲取設備資訊
 * @param {number} deviceId - 設備 ID
 * @returns {Promise<Object|null>} 設備資訊
 */
async function getDeviceInfo(deviceId) {
  try {
    const result = await db.query(
      `SELECT d.id, d.name, d.status, d.type_code as device_type_code
      FROM devices d
      WHERE d.id = ?`,
      [deviceId],
    );
    if (!result || result.length === 0) return null;
    const row = result[0];
    return {
      ...row,
      device_type_name: getDeviceTypeName(row.device_type_code),
    };
  } catch (error) {
    helperLogger.error("獲取設備資訊失敗", {
      deviceId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return null;
  }
}

/**
 * 判斷是否為設備連接錯誤
 * @param {string} errorMessage - 錯誤訊息
 * @returns {boolean} 是否為設備連接錯誤
 */
const CONNECTION_ERROR_KEYWORDS = [
  "連接超時",
  "連接被拒絕",
  "無法到達設備",
  "連接已斷開",
  "無法連接",
  "無法讀取",
  "timeout",
  "connection refused",
  "econnrefused",
  "etimedout",
  "設備離線",
  "設備連接失敗",
  "服務不可用",
  "service unavailable",
];

function isDeviceConnectionError(errorMessage) {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return CONNECTION_ERROR_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * 將 location_systems.system_config 正規化為物件（實際綁定以 `device_ids` 為準）
 * @param {unknown} systemConfigRaw - JSON 或字串
 * @returns {Record<string, unknown>}
 */
function parseSystemConfigObject(systemConfigRaw) {
  return typeof systemConfigRaw === "string"
    ? JSON.parse(systemConfigRaw || "{}")
    : systemConfigRaw || {};
}

/** 主設備：`device_ids[0]`（供單一 device 來源對應） */
function parseSingularDeviceIdFromSystemConfig(systemConfigRaw) {
  const c = parseSystemConfigObject(systemConfigRaw);
  const raw =
    Array.isArray(c.device_ids) && c.device_ids.length > 0 ? c.device_ids[0] : null;
  if (raw == null || raw === "") return null;
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) ? null : n;
}

/** `device_ids` 去重；供 clearError 清除所有綁定設備之離線 */
function parseDeviceIdsFromSystemConfig(systemConfigRaw) {
  const config = parseSystemConfigObject(systemConfigRaw);
  const out = new Set();
  const push = (v) => {
    if (v == null || v === "") return;
    const n = parseInt(String(v), 10);
    if (!Number.isNaN(n)) out.add(n);
  };
  if (Array.isArray(config.device_ids)) {
    for (const x of config.device_ids) {
      push(x);
    }
  }
  return [...out];
}

async function fetchLocationSystemConfig(systemId, systemType) {
  const result = await db.query(
    `SELECT system_config FROM location_systems WHERE id = ? AND system_type = ?`,
    [systemId, systemType],
  );
  return result?.length ? result[0].system_config : null;
}

/**
 * 依系統類型從 location_systems 獲取所有綁定設備 ID
 * @param {number} systemId - location_systems.id
 * @param {string} systemType - 'environment' | 'lighting' | ...
 * @returns {Promise<number[]>}
 */
async function getDeviceIdsFromLocationSystem(systemId, systemType) {
  try {
    const raw = await fetchLocationSystemConfig(systemId, systemType);
    if (raw == null) return [];
    return parseDeviceIdsFromSystemConfig(raw);
  } catch (error) {
    helperLogger.error("取得設備 ID 列表失敗", {
      systemType,
      systemId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return [];
  }
}

/**
 * 依系統類型從 location_systems 獲取單一設備 ID（`device_ids[0]`）
 * @param {number} systemId - location_systems.id
 * @param {string} systemType - 'environment' | 'lighting'
 * @returns {Promise<number|null>}
 */
async function getDeviceIdFromLocationSystem(systemId, systemType) {
  try {
    const raw = await fetchLocationSystemConfig(systemId, systemType);
    if (raw == null) return null;
    return parseSingularDeviceIdFromSystemConfig(raw);
  } catch (error) {
    helperLogger.error("取得設備 ID 失敗", {
      systemType,
      systemId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return null;
  }
}

const getDeviceIdFromLocation = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "environment");
const getDeviceIdFromArea = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "lighting");
const getDeviceIdFromDrainage = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "drainage");
const getDeviceIdFromPower = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "power");
const getDeviceIdFromFire = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "fire");
const getDeviceIdFromHvac = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "hvac");
const getDeviceIdFromAirCirculation = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "air_circulation");
const getDeviceIdFromEmergencyRescue = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "emergency_rescue");
const getDeviceIdFromSmokeAlarm = (systemId) =>
  getDeviceIdFromLocationSystem(systemId, "smoke_alarm");

/**
 * 依設備 ID 與系統類型取得所有對應的 location_systems.id
 * 用於恢復時一併清除同一實體設備在其它地點的警報（避免雙重警報只解一筆）
 * @param {number} deviceId - 設備 ID
 * @param {string} systemType - 系統類型 ('environment' | 'lighting' | 'drainage')
 * @returns {Promise<number[]>} location_systems.id 陣列
 */
async function getLocationSystemIdsByDeviceId(deviceId, systemType) {
  try {
    const result = await db.query(
      `SELECT id FROM location_systems
       WHERE system_type = $1
         AND COALESCE(system_config->'device_ids', '[]'::jsonb) @> to_jsonb(ARRAY[$2]::int[])`,
      [systemType, deviceId],
    );
    return (result || []).map((r) => r.id);
  } catch (error) {
    helperLogger.error("依設備取得 location_systems 失敗", {
      deviceId,
      systemType,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return [];
  }
}

/**
 * 系統配置
 */
const SYSTEM_CONFIGS = {
  environment: {
    source: alertService.ALERT_SOURCES.ENVIRONMENT,
    getSourceInfo: getLocationInfo,
    getDeviceId: getDeviceIdFromLocation,
  },
  lighting: {
    source: alertService.ALERT_SOURCES.LIGHTING,
    getSourceInfo: getAreaInfo,
    getDeviceId: getDeviceIdFromArea,
  },
  drainage: {
    source: alertService.ALERT_SOURCES.DRAINAGE,
    getSourceInfo: getDrainageInfo,
    getDeviceId: getDeviceIdFromDrainage,
  },
  power: {
    source: alertService.ALERT_SOURCES.POWER,
    getSourceInfo: getPowerInfo,
    getDeviceId: getDeviceIdFromPower,
  },
  fire: {
    source: alertService.ALERT_SOURCES.FIRE,
    getSourceInfo: getFireInfo,
    getDeviceId: getDeviceIdFromFire,
  },
  hvac: {
    source: alertService.ALERT_SOURCES.HVAC,
    getSourceInfo: getHvacInfo,
    getDeviceId: getDeviceIdFromHvac,
  },
  air_circulation: {
    source: alertService.ALERT_SOURCES.AIR_CIRCULATION,
    getSourceInfo: getAirCirculationInfo,
    getDeviceId: getDeviceIdFromAirCirculation,
  },
  emergency_rescue: {
    source: alertService.ALERT_SOURCES.EMERGENCY_RESCUE,
    getSourceInfo: getEmergencyRescueInfo,
    getDeviceId: getDeviceIdFromEmergencyRescue,
  },
  smoke_alarm: {
    source: alertService.ALERT_SOURCES.SMOKE_ALARM,
    getSourceInfo: getSmokeAlarmInfo,
    getDeviceId: getDeviceIdFromSmokeAlarm,
  },
  device: {
    source: alertService.ALERT_SOURCES.DEVICE,
    getSourceInfo: getDeviceInfo,
    getDeviceId: async (id) => id, // 設備 ID 就是自己
  },
};

/**
 * 記錄系統錯誤
 * @param {string} system - 系統名稱 (environment, lighting, device)
 * @param {number} sourceId - 來源實體 ID
 * @param {string} errorMessage - 錯誤訊息
 * @param {Object} options - 選項
 * @param {boolean} options.skipWebSocket - 是否跳過 WebSocket 推送（用於批次模式）
 * @returns {Promise<boolean>} 是否創建了警報
 */
async function recordError(system, sourceId, errorMessage, options = {}) {
  const detail = await recordErrorDetailed(system, sourceId, errorMessage, options);
  return Boolean(detail?.alertCreated);
}

async function recordErrorDetailed(system, sourceId, errorMessage, options = {}) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throwApiError(C.ALERT_SYSTEM_UNKNOWN, `未知的系統: ${system}`);
    }

    const isConnErr = isDeviceConnectionError(errorMessage);

    // 「停用=全停」：如果能映射到設備且設備非 active，直接跳過（不創建警示、不推送狀態）
    // - 避免停用設備仍持續產生 alerts/WS，造成前端仍收到「設備訊息」
    const mappedDeviceId = await config.getDeviceId(sourceId);
    let mappedDeviceInfo = null;
    if (mappedDeviceId) {
      mappedDeviceInfo = await getDeviceInfo(mappedDeviceId);
      if (mappedDeviceInfo?.status && mappedDeviceInfo.status !== "active") {
        return false;
      }
    }

    if (isConnErr && mappedDeviceId && mappedDeviceInfo) {
      const result = await getErrorTracker().recordErrorDetailed(
        alertService.ALERT_SOURCES.DEVICE,
        mappedDeviceId,
        "offline",
        errorMessage,
        {
          name: mappedDeviceInfo.name,
          origin: options?.origin
            ? { ...options.origin, systemKey: system, sourceId, deviceId: mappedDeviceId }
            : {
                channel: "system_alert_helper",
                systemKey: system,
                sourceId,
                deviceId: mappedDeviceId,
              },
        },
      );

      if (!options.skipWebSocket) {
        websocketService.emitDeviceStatus("device", mappedDeviceId, "offline");
      }

      return { ...result, mappedDeviceId };
    }

    // 系統業務錯誤或找不到設備 → 創建系統警報
    const sourceInfo = await config.getSourceInfo(sourceId);
    if (!sourceInfo) {
      helperLogger.debug("來源 ID 不存在，跳過錯誤記錄", {
        system,
        sourceId,
        module: "systemAlertHelper",
      });
      return false;
    }

    const alertType = isConnErr ? "offline" : "error";

    // 記錄錯誤並創建警報（如果達到閾值）
    const result = await getErrorTracker().recordErrorDetailed(
      config.source,
      sourceId,
      alertType,
      errorMessage,
      {
        name: sourceInfo.name,
        zone_name: sourceInfo.zone_name,
        origin: options?.origin
          ? { ...options.origin, systemKey: system, sourceId, deviceId: mappedDeviceId ?? null }
          : {
              channel: "system_alert_helper",
              systemKey: system,
              sourceId,
              deviceId: mappedDeviceId ?? null,
            },
      },
    );

    // 推送 WebSocket 事件：系統設備離線（僅當創建了 offline 類型的警報時，批次模式可跳過）
    // 注意：設備狀態推送不應綁定「是否達到警報閾值」：
    // - 警報（alert）是「達閾後的 incident」
    // - 設備狀態（status）是「即時連線觀測」
    // 批次模式（skipWebSocket）會由 monitor 在輪次結束後統一用 batch emit 做狀態 diff 推送。
    if (alertType === "offline" && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(
        config.source,
        sourceId,
        "offline",
        mappedDeviceId,
      );
    }

    return { ...result, mappedDeviceId };
  } catch (error) {
    helperLogger.error("記錄錯誤失敗", {
      system,
      sourceId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return { ignored: false, trackingUpdated: false, alertCreated: false, error: error.message };
  }
}

/**
 * Modbus HTTP 成功後：依 host/port 對應設備並清除 device 離線（單一入口）
 * @param {Object} deviceConfig - { host, port, unitId? }
 * @param {Object} [options] - 傳入 clearError（如 skipWebSocket）
 */
async function notifyModbusHttpDeviceRecovered(deviceConfig, options = {}) {
  const deviceId = await getDeviceIdFromConfig(deviceConfig);
  if (!deviceId) return;
  await clearError("device", deviceId, options);
}

/**
 * Modbus HTTP 失敗後：依 host/port 對應設備並累計 device 離線（單一入口；冷卻由呼叫端處理）
 * @returns {Promise<boolean>} 是否觸發 recordError 流程
 */
async function notifyModbusHttpDeviceFailed(
  deviceConfig,
  errorMessage,
  options = {},
) {
  const deviceId = await getDeviceIdFromConfig(deviceConfig);
  if (!deviceId) return false;
  const detail = await recordErrorDetailed("device", deviceId, errorMessage, {
    ...options,
    origin: {
      channel: "modbus_http",
      deviceId,
      host: deviceConfig?.host,
      port: deviceConfig?.port,
      unitId: deviceConfig?.unitId,
    },
  });
  return Boolean(detail?.alertCreated);
}

/** 背景快照／監控用：以 SYSTEM_CONFIGS 推導（單一真相） */
const SNAPSHOT_CONNECTIVITY_SYSTEM_KEYS = new Set(
  Object.keys(SYSTEM_CONFIGS).filter((k) => k !== "device"),
);

/**
 * 背景監控或快照讀取後：統一寫入連線成功（clear）或失敗（record）
 * 預設 `skipWebSocket: true`，由監控輪次結尾批次推送。
 * @param {string} systemKey - environment | lighting | drainage | power | fire | emergency_rescue
 * @param {number} sourceId - location_systems.id（與既有 recordError/clearError 一致）
 * @param {boolean} readOk - Modbus／讀點是否成功
 * @param {string} [errorMessageWhenFail] - 失敗時訊息
 * @param {Object} [options] - 覆寫傳入 recordError／clearError（如 skipWebSocket）
 * @returns {Promise<{changed:boolean, action:"cleared"|"recorded", deviceClearedAny?:boolean, systemClearedAny?:boolean, alertCreated?:boolean, deviceIds?:number[]}>}
 */
async function syncLocationSnapshotReadResult(
  systemKey,
  sourceId,
  readOk,
  errorMessageWhenFail = "無法讀取設備資料",
  options = {},
) {
  if (!SNAPSHOT_CONNECTIVITY_SYSTEM_KEYS.has(systemKey)) {
    throwApiError(
      C.ALERT_SYSTEM_SNAPSHOT_UNSUPPORTED,
      `[systemAlertHelper] syncLocationSnapshotReadResult 不支援: ${systemKey}`,
    );
  }
  const opts = { skipWebSocket: true, ...options };
  if (readOk) {
    const result = await clearErrorDetailed(systemKey, sourceId, opts);
    return {
      changed: Boolean(result.deviceClearedAny || result.systemClearedAny),
      action: "cleared",
      deviceClearedAny: result.deviceClearedAny,
      systemClearedAny: result.systemClearedAny,
      deviceIds: result.deviceIds,
    };
  }
  const detail = await recordErrorDetailed(systemKey, sourceId, errorMessageWhenFail, {
    ...opts,
    origin: {
      channel: "monitor_snapshot",
      systemKey,
      sourceId,
    },
  });
  return {
    // 失敗路徑：若達閾且 incident 建立/更新成功，視為「外部可見狀態」變更
    changed: Boolean(detail?.thresholdReached && detail?.alertCreated),
    action: "recorded",
    alertCreated: Boolean(detail?.alertCreated),
    thresholdReached: Boolean(detail?.thresholdReached),
    errorCount: typeof detail?.errorCount === "number" ? detail.errorCount : undefined,
    threshold: typeof detail?.threshold === "number" ? detail.threshold : undefined,
  };
}

/**
 * 清除系統錯誤狀態
 * @param {string} system - 系統名稱
 * @param {number} sourceId - 來源實體 ID
 * @param {Object} options - 選項
 * @param {boolean} options.skipWebSocket - 是否跳過 WebSocket 推送（用於批次模式）
 * @returns {Promise<void>}
 */
async function clearErrorDetailed(system, sourceId, options = {}) {
  try {
    const config = SYSTEM_CONFIGS[system];
    if (!config) {
      throwApiError(C.ALERT_SYSTEM_UNKNOWN, `未知的系統: ${system}`);
    }

    const deviceIds =
      system === "device"
        ? [sourceId]
        : await getDeviceIdsFromLocationSystem(sourceId, system);

    let deviceClearedAny = false;
    for (const deviceId of deviceIds) {
      const deviceCleared = await getErrorTracker().clearError(
        alertService.ALERT_SOURCES.DEVICE,
        deviceId,
        "offline",
      );
      deviceClearedAny = deviceClearedAny || Boolean(deviceCleared);
      if (deviceCleared && !options.skipWebSocket) {
        websocketService.emitDeviceStatus("device", deviceId, "online");
      }
    }

    const systemCleared = await getErrorTracker().clearError(
      config.source,
      sourceId,
    );

    if (system !== "device" && deviceIds.length > 0) {
      const clearedOtherSystemIds = new Set();
      for (const deviceId of deviceIds) {
        const allSystemIds = await getLocationSystemIdsByDeviceId(
          deviceId,
          system,
        );
        for (const otherId of allSystemIds) {
          if (Number(otherId) === Number(sourceId)) continue;
          const key = String(otherId);
          if (clearedOtherSystemIds.has(key)) continue;
          clearedOtherSystemIds.add(key);
          await getErrorTracker().clearError(config.source, otherId);
        }
      }
    }

    if (systemCleared && !options.skipWebSocket) {
      websocketService.emitDeviceStatus(
        config.source,
        sourceId,
        "online",
        deviceIds[0] ?? null,
      );
    }
    return {
      deviceIds,
      deviceClearedAny,
      systemClearedAny: Boolean(systemCleared),
    };
  } catch (error) {
    helperLogger.error("清除錯誤狀態失敗", {
      system,
      sourceId,
      error: error?.message || String(error),
      module: "systemAlertHelper",
    });
    return { deviceIds: [], deviceClearedAny: false, systemClearedAny: false };
  }
}

async function clearError(system, sourceId, options = {}) {
  await clearErrorDetailed(system, sourceId, options);
}

const manualAlarmDimensionKey = () => "manual_alarm:default";

async function loadLocationSystemScope(systemKey, sourceId) {
  const systemType = String(systemKey || "").trim();
  const sid = Number(sourceId);
  if (!systemType || !Number.isFinite(sid)) return null;
  const rows = await db.query(
    `SELECT ls.id AS system_id, ls.location_id, l.zone_id
     FROM location_systems ls
     JOIN locations l ON l.id = ls.location_id
     WHERE ls.id = ? AND ls.system_type = ?
     LIMIT 1`,
    [sid, systemType],
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    systemId: Number(r.system_id),
    locationId: Number(r.location_id),
    zoneId: Number(r.zone_id),
  };
}

function ruleAppliesToScope(rule, scope) {
  if (!rule || !scope) return false;
  const t = String(rule.target_type ?? "").trim().toLowerCase();
  const tid = rule.target_id != null ? Number(rule.target_id) : null;
  if (!t) return true; // 全域
  if (!Number.isFinite(tid)) return false;
  if (t === "location") return Number(scope.locationId) === tid;
  if (t === "zone") return Number(scope.zoneId) === tid;
  if (t === "system") return Number(scope.systemId) === tid;
  return true;
}

function ruleSpecificityScore(rule) {
  const t = String(rule?.target_type ?? "").trim().toLowerCase();
  if (t === "location") return 3;
  if (t === "zone") return 2;
  if (!t) return 1;
  return 1;
}

function severityRank(sev) {
  const s = String(sev || "").trim().toLowerCase();
  if (s === "critical") return 3;
  if (s === "error") return 2;
  if (s === "warning") return 1;
  return 0;
}

async function recordRuleBitStateAlarm(
  systemKey,
  sourceId,
  { alertType, bitKey, origin } = {},
) {
  const config = SYSTEM_CONFIGS[systemKey];
  if (!config) {
    throwApiError(C.ALERT_SYSTEM_UNKNOWN, `未知的系統: ${systemKey}`);
  }

  const at = String(alertType || "").trim().toLowerCase();
  if (at !== "di" && at !== "do") {
    throwApiError(C.ALERT_RULE_ALERT_TYPE_INVALID, "rule alertType 必須為 di 或 do");
  }
  const bk = String(bitKey || "").trim().toLowerCase();
  if (!/^(di|do|discrete|coil):\d+$/.test(bk)) {
    throwApiError(
      C.ALERT_RULE_BITKEY_INVALID,
      "rule bitKey 格式需為 di:0 / do:3 / discrete:10 / coil:5",
    );
  }

  const scope = await loadLocationSystemScope(systemKey, sourceId);
  if (!scope) {
    throwApiError(C.ALERT_SOURCE_ID_NOT_FOUND, "來源 ID 不存在");
  }

  const alertRuleService = require("./alertRuleService");
  const rules = await alertRuleService.getEnabledDiDoRules();
  const candidates = (rules || []).filter((r) => {
    if (String(r.source) !== String(config.source)) return false;
    if (String(r.alert_type) !== at) return false;
    if (String(r.condition_type) !== "bit_state") return false;
    const rk = String(r.condition_config?.bit_key || "").trim().toLowerCase();
    if (rk !== bk) return false;
    return ruleAppliesToScope(r, scope);
  });

  if (candidates.length === 0) {
    throwApiError(
      C.ALERT_RULE_NOT_AVAILABLE,
      `找不到可用的規則（source=${config.source}, alert_type=${at}, bit_key=${bk}）`,
    );
  }

  // 優先：location > zone > global，再看 severity，最後 id 新者優先
  candidates.sort((a, b) => {
    const sa = ruleSpecificityScore(a);
    const sb = ruleSpecificityScore(b);
    if (sa !== sb) return sb - sa;
    const ra = severityRank(a.severity);
    const rb = severityRank(b.severity);
    if (ra !== rb) return rb - ra;
    return Number(b.id || 0) - Number(a.id || 0);
  });
  const rule = candidates[0];

  const dimensionKey =
    rule.dimension_key ||
    alertRuleService.deriveRuleDimensionKey({
      alert_type: rule.alert_type,
      condition_type: rule.condition_type,
      condition_config: rule.condition_config,
    });

  let message = "";
  try {
    message = await alertRuleService.renderRuleMessage(rule, {
      source_id: Number(scope.systemId),
    });
  } catch (_) {
    // ignore
  }
  if (!message) {
    message = `${config.source}:${scope.systemId} ${at.toUpperCase()} ${bk} 觸發`;
  }

  await alertService.createAlert({
    source: rule.source,
    source_id: Number(scope.systemId),
    alert_type: rule.alert_type,
    severity: rule.severity || alertService.SEVERITIES.WARNING,
    message,
    dimension_key: dimensionKey,
    rule_id: rule.id,
    origin: origin || null,
  });

  return {
    ruleId: rule.id,
    alertType: rule.alert_type,
    dimensionKey,
  };
}

async function clearRuleBitStateAlarm(
  systemKey,
  sourceId,
  { alertType, bitKey, origin } = {},
) {
  const config = SYSTEM_CONFIGS[systemKey];
  if (!config) {
    throwApiError(C.ALERT_SYSTEM_UNKNOWN, `未知的系統: ${systemKey}`);
  }

  const at = String(alertType || "").trim().toLowerCase();
  if (at !== "di" && at !== "do") {
    throwApiError(C.ALERT_RULE_ALERT_TYPE_INVALID, "rule alertType 必須為 di 或 do");
  }
  const bk = String(bitKey || "").trim().toLowerCase();
  if (!/^(di|do|discrete|coil):\d+$/.test(bk)) {
    throwApiError(
      C.ALERT_RULE_BITKEY_INVALID,
      "rule bitKey 格式需為 di:0 / do:3 / discrete:10 / coil:5",
    );
  }

  const scope = await loadLocationSystemScope(systemKey, sourceId);
  if (!scope) {
    throwApiError(C.ALERT_SOURCE_ID_NOT_FOUND, "來源 ID 不存在");
  }

  const alertRuleService = require("./alertRuleService");
  const rules = await alertRuleService.getEnabledDiDoRules();
  const candidates = (rules || []).filter((r) => {
    if (String(r.source) !== String(config.source)) return false;
    if (String(r.alert_type) !== at) return false;
    if (String(r.condition_type) !== "bit_state") return false;
    const rk = String(r.condition_config?.bit_key || "").trim().toLowerCase();
    if (rk !== bk) return false;
    return ruleAppliesToScope(r, scope);
  });

  if (candidates.length === 0) {
    throwApiError(
      C.ALERT_RULE_NOT_AVAILABLE,
      `找不到可用的規則（source=${config.source}, alert_type=${at}, bit_key=${bk}）`,
    );
  }

  candidates.sort((a, b) => {
    const sa = ruleSpecificityScore(a);
    const sb = ruleSpecificityScore(b);
    if (sa !== sb) return sb - sa;
    const ra = severityRank(a.severity);
    const rb = severityRank(b.severity);
    if (ra !== rb) return rb - ra;
    return Number(b.id || 0) - Number(a.id || 0);
  });
  const rule = candidates[0];

  const dimensionKey =
    rule.dimension_key ||
    alertRuleService.deriveRuleDimensionKey({
      alert_type: rule.alert_type,
      condition_type: rule.condition_type,
      condition_config: rule.condition_config,
    });

  try {
    const n = await alertService.resolveAlert(
      Number(scope.systemId),
      rule.alert_type,
      rule.source,
      dimensionKey,
    );
    return { resolved: n, ruleId: rule.id, alertType: rule.alert_type, dimensionKey };
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("未找到可更新的警報")) {
      return { resolved: 0, ruleId: rule.id, alertType: rule.alert_type, dimensionKey };
    }
    helperLogger.warn("規則警報清除失敗", {
      systemKey,
      sourceId: Number(scope.systemId),
      alertType: rule.alert_type,
      dimensionKey,
      origin: origin || null,
      error: msg || String(err),
      module: "systemAlertHelper",
    });
    throw err;
  }
}

/**
 * 手動建立「警報」（直接建立 Incident，跳過 error_count 閾值）
 * - 對齊既有 alerts 表結構：alert_type 使用 ERROR（不新增 enum）
 * - severity 固定 critical（代表警報）
 * - message 盡量沿用規則 message（若存在），否則 fallback 為「<name> 手動觸發警報」
 */
async function recordManualAlarm(systemKey, sourceId, options = {}) {
  const config = SYSTEM_CONFIGS[systemKey];
  if (!config) {
    throwApiError(C.ALERT_SYSTEM_UNKNOWN, `未知的系統: ${systemKey}`);
  }

  const sourceInfo = await config.getSourceInfo(sourceId);
  if (!sourceInfo) {
    throwApiError(C.ALERT_SOURCE_ID_NOT_FOUND, "來源 ID 不存在");
  }

  let message = "";
  try {
    const alertRuleService = require("./alertRuleService");
    const rule = await alertRuleService.getErrorCountRule(
      config.source,
      alertService.ALERT_TYPES.ERROR,
    );
    if (rule) {
      message = await alertRuleService.renderRuleMessage(rule, {
        source_id: sourceId,
        error_count: 1,
      });
    }
  } catch (_) {
    // ignore
  }
  if (!message) {
    message = `${sourceInfo.name} 手動觸發警報`;
  }

  await alertService.createAlert({
    source: config.source,
    source_id: sourceId,
    alert_type: alertService.ALERT_TYPES.ERROR,
    severity: alertService.SEVERITIES.CRITICAL,
    message,
    dimension_key: manualAlarmDimensionKey(),
    origin: options?.origin || null,
  });
}

async function clearManualAlarm(systemKey, sourceId, options = {}) {
  const config = SYSTEM_CONFIGS[systemKey];
  if (!config) {
    throwApiError(C.ALERT_SYSTEM_UNKNOWN, `未知的系統: ${systemKey}`);
  }
  try {
    const n = await alertService.resolveAlert(
      sourceId,
      alertService.ALERT_TYPES.ERROR,
      config.source,
      manualAlarmDimensionKey(),
    );
    return { resolved: n };
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("未找到可更新的警報")) {
      return { resolved: 0 };
    }
    throw err;
  }
}

module.exports = {
  loadActiveAlertSystemIdSet,
  loadActiveRuleSemanticsBySystemId,
  mergeRuleSemanticsIntoDrainageFireSnapshotItems,
  mergeRuleSemanticsIntoPowerSnapshotItems,
  mergeActiveAlertsIntoSnapshotItems,
  recordError,
  clearError,
  recordManualAlarm,
  clearManualAlarm,
  recordRuleBitStateAlarm,
  clearRuleBitStateAlarm,
  getDeviceIdFromConfig,
  notifyModbusHttpDeviceRecovered,
  notifyModbusHttpDeviceFailed,
  syncLocationSnapshotReadResult,
  // 導出輔助函數供內部使用
  getLocationInfo,
  getAreaInfo,
  getDeviceInfo,
  isDeviceConnectionError,
  // 導出系統配置供檢查
  SYSTEM_CONFIGS,
};
