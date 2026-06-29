/**
 * 系統快照監控：通用 online/offline 推送 wrapper
 *
 * 供 drainage/power/fire/emergency_rescue/hvac/air_circulation 等「有 statusService.getStatusSnapshot」的系統共用。
 * - statusService 內部負責：讀取點位、同步連線類警報（syncLocationSnapshotReadResult）
 * - monitor 這層負責：把 online/offline 變化推送到 websocket（monitoring:device:status:batch）
 */

const logger = require("../../utils/logger");
const websocketService = require("../websocket/websocketService");
const monitoringSnapshotCache = require("./monitoringSnapshotCache");
const C = require("../../utils/apiErrorCodes");
const { throwApiError } = require("../../utils/apiErrorMeta");

/**
 * 監控快照 API：`raw` 形狀依設備類型而定。
 * - **running**：聚合警報（任一細項為 true 則 true），供 deriveUiStatus / 前端總覽
 * - **幫浦／ATS／油位／煙霧／空氣循環**：僅 `{ running }`
 * - **液位**：`coverAlarm`、`highLevel`、`lowLevel` + `running`
 * - **發電機**：`fault`、`highOil`、`lowOil` + `running`
 *
 * 注意：快照 raw 語意與 `services/monitoring/systemSnapshotStatusFields.js` 等為「監控快照」領域概念，
 * 併入 monitoring 域（SSOT）。
 */
function truthy(v) {
  return v === true;
}

function snapshotRunningOnly(runningBool) {
  return { running: !!runningBool };
}

function normalizeRunningSnapshotRaw(raw) {
  if (!raw || typeof raw !== "object") return snapshotRunningOnly(false);
  return snapshotRunningOnly(truthy(raw.running));
}

/** 煙霧／緊急求救（statusPoints 僅 `running`） */
function normalizeSmokeEmergencySnapshotRaw(raw) {
  return normalizeRunningSnapshotRaw(raw);
}

/** 排水／消防幫浦（statusPoints 僅 `running`） */
function mergeDrainageFirePumpSnapshotRaw(raw) {
  return normalizeRunningSnapshotRaw(raw);
}

/** 排水／消防液位：三點位 + 聚合 running */
function mergeDrainageFireTankSnapshotRaw(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      running: false,
      coverAlarm: false,
      highLevel: false,
      lowLevel: false,
    };
  }
  const coverAlarm = truthy(raw.coverAlarm);
  const highLevel = truthy(raw.highLevel);
  const lowLevel = truthy(raw.lowLevel);
  const running = coverAlarm || highLevel || lowLevel;
  return { running, coverAlarm, highLevel, lowLevel };
}

/** 電力 ATS（statusPoints 僅 `running`） */
function mergePowerAtsSnapshotRaw(raw) {
  return normalizeRunningSnapshotRaw(raw);
}

/** 電力發電機：fault／高／低油位 + 聚合 running */
function mergePowerGeneratorSnapshotRaw(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      running: false,
      fault: false,
      highOil: false,
      lowOil: false,
    };
  }
  const fault = truthy(raw.fault);
  const highOil = truthy(raw.highOil);
  const lowOil = truthy(raw.lowOil);
  const running = fault || highOil || lowOil;
  return { running, fault, highOil, lowOil };
}

/** 電力獨立油位點（statusPoints 僅 `running`） */
function mergePowerOilLevelSnapshotRaw(raw) {
  return normalizeRunningSnapshotRaw(raw);
}

/** 空氣循環：與煙霧／緊急求救相同，API `raw` 僅 `{ running }`（讀取階段僅認 `running` 鍵） */
function mergeAirCirculationSnapshotRaw(raw) {
  return normalizeSmokeEmergencySnapshotRaw(raw);
}

/**
 * @param {object} options
 * @param {string} options.systemKey - e.g. "drainage" | "power" | "fire" | "emergency_rescue"
 * @param {string} options.loggerName - e.g. "drainageMonitor"
 * @param {() => Promise<{ items?: any[] }>} options.getSnapshot - usually statusService.getStatusSnapshot
 * @param {(item: any) => string|null|undefined} [options.getSystemId] - default: item.systemId
 * @param {(item: any) => number|null|undefined} [options.getDeviceId] - default: null
 * @param {(item: any) => boolean} [options.isOnline] - default: !item.error
 */
function createSystemSnapshotMonitor(options) {
  const {
    systemKey,
    loggerName,
    getSnapshot,
    getSystemId = (item) => item?.systemId,
    getDeviceId = () => null,
    isOnline = (item) => !item?.error,
  } = options || {};

  if (!systemKey) {
    throwApiError(C.MONITOR_FACTORY_CONFIG_INVALID, "systemKey is required");
  }
  if (!loggerName) {
    throwApiError(C.MONITOR_FACTORY_CONFIG_INVALID, "loggerName is required");
  }
  if (typeof getSnapshot !== "function") {
    throwApiError(
      C.MONITOR_FACTORY_CONFIG_INVALID,
      "getSnapshot must be a function",
    );
  }

  const monitorLogger = logger.createLogger(loggerName);
  const lastDeviceStatus = new Map(); // key: `${systemKey}:${sourceId}` -> 'online' | 'offline'

  const check = async () => {
    try {
      const snapshot = await getSnapshot();
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      const fetchedAt = new Date().toISOString();

      const hadPriorSnapshot = monitoringSnapshotCache.hasSnapshot(systemKey);
      const changedItems = monitoringSnapshotCache.diffChangedItems(
        systemKey,
        items,
      );
      monitoringSnapshotCache.setSnapshot(systemKey, { items });

      if (hadPriorSnapshot && changedItems.length > 0) {
        websocketService.emitMonitoringSnapshotUpdated({
          system: systemKey,
          items: changedItems,
          fetchedAt,
        });
      }

      const statusUpdates = [];

      for (const item of items) {
        const systemId = getSystemId(item);
        if (!systemId) continue;

        const currentStatus = isOnline(item) ? "online" : "offline";
        const key = `${systemKey}:${systemId}`;
        const lastStatus = lastDeviceStatus.get(key);

        if (lastStatus !== currentStatus) {
          lastDeviceStatus.set(key, currentStatus);
          statusUpdates.push({
            system: systemKey,
            sourceId: Number(systemId),
            deviceId: getDeviceId(item) ?? null,
            status: currentStatus,
          });
        }
      }

      if (statusUpdates.length > 0) {
        websocketService.emitBatchDeviceStatus(statusUpdates);
      }
    } catch (error) {
      monitorLogger.warn(`${systemKey} 監控執行失敗（不影響其他任務）`, {
        error: error?.message || String(error),
      });
    }
  };

  return { check };
}

module.exports = {
  createSystemSnapshotMonitor,
  normalizeSmokeEmergencySnapshotRaw,
  mergeDrainageFirePumpSnapshotRaw,
  mergeDrainageFireTankSnapshotRaw,
  mergePowerAtsSnapshotRaw,
  mergePowerGeneratorSnapshotRaw,
  mergePowerOilLevelSnapshotRaw,
  mergeAirCirculationSnapshotRaw,
};
