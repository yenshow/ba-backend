/**
 * 泛用 DI/DO 警報監控
 *
 * 定期掃描所有啟用的 DI/DO 規則（`alert_type IN ('di','do')`），
 * 依規則的 target 解析對應的 location_systems → device → Modbus 暫存器，
 * 讀取位元值後觸發或解除警報。
 *
 * 本模組為 DI/DO（bit_state）單一路徑：以規格化 `di|do|discrete|coil:<addr>` 讀 Modbus，
 * 不依賴各系統自訂 statusPoints。語意請由 alert_rules 的訊息模板／名稱補足。
 */

const logger = require("../../utils/logger");
const db = require("../../database/db");
const alertService = require("../alerts/alertService");
const alertRuleService = require("../alerts/alertRuleService");
const modbusBatchService = require("../devices/modbusBatchService");
const systemAlertHelper = require("../alerts/systemAlertHelper");

const getDeviceService = () => require("../devices/deviceService");

const SOURCE_TO_SYSTEM_TYPE = {
  environment: "environment",
  lighting: "lighting",
  drainage: "drainage",
  power: "power",
  fire: "fire",
  emergency_rescue: "emergency_rescue",
  air_circulation: "air_circulation",
  smoke_alarm: "smoke_alarm",
};

/**
 * 解析 bit_key 為 registerType + address
 * @param {string} bitKey - e.g. "di:0", "do:3"
 * @returns {{ registerType: string, address: number } | null}
 */
function parseBitKey(bitKey) {
  const m = String(bitKey || "").match(/^(di|do|discrete|coil):(\d+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const registerType =
    kind === "di" || kind === "discrete" ? "discrete" : "coil";
  return {
    registerType,
    address: Number(m[2]),
  };
}

/**
 * 從 devices 表解析 Modbus 連線資訊
 * @param {number} deviceId
 * @returns {Promise<{ host: string, port: number, unitId: number } | null>}
 */
const deviceCfgCache = new Map();
const DEVICE_CFG_TTL_MS = 60_000;

async function resolveDeviceConfig(deviceId) {
  if (!deviceId) return null;
  const cached = deviceCfgCache.get(deviceId);
  if (cached && Date.now() - cached.ts < DEVICE_CFG_TTL_MS) return cached.cfg;
  try {
    const { device } = await getDeviceService().getDeviceById(Number(deviceId));
    const c = device?.config || {};
    if (!c.host || c.port == null) return null;
    const cfg = {
      host: c.host,
      port: Number(c.port),
      unitId: Number(c.unitId ?? 1),
    };
    deviceCfgCache.set(deviceId, { cfg, ts: Date.now() });
    return cfg;
  } catch {
    return null;
  }
}

/**
 * 查詢符合規則 target 範圍的 location_systems 並取得 deviceId
 * @param {Object} rule
 * @returns {Promise<Array<{ systemId: number, deviceId: number | null }>>}
 */
async function resolveTargetSystems(rule) {
  const systemType = SOURCE_TO_SYSTEM_TYPE[rule.source];
  if (!systemType) return [];

  let whereClause;
  const params = [systemType];

  if (rule.target_type === "location" && rule.target_id != null) {
    whereClause = "AND ls.location_id = ?";
    params.push(rule.target_id);
  } else if (rule.target_type === "zone" && rule.target_id != null) {
    whereClause = "AND l.zone_id = ?";
    params.push(rule.target_id);
  } else {
    whereClause = "";
  }

  const rows = await db.query(
    `SELECT ls.id AS system_id,
            (ls.system_config->'device_ids'->>0)::integer AS device_id
     FROM location_systems ls
     JOIN locations l ON l.id = ls.location_id
     WHERE ls.system_type = ? ${whereClause}
       AND jsonb_array_length(COALESCE(ls.system_config->'device_ids', '[]'::jsonb)) > 0`,
    params,
  );

  return (rows || []).map((r) => ({
    systemId: r.system_id,
    deviceId: r.device_id,
  }));
}

/**
 * 單條規則 × 單個 location_system：觸發或解除警報
 */
async function syncDiDoAlert(rule, systemId, bitValue) {
  const dimensionKey =
    rule.dimension_key ||
    alertRuleService.deriveRuleDimensionKey({
      alert_type: rule.alert_type,
      condition_type: rule.condition_type,
      condition_config: rule.condition_config,
    });

  if (bitValue === true) {
    const severity = rule.severity || alertService.SEVERITIES.WARNING;
    let message = "";
    try {
      message = await alertRuleService.renderRuleMessage(rule, {
        source_id: systemId,
      });
    } catch {
      /* 渲染失敗不中斷 */
    }
    if (!message) {
      const parsed = parseBitKey(rule.condition_config?.bit_key);
      message = `${rule.alert_type.toUpperCase()} 位址 ${parsed?.address ?? "?"} 觸發`;
    }

    await alertService.createAlert({
      source: rule.source,
      source_id: Number(systemId),
      alert_type: rule.alert_type,
      dimension_key: dimensionKey,
      severity,
      message,
      rule_id: rule.id,
    });
    return;
  }

  try {
    await alertService.resolveAlert(
      Number(systemId),
      rule.alert_type,
      rule.source,
      dimensionKey,
    );
  } catch (err) {
    if (!String(err?.message || "").includes("未找到可更新的警報")) throw err;
  }
}

/**
 * 主監控函式：掃描所有啟用 DI/DO 規則，讀取 Modbus，觸發/解除警報
 */
async function checkDiDoAlerts() {
  const monitorLogger = logger.createLogger("diDoMonitor");
  try {
    const rules = await alertRuleService.getEnabledDiDoRules();
    if (!rules || rules.length === 0) return;

    // 對每條規則展開 target → location_systems，組成 { rule, systemId, deviceId, parsed }
    const tasks = [];
    for (const rule of rules) {
      const parsed = parseBitKey(rule.condition_config?.bit_key);
      if (!parsed) continue;

      const systems = await resolveTargetSystems(rule);
      for (const sys of systems) {
        if (!sys.deviceId) continue;
        tasks.push({
          rule,
          systemId: sys.systemId,
          deviceId: sys.deviceId,
          parsed,
        });
      }
    }

    if (tasks.length === 0) return;

    // 依 device + registerType + address 去重，同一暫存器只讀一次
    const readKeyMap = new Map();
    for (const t of tasks) {
      const key = `${t.deviceId}:${t.parsed.registerType}:${t.parsed.address}`;
      if (!readKeyMap.has(key)) {
        readKeyMap.set(key, {
          deviceId: t.deviceId,
          parsed: t.parsed,
          tasks: [],
        });
      }
      readKeyMap.get(key).tasks.push(t);
    }

    const readEntries = [...readKeyMap.values()];
    const batchRequests = [];
    const validEntries = [];

    for (const entry of readEntries) {
      const cfg = await resolveDeviceConfig(entry.deviceId);
      if (!cfg) continue;
      batchRequests.push({
        host: cfg.host,
        port: cfg.port,
        unitId: cfg.unitId,
        registerType: entry.parsed.registerType,
        address: entry.parsed.address,
        length: 1,
      });
      validEntries.push(entry);
    }

    if (batchRequests.length === 0) return;

    const results = await modbusBatchService.batchRead(batchRequests);

    // 依「設備（host:port:unitId）」彙整本輪讀取的成敗，統一同步 device offline tracking
    // - 背景讀 DI/DO 走 modbusBatchService（非 HTTP 路由），原本不會觸發 notifyModbusHttpDevice*
    //   導致 DI/DO 控制器恢復連線時，沒有任何路徑會清除「連續 N 次無法連接」警報
    const deviceOutcome = new Map(); // deviceKey -> { config, anyOk, errorMessage }
    for (let i = 0; i < validEntries.length; i++) {
      const entry = validEntries[i];
      const req = batchRequests[i];
      const result = results[i];
      const deviceCfg = { host: req.host, port: req.port, unitId: req.unitId };
      const deviceKey = `${req.host}:${req.port}:${req.unitId}`;
      const bucket = deviceOutcome.get(deviceKey) || {
        config: deviceCfg,
        anyOk: false,
        errorMessage: null,
      };
      if (result?.ok) {
        bucket.anyOk = true;
      } else if (!bucket.errorMessage) {
        bucket.errorMessage = result?.error || "無法連接 DI/DO 控制器";
      }
      deviceOutcome.set(deviceKey, bucket);

      if (!result?.ok) continue;
      const bitValue = Boolean(result.data?.[0]);

      for (const task of entry.tasks) {
        try {
          await syncDiDoAlert(task.rule, task.systemId, bitValue);
        } catch (err) {
          monitorLogger.warn(
            `DI/DO 警報同步失敗 (rule=${task.rule.id}, system=${task.systemId})`,
            { error: err?.message || String(err) },
          );
        }
      }
    }

    // 以「整台控制器至少一條讀取成功」判斷為連線 OK；全失敗才累計 offline
    await Promise.allSettled(
      [...deviceOutcome.values()].map(
        async ({ config, anyOk, errorMessage }) => {
          try {
            if (anyOk) {
              await systemAlertHelper.notifyModbusHttpDeviceRecovered(config, {
                skipWebSocket: true,
              });
            } else {
              await systemAlertHelper.notifyModbusHttpDeviceFailed(
                config,
                errorMessage || "無法連接 DI/DO 控制器",
                { skipWebSocket: true },
              );
            }
          } catch (err) {
            monitorLogger.warn("DI/DO 控制器連線狀態同步失敗", {
              host: config?.host,
              port: config?.port,
              unitId: config?.unitId,
              error: err?.message || String(err),
            });
          }
        },
      ),
    );
  } catch (error) {
    monitorLogger.warn("DI/DO 監控執行失敗（不影響其他任務）", {
      error: error?.message || String(error),
    });
  }
}

const DI_DO_ALERT_FEATURE_KEYS = [
  ...new Set(Object.values(SOURCE_TO_SYSTEM_TYPE)),
];

module.exports = {
  checkDiDoAlerts,
  DI_DO_ALERT_FEATURE_KEYS,
};
