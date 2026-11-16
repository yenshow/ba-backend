/**
 * Modbus DI/DO PollPlanner
 * - 依 controller ioModules 區間讀 coil／discrete
 * - 寫入 BitStore；模組失敗 → 該模組 offline
 */

const db = require("../../database/db");
const logger = require("../../utils/logger");
const modbusBatchService = require("./modbusBatchService");
const bitStore = require("./modbusBitStore");
const { resolveIoModules } = require("./modbusIoModules");
const { parseConfig, isHcnetSdkController } = require("../../utils/deviceHelpers");
const { sqlAndEnabled } = require("./deviceEnabledFilter");
const websocketService = require("../websocket/websocketService");
const systemAlertHelper = require("../alerts/systemAlertHelper");

const plannerLogger = logger.createLogger("modbusPollPlanner");

const MAX_RANGE = 125;

/** deviceId -> 上次推播簽章（含 online + 各模組 status） */
const lastBroadcastSig = new Map();

function moduleSignature(modules, online) {
  const parts = (modules || []).map((m) => `${m.moduleId}:${m.status}`);
  return `${online ? 1 : 0}|${parts.join(",")}`;
}

/**
 * @param {{ addressStart: number, addressEnd: number }} mod
 * @returns {{ start: number, length: number }[]}
 */
function splitModuleRanges(mod) {
  const start = Number(mod.addressStart);
  const end = Number(mod.addressEnd);
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const length = Math.min(MAX_RANGE, end - cursor + 1);
    chunks.push({ start: cursor, length });
    cursor += length;
  }
  return chunks;
}

/**
 * 載入啟用中的 Modbus DI/DO controllers
 */
async function loadModbusControllers() {
  const rows = await db.query(
    `
    SELECT d.id, d.config, d.model_id, dm.config AS model_config
    FROM devices d
    LEFT JOIN device_models dm ON dm.id = d.model_id
    WHERE d.type_code = 'controller'
      ${sqlAndEnabled("d.enabled")}
    `,
  );

  const out = [];
  for (const row of rows || []) {
    const cfg = parseConfig(row.config) || {};
    const modelCfg = parseConfig(row.model_config) || {};
    if (isHcnetSdkController(cfg, modelCfg)) continue;
    const host = String(cfg.host || "").trim();
    const port = Number(cfg.port ?? 502);
    const unitId = Number(cfg.unitId ?? 1);
    if (!host || !Number.isFinite(port) || !Number.isFinite(unitId)) continue;
    out.push({
      deviceId: Number(row.id),
      deviceConfig: { host, port, unitId },
      modules: resolveIoModules(cfg),
    });
  }
  return out;
}

/**
 * @param {object} args
 * @param {Set<"coil"|"discrete">} [args.registerTypes]
 * @param {boolean} [args.broadcastStatus]
 */
async function pollControllers({
  registerTypes = null,
  broadcastStatus = true,
} = {}) {
  const types =
    registerTypes instanceof Set && registerTypes.size > 0
      ? [...registerTypes]
      : ["coil", "discrete"];

  const controllers = await loadModbusControllers();
  bitStore.markPlannerCovered(controllers.map((c) => c.deviceId));

  if (controllers.length === 0) return { controllerCount: 0 };

  const statusUpdates = [];

  await Promise.allSettled(
    controllers.map(async (ctrl) => {
      const { deviceId, deviceConfig, modules } = ctrl;

      /** @type {Array<{ moduleId: number, registerType: string, start: number, length: number, reqIndex: number }>} */
      const plan = [];
      const requests = [];

      for (const mod of modules) {
        for (const registerType of types) {
          for (const chunk of splitModuleRanges(mod)) {
            plan.push({
              moduleId: mod.moduleId,
              registerType,
              start: chunk.start,
              length: chunk.length,
              reqIndex: requests.length,
            });
            requests.push({
              host: deviceConfig.host,
              port: deviceConfig.port,
              unitId: deviceConfig.unitId,
              registerType,
              address: chunk.start,
              length: chunk.length,
              meta: { noCache: true, moduleId: mod.moduleId },
            });
          }
        }
      }

      const results =
        requests.length > 0
          ? await modbusBatchService.batchRead(requests)
          : [];
      const readAt = Date.now();

      /** moduleId -> { ok: boolean, lastError: string|null } */
      const moduleOutcome = new Map();
      for (const mod of modules) {
        moduleOutcome.set(mod.moduleId, { ok: true, lastError: null });
      }

      for (const item of plan) {
        const result = results[item.reqIndex];
        const outcome = moduleOutcome.get(item.moduleId);
        if (!result?.ok) {
          if (outcome) {
            outcome.ok = false;
            if (!outcome.lastError) {
              outcome.lastError = result?.error || "模組讀取失敗";
            }
          }
          for (let i = 0; i < item.length; i++) {
            bitStore.setBit(
              deviceConfig,
              item.registerType,
              item.start + i,
              false,
              { ok: false, readAt },
            );
          }
          continue;
        }
        const data = Array.isArray(result.data) ? result.data : [];
        for (let i = 0; i < item.length; i++) {
          bitStore.setBit(
            deviceConfig,
            item.registerType,
            item.start + i,
            Boolean(data[i]),
            { ok: true, readAt },
          );
        }
      }

      const moduleResults = modules.map((mod) => {
        const outcome = moduleOutcome.get(mod.moduleId) || {
          ok: false,
          lastError: "模組讀取失敗",
        };
        const health = {
          moduleId: mod.moduleId,
          role: mod.role,
          addressStart: mod.addressStart,
          addressEnd: mod.addressEnd,
          serial: mod.serial,
          status: outcome.ok ? "online" : "offline",
          lastError: outcome.lastError,
          checkedAt: readAt,
        };
        bitStore.setModuleHealth(deviceConfig, health);
        return health;
      });

      const online = moduleResults.some((m) => m.status === "online");
      const publicModules = bitStore.toPublicModules(moduleResults);
      bitStore.setDeviceReachability(deviceId, {
        online,
        modules: publicModules,
        checkedAt: readAt,
      });

      const sig = moduleSignature(publicModules, online);
      const changed = lastBroadcastSig.get(deviceId) !== sig;
      if (!changed) return;

      lastBroadcastSig.set(deviceId, sig);

      try {
        if (online) {
          await systemAlertHelper.notifyModbusHttpDeviceRecovered(deviceConfig, {
            skipWebSocket: true,
          });
        } else {
          await systemAlertHelper.notifyModbusHttpDeviceFailed(
            deviceConfig,
            moduleResults.find((m) => m.lastError)?.lastError ||
              "無法連接 DI/DO 控制器",
            { skipWebSocket: true },
          );
        }
      } catch (err) {
        plannerLogger.warn("DI/DO 控制器連線警報同步失敗", {
          deviceId,
          error: err?.message || String(err),
        });
      }

      if (broadcastStatus) {
        statusUpdates.push({
          system: "device",
          sourceId: deviceId,
          deviceId,
          status: online ? "online" : "offline",
          modules: publicModules,
        });
      }
    }),
  );

  if (broadcastStatus && statusUpdates.length > 0) {
    try {
      websocketService.emitBatchDeviceStatus(statusUpdates);
    } catch (err) {
      plannerLogger.warn("推播 DI/DO 裝置狀態失敗", {
        error: err?.message || String(err),
      });
    }
  }

  return { controllerCount: controllers.length };
}

module.exports = {
  pollControllers,
  loadModbusControllers,
  splitModuleRanges,
};
