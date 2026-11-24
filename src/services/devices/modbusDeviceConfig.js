const db = require("../../database/db");
const { parseConfig } = require("../../utils/deviceHelpers");
const { sqlAndEnabled } = require("./deviceEnabledFilter");

function normalizeModbusEndpoint(config, { defaultPort } = {}) {
  const host = typeof config?.host === "string" ? config.host.trim() : "";
  const port = Number(config?.port ?? defaultPort);
  const unitId = Number(config?.unitId ?? 1);
  if (
    !host ||
    !Number.isInteger(port) || port < 1 || port > 65535 ||
    !Number.isInteger(unitId) || unitId < 0 || unitId > 255
  ) return null;
  return { host, port, unitId };
}

const pendingLookups = new Map();

async function resolveModbusDeviceConfig(deviceId, inlineConfig) {
  const id = Number(deviceId);
  if (!Number.isSafeInteger(id) || id <= 0) return normalizeModbusEndpoint(inlineConfig);

  // 共用執行中的查詢，查完即移除，下一次控制會讀到最新的設備設定。
  if (!pendingLookups.has(id)) {
    const lookup = db.query(
      `SELECT config FROM active_devices WHERE id = ?${sqlAndEnabled()}`,
      [id],
    ).finally(() => pendingLookups.delete(id));
    pendingLookups.set(id, lookup);
  }
  const [device] = await pendingLookups.get(id);
  if (!device) return null;
  return normalizeModbusEndpoint(parseConfig(device.config)) ??
    normalizeModbusEndpoint(inlineConfig);
}

module.exports = { normalizeModbusEndpoint, resolveModbusDeviceConfig };
