const db = require("../../database/db");
const { parseConfig } = require("../../utils/deviceHelpers");
const { createIsapiClient } = require("../accessControl/isapiClient");
const C = require("../../utils/apiErrorCodes");
const { createApiError } = require("../../utils/apiErrors");

function hasIsapiCredentials(config) {
  const cfg = parseConfig(config) || {};
  return Boolean(cfg.host && cfg.username && cfg.password);
}

function resolveIsapiClientFromConfig(config, label = "設備") {
  const cfg = parseConfig(config) || {};
  if (!hasIsapiCredentials(cfg)) {
    throw createApiError(
      C.ACCESS_CONTROL_CONFIG_INCOMPLETE,
      `${label}連線設定不完整（缺少 host / username / password）`,
    );
  }
  return {
    config: cfg,
    client: createIsapiClient(cfg),
  };
}

function resolveIsapiClientFromDeviceRow(row, label = "設備") {
  const deviceId = Number(row?.id);
  const cfg = parseConfig(row?.config) || {};
  const { client } = resolveIsapiClientFromConfig(cfg, label);
  return {
    deviceId,
    device: {
      id: deviceId,
      name: row?.name,
      type_code: row?.type_code,
      config: cfg,
    },
    client,
  };
}

async function listIsapiCapableDevices() {
  const rows = await db.query(
    `
      SELECT d.id, d.name, d.type_code, d.config
      FROM devices d
      WHERE (
        d.type_code = 'access_control'
        OR d.type_code = 'camera'
      )
      ORDER BY d.id ASC
    `,
  );
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    hasIsapiCredentials(row?.config),
  );
}

module.exports = {
  hasIsapiCredentials,
  resolveIsapiClientFromConfig,
  resolveIsapiClientFromDeviceRow,
  listIsapiCapableDevices,
};
